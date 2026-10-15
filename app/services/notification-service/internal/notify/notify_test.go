package notify

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	platform "github.com/justynroberts/travelduty-code/libs/go-platform"
)

func setup(t *testing.T, webhookURL string) http.Handler {
	t.Helper()
	svc := platform.New(platform.Options{Name: "notification-service", Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))})
	NewAPI(webhookURL, svc.NewClient("webhook", 2*time.Second)).Register(svc)
	return svc.Handler()
}

func call(t *testing.T, h http.Handler, method, path, body string, out any) int {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	if out != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatalf("decode %s: %v", rec.Body.String(), err)
		}
	}
	return rec.Code
}

const confirmed = `{"template":"booking_confirmed","to":"ada@example.com","bookingRef":"TD-ABC123",
  "data":{"customerName":"Ada","total":812.5,"currency":"GBP","itinerary":"LHR → LIS NX482"}}`

func TestCreateRendersAndLists(t *testing.T) {
	h := setup(t, "")
	var n Notification
	if code := call(t, h, "POST", "/notifications", confirmed, &n); code != 202 {
		t.Fatalf("expected 202, got %d", code)
	}
	if n.Subject != "Your TravelDuty booking TD-ABC123 is confirmed" || !strings.Contains(n.Body, "812.50 GBP") || !strings.Contains(n.Body, "Hi Ada") {
		t.Fatalf("bad render: %q / %q", n.Subject, n.Body)
	}
	if len(n.Deliveries) != 1 || n.Deliveries[0].Channel != "email" {
		t.Fatalf("deliveries: %+v", n.Deliveries)
	}
	call(t, h, "POST", "/notifications", `{"template":"booking_failed","to":"bob@example.com","bookingRef":"TD-ZZZ999","data":{"reason":"card declined"}}`, nil)

	var list struct{ Items []Notification }
	call(t, h, "GET", "/notifications?bookingRef=TD-ABC123", "", &list)
	if len(list.Items) != 1 || list.Items[0].ID != n.ID {
		t.Fatalf("filter by bookingRef: %+v", list.Items)
	}
	call(t, h, "GET", "/notifications", "", &list)
	if len(list.Items) != 2 || list.Items[0].BookingRef != "TD-ZZZ999" {
		t.Fatal("expected newest first")
	}
	if code := call(t, h, "GET", "/notifications/"+n.ID, "", nil); code != 200 {
		t.Fatalf("get by id: %d", code)
	}
	if code := call(t, h, "GET", "/notifications/ntf_missing", "", nil); code != 404 {
		t.Fatalf("expected 404, got %d", code)
	}
}

func TestValidation(t *testing.T) {
	h := setup(t, "")
	for _, body := range []string{
		`{"template":"nope","to":"a@b.com","bookingRef":"TD-1"}`,
		`{"template":"booking_confirmed","to":"not-an-email","bookingRef":"TD-1"}`,
		`{"template":"booking_confirmed","to":"a@b.com"}`,
		`not json`,
	} {
		if code := call(t, h, "POST", "/notifications", body, nil); code != 400 {
			t.Errorf("%s: expected 400, got %d", body, code)
		}
	}
}

func TestWebhookDelivery(t *testing.T) {
	var got map[string]string
	var gotRequestID string
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRequestID = r.Header.Get("x-request-id")
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(200)
	}))
	defer hook.Close()

	h := setup(t, hook.URL)
	req := httptest.NewRequest("POST", "/notifications", strings.NewReader(confirmed))
	req.Header.Set("x-request-id", "trace-1")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var n Notification
	_ = json.Unmarshal(rec.Body.Bytes(), &n)
	if len(n.Deliveries) != 2 || n.Deliveries[1].Status != "sent" {
		t.Fatalf("webhook delivery: %+v", n.Deliveries)
	}
	if !strings.HasPrefix(got["text"], "Your TravelDuty booking TD-ABC123 is confirmed") || gotRequestID != "trace-1" {
		t.Fatalf("webhook payload %+v, request id %q", got, gotRequestID)
	}
}

func TestWebhookFailureIsRecordedNotFatal(t *testing.T) {
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) }))
	defer hook.Close()
	h := setup(t, hook.URL)
	var n Notification
	if code := call(t, h, "POST", "/notifications", confirmed, &n); code != 202 {
		t.Fatalf("expected 202 even when webhook fails, got %d", code)
	}
	if n.Deliveries[1].Status != "failed" || !strings.Contains(n.Deliveries[1].Error, "500") {
		t.Fatalf("expected failed webhook delivery: %+v", n.Deliveries)
	}
}

func TestPruneSyntheticKeepsRealCustomers(t *testing.T) {
	svc := platform.New(platform.Options{Name: "notification-service", Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))})
	api := NewAPI("", nil)
	api.Register(svc)
	h := svc.Handler()
	synthetic := strings.Replace(confirmed, "ada@example.com", "synthetic.user3@TravelDuty.test", 1)
	for _, body := range []string{synthetic, confirmed, synthetic} {
		if code := call(t, h, "POST", "/notifications", body, nil); code != http.StatusAccepted {
			t.Fatalf("create: %d", code)
		}
	}
	if n := api.PruneSynthetic("travelduty.test", time.Now().Add(-time.Hour)); n != 0 {
		t.Fatalf("pruned %d recent notifications", n)
	}
	if n := api.PruneSynthetic("travelduty.test", time.Now().Add(time.Second)); n != 2 {
		t.Fatalf("want 2 synthetic pruned, got %d", n)
	}
	var list struct{ Items []Notification }
	call(t, h, "GET", "/notifications", "", &list)
	if len(list.Items) != 1 || list.Items[0].To != "ada@example.com" {
		t.Fatalf("real notification must survive: %+v", list.Items)
	}
}
