package platform

import (
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ChaosState is the runtime fault-injection configuration exposed at /admin/chaos.
type ChaosState struct {
	LatencyMs   int     `json:"latencyMs"`
	JitterMs    int     `json:"jitterMs"`
	ErrorRate   float64 `json:"errorRate"`
	ErrorStatus int     `json:"errorStatus"`
}

type Chaos struct {
	mu      sync.RWMutex
	state   ChaosState
	service string
	random  func() float64
}

func newChaos(service string, initial ChaosState, random func() float64) *Chaos {
	if random == nil {
		random = rand.Float64
	}
	return &Chaos{state: initial, service: service, random: random}
}

func (c *Chaos) State() ChaosState {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state
}

func isChaosEligible(path string) bool {
	for _, p := range []string{"/health", "/ready", "/metrics", "/admin"} {
		if path == p || strings.HasPrefix(path, p+"/") {
			return false
		}
	}
	return true
}

// intercept applies latency and maybe writes an injected failure; returns true if it responded.
func (c *Chaos) intercept(w http.ResponseWriter, r *http.Request) bool {
	if !isChaosEligible(r.URL.Path) {
		return false
	}
	st := c.State()
	delay := float64(st.LatencyMs)
	if st.JitterMs > 0 {
		delay += c.random() * float64(st.JitterMs)
	}
	if delay > 0 {
		select {
		case <-time.After(time.Duration(delay * float64(time.Millisecond))):
		case <-r.Context().Done():
		}
	}
	if st.ErrorRate > 0 && c.random() < st.ErrorRate {
		WriteError(w, NewError(st.ErrorStatus, "CHAOS_INJECTED", "Injected failure in %s", c.service))
		return true
	}
	return false
}

func (c *Chaos) get(w http.ResponseWriter, _ *http.Request) error {
	WriteJSON(w, http.StatusOK, c.State())
	return nil
}

func (c *Chaos) put(w http.ResponseWriter, r *http.Request) error {
	var patch map[string]json.RawMessage
	if err := DecodeJSON(r, &patch); err != nil {
		return err
	}
	c.mu.Lock()
	next := c.state
	c.mu.Unlock()
	for key, raw := range patch {
		var n float64
		if err := json.Unmarshal(raw, &n); err != nil {
			return Validation("%s must be a number", key)
		}
		isInt := n == float64(int(n))
		switch key {
		case "latencyMs", "jitterMs":
			if !isInt || n < 0 || n > 60000 {
				return Validation("%s must be an integer between 0 and 60000", key)
			}
			if key == "latencyMs" {
				next.LatencyMs = int(n)
			} else {
				next.JitterMs = int(n)
			}
		case "errorRate":
			if n < 0 || n > 1 {
				return Validation("errorRate must be between 0 and 1")
			}
			next.ErrorRate = n
		case "errorStatus":
			if !isInt || n < 400 || n > 599 {
				return Validation("errorStatus must be an integer between 400 and 599")
			}
			next.ErrorStatus = int(n)
		default:
			return Validation("unknown chaos field %q", key)
		}
	}
	c.mu.Lock()
	c.state = next
	c.mu.Unlock()
	WriteJSON(w, http.StatusOK, next)
	return nil
}

func (c *Chaos) reset(w http.ResponseWriter, _ *http.Request) error {
	c.mu.Lock()
	c.state = ChaosState{ErrorStatus: 503}
	st := c.state
	c.mu.Unlock()
	WriteJSON(w, http.StatusOK, st)
	return nil
}
