package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// HTTPError maps onto the contract's {"error":{"code","message","details"}} envelope.
type HTTPError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

func (e *HTTPError) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message) }

func NewError(status int, code, format string, args ...any) *HTTPError {
	return &HTTPError{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

func (e *HTTPError) WithDetails(d any) *HTTPError {
	e.Details = d
	return e
}

func Validation(format string, args ...any) *HTTPError {
	return NewError(http.StatusBadRequest, "VALIDATION_ERROR", format, args...)
}

func NotFound(format string, args ...any) *HTTPError {
	return NewError(http.StatusNotFound, "NOT_FOUND", format, args...)
}

func Conflict(code, format string, args ...any) *HTTPError {
	return NewError(http.StatusConflict, code, format, args...)
}

type envelope struct {
	Error *HTTPError `json:"error"`
}

// WriteJSON writes v as a JSON response with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteError writes err using the error envelope; non-HTTPErrors become 500 INTERNAL_ERROR.
func WriteError(w http.ResponseWriter, err error) {
	var he *HTTPError
	if !errors.As(err, &he) {
		he = NewError(http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")
	}
	WriteJSON(w, he.Status, envelope{Error: he})
}

// DecodeJSON reads a JSON request body into v, mapping malformed input to 400 VALIDATION_ERROR.
func DecodeJSON(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return Validation("could not read request body")
	}
	if len(body) == 0 {
		return Validation("request body is required")
	}
	if err := json.Unmarshal(body, v); err != nil {
		return Validation("invalid JSON body: %v", err)
	}
	return nil
}
