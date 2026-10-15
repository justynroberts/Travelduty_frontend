package platform

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// ClearDown runs sweep every interval for the life of the process and counts what it removed
// under cleardown_records_total{store}. Synthetic traffic creates and finishes records around
// the clock; sweeps keep the in-memory stores from growing without anyone stepping in.
func (s *Service) ClearDown(store string, every time.Duration, sweep func() int) {
	s.clearDownOnce.Do(func() {
		s.clearedDown = prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cleardown_records_total", Help: "Finished records deleted by the automatic clear-down",
			ConstLabels: prometheus.Labels{"service": s.Name},
		}, []string{"store"})
		s.Registry.MustRegister(s.clearedDown)
	})
	counter := s.clearedDown.WithLabelValues(store)
	go func() {
		for range time.Tick(every) {
			if n := sweep(); n > 0 {
				counter.Add(float64(n))
				s.Log.Info("cleared down", "store", store, "removed", n)
			}
		}
	}()
}
