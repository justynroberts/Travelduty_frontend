package platform

import (
	"sync"
	"time"
)

// Hold is a temporary inventory reservation (see "Holds" in docs/contract.md).
type Hold[O any] struct {
	ID           string     `json:"id"`
	Status       string     `json:"status"`
	Offer        O          `json:"offer"`
	Quantity     int        `json:"quantity"`
	CreatedAt    time.Time  `json:"createdAt"`
	ExpiresAt    time.Time  `json:"expiresAt"`
	ConfirmedAt  *time.Time `json:"confirmedAt,omitempty"`
	CancelledAt  *time.Time `json:"cancelledAt,omitempty"`
	Confirmation any        `json:"confirmation,omitempty"`

	inventoryKey string
}

// HoldStore is an in-memory, concurrency-safe hold registry with capacity accounting.
type HoldStore[O any] struct {
	mu     sync.Mutex
	holds  map[string]*Hold[O]
	prefix string
	ttl    time.Duration
	Now    func() time.Time
}

func NewHoldStore[O any](prefix string, ttl time.Duration) *HoldStore[O] {
	return &HoldStore[O]{holds: map[string]*Hold[O]{}, prefix: prefix, ttl: ttl, Now: time.Now}
}

// Reserve atomically checks capacity and creates a hold. capacity is the total units the
// inventory key has; held and confirmed units are subtracted.
func (s *HoldStore[O]) Reserve(inventoryKey string, capacity, quantity int, offer O, unit string) (Hold[O], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	available := capacity - s.reservedLocked(inventoryKey)
	if quantity > available {
		if available < 0 {
			available = 0
		}
		return Hold[O]{}, Conflict("SOLD_OUT", "Only %d %s left", available, unit).
			WithDetails(map[string]int{"available": available})
	}
	now := s.Now().UTC()
	h := &Hold[O]{
		ID:           s.prefix + "_" + RandomHex(8),
		Status:       "held",
		Offer:        offer,
		Quantity:     quantity,
		CreatedAt:    now,
		ExpiresAt:    now.Add(s.ttl),
		inventoryKey: inventoryKey,
	}
	s.holds[h.ID] = h
	return *h, nil
}

// Reserved returns units held or confirmed against inventoryKey.
func (s *HoldStore[O]) Reserved(inventoryKey string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reservedLocked(inventoryKey)
}

func (s *HoldStore[O]) reservedLocked(key string) int {
	total := 0
	for _, h := range s.holds {
		s.expireLocked(h)
		if h.inventoryKey == key && (h.Status == "held" || h.Status == "confirmed") {
			total += h.Quantity
		}
	}
	return total
}

func (s *HoldStore[O]) Get(id string) (Hold[O], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h, ok := s.holds[id]
	if !ok {
		return Hold[O]{}, NotFound("Hold %s not found", id)
	}
	s.expireLocked(h)
	return *h, nil
}

// Confirm marks a hold confirmed (idempotent), attaching the confirmation built by mk.
func (s *HoldStore[O]) Confirm(id string, mk func(Hold[O]) any) (Hold[O], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h, ok := s.holds[id]
	if !ok {
		return Hold[O]{}, NotFound("Hold %s not found", id)
	}
	s.expireLocked(h)
	switch h.Status {
	case "confirmed":
		return *h, nil
	case "expired":
		return Hold[O]{}, Conflict("HOLD_EXPIRED", "Hold %s expired at %s", id, h.ExpiresAt.Format(time.RFC3339))
	case "cancelled":
		return Hold[O]{}, Conflict("HOLD_CANCELLED", "Hold %s was cancelled", id)
	}
	now := s.Now().UTC()
	h.Status = "confirmed"
	h.ConfirmedAt = &now
	h.Confirmation = mk(*h)
	return *h, nil
}

// Cancel releases a hold or cancels a confirmed reservation. Idempotent.
func (s *HoldStore[O]) Cancel(id string) (Hold[O], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h, ok := s.holds[id]
	if !ok {
		return Hold[O]{}, NotFound("Hold %s not found", id)
	}
	s.expireLocked(h)
	if h.Status == "held" || h.Status == "confirmed" {
		now := s.Now().UTC()
		h.Status = "cancelled"
		h.CancelledAt = &now
	}
	return *h, nil
}

func (s *HoldStore[O]) expireLocked(h *Hold[O]) {
	if h.Status == "held" && !s.Now().Before(h.ExpiresAt) {
		h.Status = "expired"
	}
}
