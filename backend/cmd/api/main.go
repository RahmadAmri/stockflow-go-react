package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"stockflow/backend/internal/api"
	"stockflow/backend/internal/database"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	// Reserve the port before migration or a readiness message. Starting a second
	// copy now fails immediately, without falsely claiming the API is ready.
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on %s (stop the existing API or set HTTP_ADDR to another port): %w", addr, err)
	}
	defer listener.Close()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgres://stockflow:stockflow@localhost:5432/stockflow?sslmode=disable"
	}
	setup, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(setup, url)
	if err != nil {
		return fmt.Errorf("database configuration: %w", err)
	}
	defer pool.Close()
	if err = database.Migrate(setup, pool); err != nil {
		return fmt.Errorf("database startup: %w", err)
	}
	cancel()
	srv := &http.Server{Handler: api.New(pool), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 25 * time.Second, IdleTimeout: 60 * time.Second}
	// Keep the database pool open until active requests finish shutting down.
	return serve(ctx, srv, listener)
}

func serve(ctx context.Context, srv *http.Server, listener net.Listener) error {
	done := make(chan error, 1)
	go func() { done <- srv.Serve(listener) }()
	slog.Info("StockFlow API ready", "address", listener.Addr().String())
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			_ = srv.Close()
			return fmt.Errorf("shutdown: %w", err)
		}
		return nil
	}
}
