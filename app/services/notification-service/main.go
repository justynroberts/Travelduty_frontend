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
	api := notify.NewAPI(webhookURL, webhook)
	api.Register(svc)
	domain := platform.Env("SYNTHETIC_EMAIL_DOMAIN", "travelduty.test")
	retention := time.Duration(platform.EnvInt("CLEARDOWN_RETENTION_MINUTES", 60)) * time.Minute
	svc.ClearDown("notifications", time.Duration(platform.EnvInt("CLEARDOWN_INTERVAL_SECONDS", 60))*time.Second, func() int {
		return api.PruneSynthetic(domain, time.Now().Add(-retention))
	})
	if err := svc.Run(platform.EnvInt("PORT", 8087)); err != nil {
		svc.Log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
