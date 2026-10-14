package platform

import (
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func quietLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func newTestService(opts Options) *Service {
	opts.Name = "test-service"
	opts.Logger = quietLogger()
	s := New(opts)
	s.Handle("GET /things/{id}", func(w http.ResponseWriter, r *http.Request) error {
		if r.PathValue("id") == "missing" {
			return NotFound("thing missing")
		}
		WriteJSON(w, 200, map[string]string{"id": r.PathValue("id"), "requestId": RequestID(r.Context())})
		return nil
	})
	return s
}

func do(t *testing.T, h http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var env struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not an error envelope: %s", rec.Body.String())
	}
	return env.Error.Code
}

func TestSeedingMatchesJavaScriptReference(t *testing.T) {
	seed := FNV1a("LHR-LIS-2026-11-02-economy")
	if seed != 1474013850 {
		t.Fatalf("fnv1a = %d", seed)
	}
	r := Mulberry32(seed)
	for _, want := range []float64{0.67204211326316, 0.07595136086456478, 0.30505932960659266} {
		if got := r(); math.Abs(got-want) > 1e-12 {
			t.Fatalf("mulberry32 got %v want %v", got, want)
		}
	}
}

func TestRequestIDPropagation(t *testing.T) {
	h := newTestService(Options{}).Handler()
	rec := do(t, h, "GET", "/things/1", "", map[string]string{"x-request-id": "abc-123"})
	if rec.Header().Get("x-request-id") != "abc-123" || !strings.Contains(rec.Body.String(), "abc-123") {
		t.Fatalf("request id not propagated: %v %s", rec.Header(), rec.Body.String())
	}
	rec = do(t, h, "GET", "/things/1", "", nil)
	if len(rec.Header().Get("x-request-id")) != 36 {
		t.Fatalf("expected generated uuid, got %q", rec.Header().Get("x-request-id"))
	}
}

func TestErrorEnvelopeAndNotFound(t *testing.T) {
	h := newTestService(Options{}).Handler()
	if rec := do(t, h, "GET", "/things/missing", "", nil); rec.Code != 404 || errorCode(t, rec) != "NOT_FOUND" {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(t, h, "GET", "/nope", "", nil); rec.Code != 404 || errorCode(t, rec) != "NOT_FOUND" {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestChaosInjectionAndAdmin(t *testing.T) {
	s := newTestService(Options{Chaos: ChaosState{ErrorRate: 1, ErrorStatus: 503}})
	h := s.Handler()
	if rec := do(t, h, "GET", "/things/1", "", nil); rec.Code != 503 || errorCode(t, rec) != "CHAOS_INJECTED" {
		t.Fatalf("expected chaos, got %d", rec.Code)
	}
	if rec := do(t, h, "GET", "/health", "", nil); rec.Code != 200 {
		t.Fatalf("health must be exempt, got %d", rec.Code)
	}
	if rec := do(t, h, "PUT", "/admin/chaos", `{"errorRate":2}`, nil); rec.Code != 400 || errorCode(t, rec) != "VALIDATION_ERROR" {
		t.Fatalf("expected validation error, got %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(t, h, "DELETE", "/admin/chaos", "", nil); rec.Code != 200 {
		t.Fatalf("reset failed: %d", rec.Code)
	}
	if rec := do(t, h, "GET", "/things/1", "", nil); rec.Code != 200 {
		t.Fatalf("expected recovery after reset, got %d", rec.Code)
	}
	rec := do(t, h, "PUT", "/admin/chaos", `{"latencyMs":20}`, nil)
	if rec.Code != 200 || s.Chaos.State().LatencyMs != 20 {
		t.Fatalf("latency update failed: %s", rec.Body.String())
	}
	start := time.Now()
	do(t, h, "GET", "/things/1", "", nil)
	if time.Since(start) < 20*time.Millisecond {
		t.Fatal("latency not injected")
	}
}

func TestAdminTokenGuard(t *testing.T) {
	h := newTestService(Options{AdminToken: "s3cret"}).Handler()
	if rec := do(t, h, "GET", "/admin/chaos", "", nil); rec.Code != 401 {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if rec := do(t, h, "GET", "/admin/chaos", "", map[string]string{"x-admin-token": "s3cret"}); rec.Code != 200 {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestMetricsUseRouteTemplates(t *testing.T) {
	h := newTestService(Options{}).Handler()
	do(t, h, "GET", "/things/42", "", nil)
	body := do(t, h, "GET", "/metrics", "", nil).Body.String()
	if !strings.Contains(body, `http_requests_total{method="GET",route="/things/{id}",service="test-service",status="200"} 1`) {
		t.Fatalf("metric missing:\n%s", body)
	}
}

func TestHoldStoreLifecycle(t *testing.T) {
	now := time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)
	store := NewHoldStore[string]("th", 15*time.Minute)
	store.Now = func() time.Time { return now }

	h, err := store.Reserve("offer-1", 3, 2, "offer", "seats")
	if err != nil || h.Status != "held" {
		t.Fatalf("reserve: %v %+v", err, h)
	}
	if _, err := store.Reserve("offer-1", 3, 2, "offer", "seats"); err == nil || err.(*HTTPError).Code != "SOLD_OUT" {
		t.Fatalf("expected SOLD_OUT, got %v", err)
	}
	c, err := store.Confirm(h.ID, func(Hold[string]) any { return "ok" })
	if err != nil || c.Status != "confirmed" || c.Confirmation != "ok" {
		t.Fatalf("confirm: %v %+v", err, c)
	}
	if again, _ := store.Confirm(h.ID, func(Hold[string]) any { return "other" }); again.Confirmation != "ok" {
		t.Fatal("confirm must be idempotent")
	}
	if x, _ := store.Cancel(h.ID); x.Status != "cancelled" || store.Reserved("offer-1") != 0 {
		t.Fatalf("cancel did not release capacity")
	}

	h2, _ := store.Reserve("offer-1", 3, 1, "offer", "seats")
	now = now.Add(16 * time.Minute)
	if _, err := store.Confirm(h2.ID, func(Hold[string]) any { return nil }); err == nil || err.(*HTTPError).Code != "HOLD_EXPIRED" {
		t.Fatalf("expected HOLD_EXPIRED, got %v", err)
	}
	if store.Reserved("offer-1") != 0 {
		t.Fatal("expired hold must not count against capacity")
	}
}
