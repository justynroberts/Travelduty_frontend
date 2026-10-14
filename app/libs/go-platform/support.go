package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func Env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func EnvInt(name string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return fallback
}

func EnvFloat(name string, fallback float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(name), 64); err == nil {
		return v
	}
	return fallback
}

func itoa(n int) string { return strconv.Itoa(n) }

// NewLogger returns a JSON slog logger that adds service and requestId attributes.
func NewLogger(service, level string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	}
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: lvl,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.LevelKey {
				a.Value = slog.StringValue(strings.ToLower(a.Value.String()))
			}
			return a
		},
	})
	return slog.New(requestIDHandler{h}).With("service", service)
}

type requestIDHandler struct{ slog.Handler }

func (h requestIDHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("requestId", id))
	}
	return h.Handler.Handle(ctx, r)
}

func (h requestIDHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return requestIDHandler{h.Handler.WithAttrs(attrs)}
}

func (h requestIDHandler) WithGroup(name string) slog.Handler {
	return requestIDHandler{h.Handler.WithGroup(name)}
}

// Airport is an entry of data/airports.json.
type Airport struct {
	Code        string   `json:"code"`
	City        string   `json:"city"`
	Country     string   `json:"country"`
	CountryCode string   `json:"countryCode"`
	Currency    string   `json:"currency"`
	Timezone    string   `json:"timezone"`
	Lat         float64  `json:"lat"`
	Lon         float64  `json:"lon"`
	CostIndex   float64  `json:"costIndex"`
	Tags        []string `json:"tags"`
	Blurb       string   `json:"blurb"`
}

// LoadAirports reads airports.json from REFERENCE_DATA_DIR, or finds data/airports.json by
// walking up from the working directory (so `go run` works from a service directory).
func LoadAirports() (map[string]Airport, error) {
	path := ""
	if dir := os.Getenv("REFERENCE_DATA_DIR"); dir != "" {
		path = filepath.Join(dir, "airports.json")
	} else {
		dir, _ := os.Getwd()
		for {
			candidate := filepath.Join(dir, "data", "airports.json")
			if _, err := os.Stat(candidate); err == nil {
				path = candidate
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				return nil, fmt.Errorf("data/airports.json not found; set REFERENCE_DATA_DIR")
			}
			dir = parent
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var list []Airport
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	out := make(map[string]Airport, len(list))
	for _, a := range list {
		out[a.Code] = a
	}
	return out, nil
}

// FNV1a is the contract's 32-bit FNV-1a hash used to seed deterministic inventory.
func FNV1a(s string) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 0x01000193
	}
	return h
}

// Mulberry32 returns the contract's seeded PRNG producing floats in [0,1).
func Mulberry32(seed uint32) func() float64 {
	a := seed
	return func() float64 {
		a += 0x6d2b79f5
		t := a
		t = (t ^ (t >> 15)) * (t | 1)
		t ^= t + (t^(t>>7))*(t|61)
		return float64(t^(t>>14)) / 4294967296.0
	}
}

// Round2 rounds to 2 decimal places.
func Round2(f float64) float64 {
	v, _ := strconv.ParseFloat(strconv.FormatFloat(f, 'f', 2, 64), 64)
	return v
}

// ParseDate parses a YYYY-MM-DD date.
func ParseDate(s string) (time.Time, bool) {
	t, err := time.Parse(time.DateOnly, s)
	return t, err == nil
}
