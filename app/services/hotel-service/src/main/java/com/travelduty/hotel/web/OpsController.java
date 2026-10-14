package com.travelduty.hotel.web;

import com.travelduty.hotel.platform.ApiException;
import com.travelduty.hotel.platform.ChaosState;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.lang.management.ManagementFactory;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Health, readiness, Prometheus metrics and chaos administration (contract §1). */
@RestController
public class OpsController {
  private static final Logger log = LoggerFactory.getLogger(OpsController.class);
  private static final String PROMETHEUS_TEXT = "text/plain; version=0.0.4; charset=utf-8";

  private final PrometheusMeterRegistry registry;
  private final ChaosState chaos;
  private final String version;
  private final String adminToken;

  public OpsController(
      PrometheusMeterRegistry registry,
      ChaosState chaos,
      @Value("${travelduty.version}") String version,
      @Value("${travelduty.admin-token}") String adminToken) {
    this.registry = registry;
    this.chaos = chaos;
    this.version = version;
    this.adminToken = adminToken;
  }

  @GetMapping("/health")
  Map<String, Object> health() {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("status", "ok");
    body.put("service", "hotel-service");
    body.put("version", version);
    body.put("uptimeSeconds", ManagementFactory.getRuntimeMXBean().getUptime() / 1000);
    return body;
  }

  /** Inventory is in memory and reference data is loaded at startup, so there are no dependency checks. */
  @GetMapping("/ready")
  Map<String, Object> ready() {
    return Map.of("status", "ready", "checks", Map.of());
  }

  @GetMapping(value = "/metrics")
  ResponseEntity<String> metrics() {
    return ResponseEntity.ok().header("content-type", PROMETHEUS_TEXT).body(registry.scrape(PROMETHEUS_TEXT));
  }

  public record ChaosUpdate(
      @Min(0) @Max(60_000) Integer latencyMs,
      @Min(0) @Max(60_000) Integer jitterMs,
      @DecimalMin("0") @DecimalMax("1") Double errorRate,
      @Min(400) @Max(599) Integer errorStatus) {}

  @GetMapping("/admin/chaos")
  ChaosState.Snapshot getChaos(@RequestHeader(value = "x-admin-token", required = false) String token) {
    authorize(token);
    return chaos.snapshot();
  }

  @PutMapping("/admin/chaos")
  ChaosState.Snapshot putChaos(
      @RequestHeader(value = "x-admin-token", required = false) String token,
      @Valid @RequestBody ChaosUpdate update) {
    authorize(token);
    ChaosState.Snapshot s = chaos.update(update.latencyMs(), update.jitterMs(), update.errorRate(), update.errorStatus());
    log.warn("chaos: configuration changed to {}", s);
    return s;
  }

  @DeleteMapping("/admin/chaos")
  ChaosState.Snapshot resetChaos(@RequestHeader(value = "x-admin-token", required = false) String token) {
    authorize(token);
    log.info("chaos: reset");
    return chaos.reset();
  }

  private void authorize(String token) {
    if (adminToken != null && !adminToken.isEmpty() && !adminToken.equals(token)) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "A valid x-admin-token header is required");
    }
  }
}
