package com.travelduty.hotel.platform;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Runtime fault-injection settings; initialised from CHAOS_* and changed via /admin/chaos. */
@Component
public class ChaosState {
  private int latencyMs;
  private int jitterMs;
  private double errorRate;
  private int errorStatus;

  public ChaosState(
      @Value("${travelduty.chaos.latency-ms}") int latencyMs,
      @Value("${travelduty.chaos.jitter-ms}") int jitterMs,
      @Value("${travelduty.chaos.error-rate}") double errorRate,
      @Value("${travelduty.chaos.error-status}") int errorStatus) {
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.errorRate = errorRate;
    this.errorStatus = errorStatus;
  }

  public record Snapshot(int latencyMs, int jitterMs, double errorRate, int errorStatus) {}

  public synchronized Snapshot snapshot() {
    return new Snapshot(latencyMs, jitterMs, errorRate, errorStatus);
  }

  public synchronized Snapshot update(Integer latencyMs, Integer jitterMs, Double errorRate, Integer errorStatus) {
    if (latencyMs != null) this.latencyMs = latencyMs;
    if (jitterMs != null) this.jitterMs = jitterMs;
    if (errorRate != null) this.errorRate = errorRate;
    if (errorStatus != null) this.errorStatus = errorStatus;
    return snapshot();
  }

  public synchronized Snapshot reset() {
    return update(0, 0, 0.0, 503);
  }
}
