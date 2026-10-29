package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct{ db *pgxpool.Pool }
type handler func(http.ResponseWriter, *http.Request) error

func New(db *pgxpool.Pool) http.Handler {
	s := &Server{db: db}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.wrap(s.health))
	mux.HandleFunc("GET /api/products", s.wrap(s.listProducts))
	mux.HandleFunc("POST /api/products", s.wrap(s.createProduct))
	mux.HandleFunc("PUT /api/products/{id}", s.wrap(s.updateProduct))
	mux.HandleFunc("DELETE /api/products/{id}", s.wrap(s.deleteProduct))
	mux.HandleFunc("POST /api/products/{id}/stock", s.wrap(s.adjustStock))
	mux.HandleFunc("GET /api/products/{id}/movements", s.wrap(s.movements))
	mux.HandleFunc("GET /api/summary", s.wrap(s.summary))
	mux.HandleFunc("GET /api/orders", s.wrap(s.listOrders))
	mux.HandleFunc("POST /api/orders", s.wrap(s.createOrder))
	mux.HandleFunc("GET /api/orders/{id}", s.wrap(s.getOrder))
	mux.HandleFunc("POST /api/orders/{id}/cancel", s.wrap(s.cancelOrder))
	mux.HandleFunc("/", s.wrap(func(w http.ResponseWriter, r *http.Request) error {
		return problem(404, "NOT_FOUND", "Endpoint not found")
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		defer func() {
			if p := recover(); p != nil {
				slog.Error("request panic", "panic", p)
				writeError(w, problem(500, "INTERNAL_ERROR", "An unexpected error occurred"))
			}
		}()
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) wrap(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			switch r.Context().Err() {
			case context.Canceled:
				// The browser disconnected or aborted an obsolete request. Its
				// response is no longer needed; transaction defers still roll back.
				slog.Debug("request canceled", "method", r.Method, "path", r.URL.Path)
				return
			case context.DeadlineExceeded:
				// A server-side deadline is a different failure from a client abort.
				slog.Warn("request timed out", "method", r.Method, "path", r.URL.Path, "error", err)
				writeError(w, problem(http.StatusGatewayTimeout, "REQUEST_TIMEOUT", "The request timed out. Check the current state before retrying."))
				return
			}
			var ae *apiError
			if !errors.As(err, &ae) {
				var pe *pgconn.PgError
				switch {
				case errors.Is(err, pgx.ErrNoRows):
					ae = problem(404, "NOT_FOUND", "Record not found")
				case errors.As(err, &pe) && pe.Code == "23505":
					ae = problem(409, "SKU_EXISTS", "This SKU already exists")
				case errors.As(err, &pe) && (pe.Code == "40P01" || pe.Code == "40001"):
					ae = problem(409, "RETRY_REQUIRED", "A concurrent change occurred. Please retry.")
				default:
					slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "error", err)
					ae = problem(500, "INTERNAL_ERROR", "The request could not be completed. Please retry.")
				}
			}
			writeError(w, ae)
		}
	}
}
func writeJSON(w http.ResponseWriter, status int, v interface{}) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, e *apiError) {
	_ = writeJSON(w, e.Status, map[string]interface{}{"error": e})
}
func decode(w http.ResponseWriter, r *http.Request, v interface{}) error {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return problem(415, "UNSUPPORTED_MEDIA_TYPE", "Use Content-Type: application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return invalid("Invalid JSON: " + err.Error())
	}
	if err := d.Decode(new(interface{})); err != io.EOF {
		return invalid("The body must contain one JSON object")
	}
	return nil
}
func idParam(r *http.Request) (int64, error) {
	n, err := strconv.ParseInt(r.PathValue("id"), 10, 32)
	if err != nil || n <= 0 {
		return 0, invalid("id must be a positive integer")
	}
	return n, nil
}
func pagination(r *http.Request) (int, int, error) {
	page, limit := 1, 20
	var err error
	if v := r.URL.Query().Get("page"); v != "" {
		page, err = strconv.Atoi(v)
		if err != nil || page < 1 || page > 1000000 {
			return 0, 0, invalid("page must be between 1 and 1000000")
		}
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		limit, err = strconv.Atoi(v)
		if err != nil || limit < 1 || limit > 100 {
			return 0, 0, invalid("limit must be between 1 and 100")
		}
	}
	return page, limit, nil
}
func (s *Server) health(w http.ResponseWriter, r *http.Request) error {
	if err := s.db.Ping(r.Context()); err != nil {
		return problem(503, "UNAVAILABLE", "Database unavailable")
	}
	return writeJSON(w, 200, map[string]string{"status": "ok"})
}

// These interfaces let read helpers operate on either a pool or the transaction
// that owns the relevant product/order locks.
type querier interface {
	QueryRow(context.Context, string, ...interface{}) pgx.Row
	Query(context.Context, string, ...interface{}) (pgx.Rows, error)
}
