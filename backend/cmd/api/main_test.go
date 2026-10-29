package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestOccupiedPortFailsBeforeDatabaseSetup(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	t.Setenv("HTTP_ADDR", listener.Addr().String())
	t.Setenv("DATABASE_URL", "deliberately-invalid-database-url")
	err = run(context.Background())
	var networkError *net.OpError
	if !errors.As(err, &networkError) || !strings.Contains(err.Error(), "stop the existing API") {
		t.Fatalf("expected an actionable port error, got %v", err)
	}
}

func TestShutdownWaitsForActiveRequest(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	shutdownStarted := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(release) }) }
	defer finish()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "completed")
	})}
	defer srv.Close()
	srv.RegisterOnShutdown(func() { close(shutdownStarted) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serve(ctx, srv, listener) }()
	response := make(chan string, 1)
	go func() {
		client := &http.Client{Timeout: 3 * time.Second}
		r, err := client.Get("http://" + listener.Addr().String())
		if err != nil {
			response <- err.Error()
			return
		}
		defer r.Body.Close()
		body, _ := io.ReadAll(r.Body)
		response <- string(body)
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case <-shutdownStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown did not start")
	}
	select {
	case err := <-done:
		t.Fatalf("shutdown returned before the request finished: %v", err)
	default:
	}
	finish()
	select {
	case body := <-response:
		if body != "completed" {
			t.Fatalf("request interrupted during shutdown: %q", body)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("request did not complete")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not finish shutting down")
	}
}
