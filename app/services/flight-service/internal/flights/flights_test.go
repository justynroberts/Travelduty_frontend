package flights

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	platform "github.com/justynroberts/travelduty-code/libs/go-platform"
)

var fixedNow = time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)

func setup(t *testing.T) (*API, http.Handler) {
	t.Helper()
	t.Setenv("REFERENCE_DATA_DIR", "../../../../data")
	airports, err := platform.LoadAirports()
	if err != nil {
		t.Fatal(err)
	}
	svc := platform.New(platform.Options{Name: "flight-service", Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))})
	api := NewAPI(airports, 15*time.Minute)
	api.Now = func() time.Time { return fixedNow }
	api.Holds.Now = api.Now
	api.Register(svc)
	return api, svc.Handler()
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

type searchResult struct {
	Count int     `json:"count"`
	Items []Offer `json:"items"`
}

type holdResult struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	Quantity     int    `json:"quantity"`
	Offer        Offer  `json:"offer"`
	Confirmation *struct {
		PNR     string   `json:"pnr"`
		Tickets []string `json:"tickets"`
	} `json:"confirmation"`
}

type errResult struct {
	Error struct {
		Code    string         `json:"code"`
		Details map[string]int `json:"details"`
	} `json:"error"`
}

func TestSearchIsDeterministicAndSorted(t *testing.T) {
	_, h := setup(t)
	var a, b searchResult
	call(t, h, "GET", "/flights/search?from=LHR&to=LIS&date=2026-11-02&adults=2", "", &a)
	call(t, h, "GET", "/flights/search?from=LHR&to=LIS&date=2026-11-02&adults=2", "", &b)
	if a.Count < 4 || a.Count > 7 {
		t.Fatalf("expected 4-7 offers, got %d", a.Count)
	}
	for i := range a.Items {
		if a.Items[i].ID != b.Items[i].ID || a.Items[i].PricePerAdultEur != b.Items[i].PricePerAdultEur {
			t.Fatal("search not deterministic")
		}
		if i > 0 && a.Items[i].PricePerAdultEur < a.Items[i-1].PricePerAdultEur {
			t.Fatal("offers not sorted by price")
		}
		if a.Items[i].TotalEur != platform.Round2(a.Items[i].PricePerAdultEur*2) {
			t.Fatal("total must be price × adults")
		}
	}
}

func TestTimesAreTimezoneAware(t *testing.T) {
	_, h := setup(t)
	var r searchResult
	call(t, h, "GET", "/flights/search?from=LHR&to=NRT&date=2026-11-02", "", &r)
	o := r.Items[0]
	dep, _ := time.ParseInLocation("2006-01-02T15:04", o.DepartureTime, mustLoc(t, "Europe/London"))
	arr, _ := time.ParseInLocation("2006-01-02T15:04", o.ArrivalTime, mustLoc(t, "Asia/Tokyo"))
	if got := int(arr.Sub(dep).Minutes()); got != o.DurationMinutes {
		t.Fatalf("arrival-departure = %d min, duration = %d", got, o.DurationMinutes)
	}
	if o.DurationMinutes < 600 {
		t.Fatalf("London-Tokyo should be long haul, got %d min", o.DurationMinutes)
	}
}

func mustLoc(t *testing.T, name string) *time.Location {
	l, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestSearchValidation(t *testing.T) {
	_, h := setup(t)
	for _, q := range []string{
		"from=XXX&to=LIS&date=2026-11-02",
		"from=LIS&to=LIS&date=2026-11-02",
		"from=LHR&to=LIS&date=2026-13-01",
		"from=LHR&to=LIS&date=2026-10-01",
		"from=LHR&to=LIS&date=2026-11-02&adults=10",
		"from=LHR&to=LIS&date=2026-11-02&cabin=first",
	} {
		var e errResult
		if code := call(t, h, "GET", "/flights/search?"+q, "", &e); code != 400 || e.Error.Code != "VALIDATION_ERROR" {
			t.Errorf("%s: expected 400 VALIDATION_ERROR, got %d %s", q, code, e.Error.Code)
		}
	}
}

func TestHoldConfirmCancel(t *testing.T) {
	_, h := setup(t)
	var r searchResult
	call(t, h, "GET", "/flights/search?from=CDG&to=JFK&date=2026-12-01", "", &r)
	offer := r.Items[0]

	var hold holdResult
	if code := call(t, h, "POST", "/holds", `{"offerId":"`+offer.ID+`","passengers":1}`, &hold); code != 201 || hold.Status != "held" {
		t.Fatalf("create hold: %d %+v", code, hold)
	}
	var after Offer
	call(t, h, "GET", "/flights/offers/"+offer.ID, "", &after)
	if after.SeatsLeft != offer.SeatsLeft-1 {
		t.Fatalf("seat not reserved: %d → %d", offer.SeatsLeft, after.SeatsLeft)
	}

	var confirmed holdResult
	call(t, h, "POST", "/holds/"+hold.ID+"/confirm", "", &confirmed)
	if confirmed.Status != "confirmed" || len(confirmed.Confirmation.Tickets) != 1 || len(confirmed.Confirmation.PNR) != 6 {
		t.Fatalf("confirm: %+v", confirmed)
	}
	if !regexp.MustCompile(`^\d{3}-\d{10}$`).MatchString(confirmed.Confirmation.Tickets[0]) {
		t.Fatalf("bad ticket number %q", confirmed.Confirmation.Tickets[0])
	}

	var cancelled holdResult
	call(t, h, "DELETE", "/holds/"+hold.ID, "", &cancelled)
	call(t, h, "DELETE", "/holds/"+hold.ID, "", &cancelled)
	if cancelled.Status != "cancelled" {
		t.Fatalf("cancel: %+v", cancelled)
	}
	call(t, h, "GET", "/flights/offers/"+offer.ID, "", &after)
	if after.SeatsLeft != offer.SeatsLeft {
		t.Fatal("cancellation did not release the seat")
	}
}

func TestSoldOutAndExpiry(t *testing.T) {
	api, h := setup(t)
	var r searchResult
	call(t, h, "GET", "/flights/search?from=AMS&to=BCN&date=2026-11-20", "", &r)
	offer := r.Items[0]

	var e errResult
	body := `{"offerId":"` + offer.ID + `","passengers":` + itoa(offer.SeatsLeft+1) + `}`
	if code := call(t, h, "POST", "/holds", body, &e); code != 409 || e.Error.Code != "SOLD_OUT" || e.Error.Details["available"] != offer.SeatsLeft {
		t.Fatalf("expected SOLD_OUT, got %d %+v", code, e)
	}

	var hold holdResult
	call(t, h, "POST", "/holds", `{"offerId":"`+offer.ID+`","passengers":1}`, &hold)
	later := fixedNow.Add(16 * time.Minute)
	api.Holds.Now = func() time.Time { return later }
	if code := call(t, h, "POST", "/holds/"+hold.ID+"/confirm", "", &e); code != 409 || e.Error.Code != "HOLD_EXPIRED" {
		t.Fatalf("expected HOLD_EXPIRED, got %d %s", code, e.Error.Code)
	}
}

func TestUnknownOfferAndHold(t *testing.T) {
	_, h := setup(t)
	for _, p := range []string{"/flights/offers/FL.LHR.LIS.2026-11-02.economy.99", "/flights/offers/garbage", "/holds/fh_nope"} {
		if code := call(t, h, "GET", p, "", nil); code != 404 {
			t.Errorf("%s: expected 404, got %d", p, code)
		}
	}
	var e errResult
	if code := call(t, h, "POST", "/holds", `{"offerId":"FL.LHR.LIS.2026-11-02.economy.0","passengers":0}`, &e); code != 400 {
		t.Fatalf("expected 400, got %d", code)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }
