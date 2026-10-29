package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type trackedResponse struct {
	*httptest.ResponseRecorder
	written bool
}

func (w *trackedResponse) WriteHeader(status int) {
	w.written = true
	w.ResponseRecorder.WriteHeader(status)
}

func (w *trackedResponse) Write(body []byte) (int, error) {
	w.written = true
	return w.ResponseRecorder.Write(body)
}

func TestRequestErrorHandling(t *testing.T) {
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	expired, cancelDeadline := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelDeadline()

	// These tests intentionally run sequentially because slog's default logger
	// is process-wide. Restore it before the rest of the suite executes.
	previousLogger := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	cases := []struct {
		name       string
		ctx        context.Context
		err        error
		wantStatus int
		wantCode   string
		wantLevel  string
	}{
		{"client abort", cancelled, context.Canceled, 0, "", ""},
		{"wrapped client abort", cancelled, fmt.Errorf("query interrupted: %w", context.Canceled), 0, "", ""},
		{"driver disconnect after abort", cancelled, errors.New("connection closed"), 0, "", ""},
		{"request deadline", expired, context.DeadlineExceeded, 504, "REQUEST_TIMEOUT", "WARN"},
		{"driver cancellation at deadline", expired, context.Canceled, 504, "REQUEST_TIMEOUT", "WARN"},
		{"internal cancellation with connected client", context.Background(), context.Canceled, 500, "INTERNAL_ERROR", "ERROR"},
		{"database failure", context.Background(), errors.New("database unavailable"), 500, "INTERNAL_ERROR", "ERROR"},
		{"stock conflict", context.Background(), insufficient("COF-001", 3), 409, "INSUFFICIENT_STOCK", ""},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			var logs bytes.Buffer
			slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
			s := &Server{}
			w := &trackedResponse{ResponseRecorder: httptest.NewRecorder()}
			r := httptest.NewRequest(http.MethodGet, "/api/products", nil).WithContext(tt.ctx)
			s.wrap(func(http.ResponseWriter, *http.Request) error { return tt.err })(w, r)
			if tt.wantStatus == 0 {
				if w.written {
					t.Fatalf("wrote a response to a disconnected client: %s", w.Body.String())
				}
			} else {
				if w.Code != tt.wantStatus {
					t.Fatalf("want HTTP %d, got %d", tt.wantStatus, w.Code)
				}
				var body struct {
					Error apiError `json:"error"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if body.Error.Code != tt.wantCode {
					t.Fatalf("want error %s, got %s", tt.wantCode, body.Error.Code)
				}
				if tt.wantCode == "INSUFFICIENT_STOCK" && (body.Error.SKU != "COF-001" || body.Error.Available == nil || *body.Error.Available != 3) {
					t.Fatalf("lost stock conflict details: %+v", body.Error)
				}
			}
			if tt.wantLevel == "" && logs.Len() != 0 {
				t.Fatalf("unexpected error/warning log: %s", logs.String())
			}
			if tt.wantLevel != "" && !strings.Contains(logs.String(), "level="+tt.wantLevel) {
				t.Fatalf("expected %s log, got %s", tt.wantLevel, logs.String())
			}
		})
	}
}
