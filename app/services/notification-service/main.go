package main

import (
	"os"
	"time"

	platform "github.com/justynroberts/travelduty-code/libs/go-platform"
	"github.com/justynroberts/travelduty-code/services/notification-service/internal/notify"
)

func main() {
	svc := platform.New(platform.OptionsFromEnv("notification-service"))
	webhookURL := os.Getenv("WEBHOOK_URL")
	webhook := svc.NewClient("webhook", time.Duration(platform.EnvInt("WEBHOOK_TIMEOUT_MS", 4000))*time.Millisecond)
	if webhookURL != "" {
		svc.Log.Info("webhook delivery enabled")
	}
	notify.NewAPI(webhookURL, webhook).Register(svc)
	if err := svc.Run(platform.EnvInt("PORT", 8087)); err != nil {
		svc.Log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
