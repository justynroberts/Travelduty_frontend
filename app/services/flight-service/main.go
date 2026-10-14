package main

import (
	"log/slog"
	"os"
	"time"

	platform "github.com/justynroberts/travelduty-code/libs/go-platform"
	"github.com/justynroberts/travelduty-code/services/flight-service/internal/flights"
)

func main() {
	svc := platform.New(platform.OptionsFromEnv("flight-service"))
	airports, err := platform.LoadAirports()
	if err != nil {
		slog.Error("failed to load reference data", "err", err)
		os.Exit(1)
	}
	api := flights.NewAPI(airports, time.Duration(platform.EnvInt("HOLD_TTL_SECONDS", 900))*time.Second)
	api.Register(svc)
	if err := svc.Run(platform.EnvInt("PORT", 8082)); err != nil {
		svc.Log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
