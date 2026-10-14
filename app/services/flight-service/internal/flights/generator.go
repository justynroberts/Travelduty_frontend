// Package flights simulates a flight inventory: deterministic offers per route/date/cabin
// plus seat holds that the booking saga reserves, confirms or releases.
package flights

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // container images may lack zoneinfo

	platform "github.com/justynroberts/travelduty-code/libs/go-platform"
)

type Airline struct {
	Code string `json:"code"`
	Name string `json:"name"`
	// TicketPrefix is the 3-digit airline accounting code used in ticket numbers.
	TicketPrefix string `json:"-"`
}

var Airlines = []Airline{
	{"NX", "Nimbus Air", "417"},
	{"AU", "Aurora Airways", "528"},
	{"MR", "Meridian Airlines", "239"},
	{"CS", "Coastline", "611"},
	{"BV", "Boreal", "784"},
}

var cabinMultiplier = map[string]float64{"economy": 1, "premium": 1.7, "business": 3.2}

type Offer struct {
	ID               string  `json:"id"`
	Airline          Airline `json:"airline"`
	FlightNumber     string  `json:"flightNumber"`
	From             string  `json:"from"`
	To               string  `json:"to"`
	DepartureTime    string  `json:"departureTime"`
	ArrivalTime      string  `json:"arrivalTime"`
	DurationMinutes  int     `json:"durationMinutes"`
	Stops            int     `json:"stops"`
	Cabin            string  `json:"cabin"`
	SeatsLeft        int     `json:"seatsLeft"`
	PricePerAdultEur float64 `json:"pricePerAdultEur"`
	TotalEur         float64 `json:"totalEur"`
	Adults           int     `json:"adults"`

	// capacity is the generated seat count before holds are subtracted.
	capacity int
}

// WithAdults returns a copy priced for n adults.
func (o Offer) WithAdults(n int) Offer {
	o.Adults = n
	o.TotalEur = platform.Round2(o.PricePerAdultEur * float64(n))
	return o
}

func OfferID(from, to, date, cabin string, index int) string {
	return fmt.Sprintf("FL.%s.%s.%s.%s.%d", from, to, date, cabin, index)
}

type offerKey struct {
	from, to, date, cabin string
	index                 int
}

func parseOfferID(id string) (offerKey, bool) {
	parts := strings.Split(id, ".")
	if len(parts) != 6 || parts[0] != "FL" {
		return offerKey{}, false
	}
	idx, err := strconv.Atoi(parts[5])
	if err != nil {
		return offerKey{}, false
	}
	return offerKey{parts[1], parts[2], parts[3], parts[4], idx}, true
}

func haversineKm(a, b platform.Airport) float64 {
	rad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat, dLon := rad(b.Lat-a.Lat), rad(b.Lon-a.Lon)
	h := math.Pow(math.Sin(dLat/2), 2) + math.Cos(rad(a.Lat))*math.Cos(rad(b.Lat))*math.Pow(math.Sin(dLon/2), 2)
	return 2 * 6371 * math.Asin(math.Sqrt(h))
}

// generate returns offers in generation order (index i ↔ offer id suffix i).
func generate(from, to platform.Airport, date time.Time, cabin string) ([]Offer, error) {
	origin, err := time.LoadLocation(from.Timezone)
	if err != nil {
		return nil, err
	}
	dest, err := time.LoadLocation(to.Timezone)
	if err != nil {
		return nil, err
	}
	dateStr := date.Format(time.DateOnly)
	rng := platform.Mulberry32(platform.FNV1a(fmt.Sprintf("%s-%s-%s-%s", from.Code, to.Code, dateStr, cabin)))
	km := haversineKm(from, to)
	count := 4 + int(rng()*4)

	offers := make([]Offer, 0, count)
	for i := 0; i < count; i++ {
		airline := Airlines[int(rng()*float64(len(Airlines)))]
		depMinutes := 6*60 + int(rng()*16*60)
		depMinutes -= depMinutes % 5
		stops := 0
		if km > 7000 && rng() < 0.6 {
			stops = 1
		}
		duration := int(math.Round(km/820*60 + 35 + float64(stops)*(70+rng()*90)))
		priceFactor := 0.75 + rng()*0.8
		price := platform.Round2((35 + 0.085*km) * priceFactor * cabinMultiplier[cabin])
		seats := 1 + int(rng()*9)
		number := 100 + int(rng()*900)

		dep := time.Date(date.Year(), date.Month(), date.Day(), depMinutes/60, depMinutes%60, 0, 0, origin)
		arr := dep.Add(time.Duration(duration) * time.Minute).In(dest)
		offers = append(offers, Offer{
			ID:               OfferID(from.Code, to.Code, dateStr, cabin, i),
			Airline:          airline,
			FlightNumber:     fmt.Sprintf("%s%d", airline.Code, number),
			From:             from.Code,
			To:               to.Code,
			DepartureTime:    dep.Format("2006-01-02T15:04"),
			ArrivalTime:      arr.Format("2006-01-02T15:04"),
			DurationMinutes:  duration,
			Stops:            stops,
			Cabin:            cabin,
			SeatsLeft:        seats,
			PricePerAdultEur: price,
			capacity:         seats,
		})
	}
	return offers, nil
}

func sortByPrice(offers []Offer) {
	sort.SliceStable(offers, func(i, j int) bool { return offers[i].PricePerAdultEur < offers[j].PricePerAdultEur })
}
