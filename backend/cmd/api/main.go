package main

import (
	"context"
	"errors"
	"log/slog"
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
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgres://stockflow:stockflow@localhost:5432/stockflow?sslmode=disable"
	}
	setup, cancel := context.WithTimeout(ctx, 60*time.Second)
	pool, err := pgxpool.New(setup, url)
	if err != nil {
		slog.Error("database configuration", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err = database.Migrate(setup, pool); err != nil {
		slog.Error("database startup", "error", err)
		os.Exit(1)
	}
	cancel()
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	srv := &http.Server{Addr: addr, Handler: api.New(pool), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 25 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			slog.Error("shutdown", "error", err)
		}
	}()
	slog.Info("StockFlow API ready", "address", addr)
	if err = srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server", "error", err)
		os.Exit(1)
	}
}
