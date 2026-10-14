package flights

import (
	"crypto/rand"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	platform "github.com/justynroberts/travelduty-code/libs/go-platform"
)

type Confirmation struct {
	PNR     string   `json:"pnr"`
	Tickets []string `json:"tickets"`
}

type API struct {
	Airports map[string]platform.Airport
	Holds    *platform.HoldStore[Offer]
	Now      func() time.Time
}

func NewAPI(airports map[string]platform.Airport, holdTTL time.Duration) *API {
	return &API{Airports: airports, Holds: platform.NewHoldStore[Offer]("fh", holdTTL), Now: time.Now}
}

func (a *API) Register(s *platform.Service) {
	s.Handle("GET /flights/search", a.search)
	s.Handle("GET /flights/offers/{id}", a.getOffer)
	s.Handle("POST /holds", a.createHold)
	s.Handle("GET /holds/{id}", a.getHold)
	s.Handle("POST /holds/{id}/confirm", a.confirmHold)
	s.Handle("DELETE /holds/{id}", a.cancelHold)
}

func (a *API) airport(code, field string) (platform.Airport, error) {
	ap, ok := a.Airports[strings.ToUpper(code)]
	if !ok {
		return ap, platform.Validation("%s must be a known airport code, got %q", field, code)
	}
	return ap, nil
}

func intParam(r *http.Request, name string, def, min, max int) (int, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return 0, platform.Validation("%s must be an integer between %d and %d", name, min, max)
	}
	return n, nil
}

// offers generates the route's offers with live seat availability applied.
func (a *API) offers(from, to platform.Airport, date time.Time, cabin string) ([]Offer, error) {
	list, err := generate(from, to, date, cabin)
	if err != nil {
		return nil, err
	}
	for i := range list {
		list[i].SeatsLeft = list[i].capacity - a.Holds.Reserved(list[i].ID)
	}
	return list, nil
}

func (a *API) search(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	from, err := a.airport(q.Get("from"), "from")
	if err != nil {
		return err
	}
	to, err := a.airport(q.Get("to"), "to")
	if err != nil {
		return err
	}
	if from.Code == to.Code {
		return platform.Validation("from and to must differ")
	}
	date, ok := platform.ParseDate(q.Get("date"))
	if !ok {
		return platform.Validation("date must be a YYYY-MM-DD date")
	}
	if date.Before(a.today()) {
		return platform.Validation("date must not be in the past")
	}
	adults, err := intParam(r, "adults", 1, 1, 9)
	if err != nil {
		return err
	}
	cabin := q.Get("cabin")
	if cabin == "" {
		cabin = "economy"
	}
	if _, ok := cabinMultiplier[cabin]; !ok {
		return platform.Validation("cabin must be one of economy, premium, business")
	}

	list, err := a.offers(from, to, date, cabin)
	if err != nil {
		return err
	}
	items := make([]Offer, 0, len(list))
	for _, o := range list {
		if o.SeatsLeft >= adults {
			items = append(items, o.WithAdults(adults))
		}
	}
	sortByPrice(items)
	platform.WriteJSON(w, http.StatusOK, map[string]any{
		"from": from.Code, "to": to.Code, "date": q.Get("date"), "adults": adults, "cabin": cabin,
		"count": len(items), "items": items,
	})
	return nil
}

func (a *API) findOffer(id string) (Offer, error) {
	key, ok := parseOfferID(id)
	if !ok {
		return Offer{}, platform.NotFound("Offer %s not found", id)
	}
	from, okFrom := a.Airports[key.from]
	to, okTo := a.Airports[key.to]
	date, okDate := platform.ParseDate(key.date)
	if _, okCabin := cabinMultiplier[key.cabin]; !okFrom || !okTo || !okDate || !okCabin {
		return Offer{}, platform.NotFound("Offer %s not found", id)
	}
	list, err := a.offers(from, to, date, key.cabin)
	if err != nil {
		return Offer{}, err
	}
	if key.index < 0 || key.index >= len(list) {
		return Offer{}, platform.NotFound("Offer %s not found", id)
	}
	return list[key.index], nil
}

func (a *API) getOffer(w http.ResponseWriter, r *http.Request) error {
	adults, err := intParam(r, "adults", 1, 1, 9)
	if err != nil {
		return err
	}
	o, err := a.findOffer(r.PathValue("id"))
	if err != nil {
		return err
	}
	platform.WriteJSON(w, http.StatusOK, o.WithAdults(adults))
	return nil
}

func (a *API) createHold(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		OfferID    string `json:"offerId"`
		Passengers int    `json:"passengers"`
	}
	if err := platform.DecodeJSON(r, &body); err != nil {
		return err
	}
	if body.OfferID == "" {
		return platform.Validation("offerId is required")
	}
	if body.Passengers < 1 || body.Passengers > 9 {
		return platform.Validation("passengers must be between 1 and 9")
	}
	offer, err := a.findOffer(body.OfferID)
	if err != nil {
		return err
	}
	if d, _ := platform.ParseDate(strings.Split(offer.DepartureTime, "T")[0]); d.Before(a.today()) {
		return platform.Conflict("OFFER_EXPIRED", "Flight %s has already departed", offer.FlightNumber)
	}
	hold, err := a.Holds.Reserve(offer.ID, offer.capacity, body.Passengers, offer.WithAdults(body.Passengers), "seats")
	if err != nil {
		return err
	}
	platform.WriteJSON(w, http.StatusCreated, hold)
	return nil
}

func (a *API) getHold(w http.ResponseWriter, r *http.Request) error {
	h, err := a.Holds.Get(r.PathValue("id"))
	if err != nil {
		return err
	}
	platform.WriteJSON(w, http.StatusOK, h)
	return nil
}

func (a *API) confirmHold(w http.ResponseWriter, r *http.Request) error {
	h, err := a.Holds.Confirm(r.PathValue("id"), func(h platform.Hold[Offer]) any {
		tickets := make([]string, h.Quantity)
		for i := range tickets {
			tickets[i] = h.Offer.Airline.TicketPrefix + "-" + randomDigits(10)
		}
		return Confirmation{PNR: randomPNR(), Tickets: tickets}
	})
	if err != nil {
		return err
	}
	platform.WriteJSON(w, http.StatusOK, h)
	return nil
}

func (a *API) cancelHold(w http.ResponseWriter, r *http.Request) error {
	h, err := a.Holds.Cancel(r.PathValue("id"))
	if err != nil {
		return err
	}
	platform.WriteJSON(w, http.StatusOK, h)
	return nil
}

func (a *API) today() time.Time {
	y, m, d := a.Now().UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func randomDigits(n int) string {
	b := make([]byte, n)
	for i := range b {
		v, _ := rand.Int(rand.Reader, big.NewInt(10))
		b[i] = byte('0' + v.Int64())
	}
	return string(b)
}

const pnrAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func randomPNR() string {
	b := make([]byte, 6)
	for i := range b {
		v, _ := rand.Int(rand.Reader, big.NewInt(int64(len(pnrAlphabet))))
		b[i] = pnrAlphabet[v.Int64()]
	}
	return string(b)
}
