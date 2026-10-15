// Package platform implements the TravelDuty service contract (docs/contract.md) for Go services:
// request ids, JSON logs, /health, /ready, /metrics, chaos injection and the error envelope.
package platform

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// HandlerFunc is an HTTP handler that may return an error to be rendered as the error envelope.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// ReadinessCheck reports whether a dependency is healthy.
type ReadinessCheck func(ctx context.Context) bool

type Options struct {
	Name       string
	Version    string
	AdminToken string
	Chaos      ChaosState
	Readiness  map[string]ReadinessCheck
	Logger     *slog.Logger
	// Random overrides the chaos random source (tests).
	Random func() float64
}

type Service struct {
	Name     string
	Log      *slog.Logger
	Registry *prometheus.Registry
	Chaos    *Chaos

	mux        *http.ServeMux
	started    time.Time
	opts       Options
	requests   *prometheus.CounterVec
	durations  *prometheus.HistogramVec
	upstream   *prometheus.CounterVec
	upstreamDu *prometheus.HistogramVec

	clearDownOnce sync.Once
	clearedDown   *prometheus.CounterVec
}

type ctxKey int

const (
	requestIDKey ctxKey = iota
	routeKey
)

// RequestID returns the request id stored on ctx by the service middleware.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// OptionsFromEnv fills the common contract settings from the environment.
func OptionsFromEnv(name string) Options {
	return Options{
		Name:       name,
		Version:    Env("APP_VERSION", "dev"),
		AdminToken: os.Getenv("ADMIN_TOKEN"),
		Chaos: ChaosState{
			LatencyMs:   EnvInt("CHAOS_LATENCY_MS", 0),
			JitterMs:    EnvInt("CHAOS_JITTER_MS", 0),
			ErrorRate:   EnvFloat("CHAOS_ERROR_RATE", 0),
			ErrorStatus: EnvInt("CHAOS_ERROR_STATUS", 503),
		},
	}
}

func New(opts Options) *Service {
	if opts.Logger == nil {
		opts.Logger = NewLogger(opts.Name, Env("LOG_LEVEL", "info"))
	}
	if opts.Chaos.ErrorStatus == 0 {
		opts.Chaos.ErrorStatus = 503
	}
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	labels := prometheus.Labels{"service": opts.Name}
	s := &Service{
		Name:     opts.Name,
		Log:      opts.Logger,
		Registry: reg,
		mux:      http.NewServeMux(),
		started:  time.Now(),
		opts:     opts,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "http_requests_total", Help: "HTTP requests handled", ConstLabels: labels,
		}, []string{"method", "route", "status"}),
		durations: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "http_request_duration_seconds", Help: "HTTP request latency", ConstLabels: labels,
			Buckets: []float64{0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
		}, []string{"method", "route"}),
		upstream: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "upstream_calls_total", Help: "Outbound calls to other services and external APIs", ConstLabels: labels,
		}, []string{"target", "outcome"}),
		upstreamDu: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "upstream_call_duration_seconds", Help: "Outbound call latency", ConstLabels: labels,
			Buckets: []float64{0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
		}, []string{"target"}),
	}
	reg.MustRegister(s.requests, s.durations, s.upstream, s.upstreamDu)
	s.Chaos = newChaos(opts.Name, opts.Chaos, opts.Random)

	s.Handle("GET /health", s.health)
	s.Handle("GET /ready", s.ready)
	s.mux.Handle("GET /metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	s.Handle("GET /admin/chaos", s.adminOnly(s.Chaos.get))
	s.Handle("PUT /admin/chaos", s.adminOnly(s.Chaos.put))
	s.Handle("DELETE /admin/chaos", s.adminOnly(s.Chaos.reset))
	s.Handle("/", func(w http.ResponseWriter, r *http.Request) error {
		return NotFound("Route %s %s not found", r.Method, r.URL.Path)
	})
	return s
}

// Handle registers a route using Go 1.22+ ServeMux patterns, e.g. "GET /holds/{id}".
func (s *Service) Handle(pattern string, h HandlerFunc) {
	route := pattern
	if i := strings.IndexByte(pattern, ' '); i >= 0 {
		route = pattern[i+1:]
	}
	if route == "/" {
		route = "unmatched"
	}
	s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		if holder, ok := r.Context().Value(routeKey).(*string); ok {
			*holder = route
		}
		if err := h(w, r); err != nil {
			var he *HTTPError
			if !errors.As(err, &he) || he.Status >= 500 {
				s.Log.ErrorContext(r.Context(), "request failed", "err", err.Error())
			}
			WriteError(w, err)
		}
	})
}

// RecordUpstream records an outbound call in upstream metrics (used by Client).
func (s *Service) RecordUpstream(target string, ok bool, d time.Duration) {
	outcome := "success"
	if !ok {
		outcome = "error"
	}
	s.upstream.WithLabelValues(target, outcome).Inc()
	s.upstreamDu.WithLabelValues(target).Observe(d.Seconds())
}

// Handler returns the full middleware stack: request id → metrics/logging → chaos → routes.
func (s *Service) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("x-request-id")
		if id == "" || len(id) > 128 {
			id = newUUID()
		}
		route := "unmatched"
		ctx := context.WithValue(context.WithValue(r.Context(), requestIDKey, id), routeKey, &route)
		r = r.WithContext(ctx)
		w.Header().Set("x-request-id", id)

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		if s.Chaos.intercept(rec, r) {
			route = "chaos_injected" // short-circuited before routing; keep label cardinality bounded
		} else {
			s.mux.ServeHTTP(rec, r)
		}
		elapsed := time.Since(start)

		if r.URL.Path == "/metrics" {
			return
		}
		s.requests.WithLabelValues(r.Method, route, itoa(rec.status)).Inc()
		s.durations.WithLabelValues(r.Method, route).Observe(elapsed.Seconds())
		s.Log.InfoContext(ctx, "request completed",
			"method", r.Method, "path", r.URL.Path, "route", route, "status", rec.status,
			"durationMs", float64(elapsed.Microseconds())/1000)
	})
}

func (s *Service) health(w http.ResponseWriter, _ *http.Request) error {
	WriteJSON(w, http.StatusOK, map[string]any{
		"status":        "ok",
		"service":       s.Name,
		"version":       s.opts.Version,
		"uptimeSeconds": int(time.Since(s.started).Seconds()),
	})
	return nil
}

func (s *Service) ready(w http.ResponseWriter, r *http.Request) error {
	checks := map[string]bool{}
	allOK := true
	for name, check := range s.opts.Readiness {
		ok := check(r.Context())
		checks[name] = ok
		allOK = allOK && ok
	}
	status, code := "ready", http.StatusOK
	if !allOK {
		status, code = "not_ready", http.StatusServiceUnavailable
	}
	WriteJSON(w, code, map[string]any{"status": status, "checks": checks})
	return nil
}

func (s *Service) adminOnly(h HandlerFunc) HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		if s.opts.AdminToken != "" && r.Header.Get("x-admin-token") != s.opts.AdminToken {
			return NewError(http.StatusUnauthorized, "UNAUTHORIZED", "A valid x-admin-token header is required")
		}
		return h(w, r)
	}
}

// Run serves until SIGINT/SIGTERM, then drains in-flight requests.
func (s *Service) Run(port int) error {
	srv := &http.Server{
		Addr:              ":" + itoa(port),
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		s.Log.Info("listening", "port", port)
		errCh <- srv.ListenAndServe()
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errCh:
		return err
	case got := <-sig:
		s.Log.Info("shutting down", "signal", got.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.status = code
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	r.wroteHeader = true
	return r.ResponseWriter.Write(b)
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// RandomHex returns n random bytes hex-encoded (2n characters).
func RandomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
