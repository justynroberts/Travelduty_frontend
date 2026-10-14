// Package notify renders customer notifications and delivers them: email is simulated and
// recorded; if a webhook URL is configured (e.g. a Slack incoming webhook) it is also posted there.
package notify

import (
	"context"
	"fmt"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"sync"
	"time"

	platform "github.com/justynroberts/travelduty-code/libs/go-platform"
)

type Delivery struct {
	Channel string `json:"channel"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
}

type Notification struct {
	ID         string         `json:"id"`
	Template   string         `json:"template"`
	To         string         `json:"to"`
	BookingRef string         `json:"bookingRef"`
	Subject    string         `json:"subject"`
	Body       string         `json:"body"`
	Data       map[string]any `json:"data,omitempty"`
	CreatedAt  time.Time      `json:"createdAt"`
	Deliveries []Delivery     `json:"deliveries"`
}

// Webhook posts a rendered notification to an external endpoint.
type Webhook interface {
	PostJSON(ctx context.Context, url string, body any) error
}

type API struct {
	WebhookURL string
	Webhook    Webhook
	Now        func() time.Time
	Max        int

	mu    sync.RWMutex
	items []Notification // oldest first
}

func NewAPI(webhookURL string, webhook Webhook) *API {
	return &API{WebhookURL: webhookURL, Webhook: webhook, Now: time.Now, Max: 1000}
}

func (a *API) Register(s *platform.Service) {
	s.Handle("POST /notifications", a.create)
	s.Handle("GET /notifications", a.list)
	s.Handle("GET /notifications/{id}", a.get)
}

var templates = map[string]bool{"booking_confirmed": true, "booking_cancelled": true, "booking_failed": true}

func str(data map[string]any, key, fallback string) string {
	switch v := data[key].(type) {
	case string:
		if v != "" {
			return v
		}
	case float64:
		return strconv.FormatFloat(v, 'f', 2, 64)
	}
	return fallback
}

// Render produces the subject and plain-text body for a template.
func Render(template, ref string, data map[string]any) (string, string) {
	name := str(data, "customerName", "traveller")
	itinerary := str(data, "itinerary", "")
	total := strings.TrimSpace(str(data, "total", "") + " " + str(data, "currency", ""))
	var subject string
	var b strings.Builder
	fmt.Fprintf(&b, "Hi %s,\n\n", name)
	switch template {
	case "booking_confirmed":
		subject = fmt.Sprintf("Your TravelDuty booking %s is confirmed", ref)
		fmt.Fprintf(&b, "Great news — booking %s is confirmed.\n", ref)
		if itinerary != "" {
			fmt.Fprintf(&b, "\nItinerary:\n%s\n", itinerary)
		}
		if total != "" {
			fmt.Fprintf(&b, "\nTotal charged: %s\n", total)
		}
	case "booking_cancelled":
		subject = fmt.Sprintf("Your TravelDuty booking %s has been cancelled", ref)
		fmt.Fprintf(&b, "Booking %s has been cancelled.\n", ref)
		if total != "" {
			fmt.Fprintf(&b, "A refund of %s is on its way to your card.\n", total)
		}
	case "booking_failed":
		subject = fmt.Sprintf("We couldn't complete booking %s", ref)
		fmt.Fprintf(&b, "Unfortunately we couldn't complete booking %s: %s.\nYou have not been charged.\n",
			ref, str(data, "reason", "an unexpected error occurred"))
	}
	b.WriteString("\nSafe travels,\nThe TravelDuty team\n")
	return subject, b.String()
}

func (a *API) create(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Template   string         `json:"template"`
		To         string         `json:"to"`
		BookingRef string         `json:"bookingRef"`
		Data       map[string]any `json:"data"`
	}
	if err := platform.DecodeJSON(r, &body); err != nil {
		return err
	}
	if !templates[body.Template] {
		return platform.Validation("template must be one of booking_confirmed, booking_cancelled, booking_failed")
	}
	if _, err := mail.ParseAddress(body.To); err != nil {
		return platform.Validation("to must be a valid email address")
	}
	if body.BookingRef == "" {
		return platform.Validation("bookingRef is required")
	}

	subject, text := Render(body.Template, body.BookingRef, body.Data)
	n := Notification{
		ID:         "ntf_" + platform.RandomHex(8),
		Template:   body.Template,
		To:         body.To,
		BookingRef: body.BookingRef,
		Subject:    subject,
		Body:       text,
		Data:       body.Data,
		CreatedAt:  a.Now().UTC(),
		// Email delivery is simulated: recorded here and in the logs.
		Deliveries: []Delivery{{Channel: "email", Status: "sent"}},
	}
	if a.WebhookURL != "" && a.Webhook != nil {
		d := Delivery{Channel: "webhook", Status: "sent"}
		if err := a.Webhook.PostJSON(r.Context(), a.WebhookURL, map[string]string{"text": subject + "\n" + text}); err != nil {
			d.Status, d.Error = "failed", err.Error()
		}
		n.Deliveries = append(n.Deliveries, d)
	}

	a.mu.Lock()
	a.items = append(a.items, n)
	if len(a.items) > a.Max {
		a.items = a.items[len(a.items)-a.Max:]
	}
	a.mu.Unlock()

	platform.WriteJSON(w, http.StatusAccepted, n)
	return nil
}

func (a *API) list(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	limit := 50
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 500 {
			return platform.Validation("limit must be between 1 and 500")
		}
		limit = n
	}
	ref, to := q.Get("bookingRef"), strings.ToLower(q.Get("to"))
	a.mu.RLock()
	defer a.mu.RUnlock()
	items := []Notification{}
	for i := len(a.items) - 1; i >= 0 && len(items) < limit; i-- {
		n := a.items[i]
		if (ref == "" || n.BookingRef == ref) && (to == "" || strings.ToLower(n.To) == to) {
			items = append(items, n)
		}
	}
	platform.WriteJSON(w, http.StatusOK, map[string]any{"items": items})
	return nil
}

func (a *API) get(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	a.mu.RLock()
	defer a.mu.RUnlock()
	for _, n := range a.items {
		if n.ID == id {
			platform.WriteJSON(w, http.StatusOK, n)
			return nil
		}
	}
	return platform.NotFound("Notification %s not found", id)
}
