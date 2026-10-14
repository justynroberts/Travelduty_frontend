package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client is a JSON HTTP client that propagates request ids and records upstream metrics.
type Client struct {
	Name    string
	HTTP    *http.Client
	Service *Service
}

func (s *Service) NewClient(name string, timeout time.Duration) *Client {
	return &Client{Name: name, HTTP: &http.Client{Timeout: timeout}, Service: s}
}

// UpstreamError describes a failed outbound call.
type UpstreamError struct {
	Target string
	Status int
	Err    error
}

func (e *UpstreamError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s unreachable: %v", e.Target, e.Err)
	}
	return fmt.Sprintf("%s responded %d", e.Target, e.Status)
}

// PostJSON sends body as JSON. It does not retry: callers decide whether a POST is safe to repeat.
func (c *Client) PostJSON(ctx context.Context, url string, body any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "TravelDuty/0.1 (sample microservices app)")
	if id := RequestID(ctx); id != "" {
		req.Header.Set("x-request-id", id)
	}
	start := time.Now()
	res, err := c.HTTP.Do(req)
	if err != nil {
		c.record(false, start)
		return &UpstreamError{Target: c.Name, Err: err}
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	ok := res.StatusCode < 300
	c.record(ok, start)
	if !ok {
		return &UpstreamError{Target: c.Name, Status: res.StatusCode}
	}
	return nil
}

func (c *Client) record(ok bool, start time.Time) {
	if c.Service != nil {
		c.Service.RecordUpstream(c.Name, ok, time.Since(start))
	}
}
