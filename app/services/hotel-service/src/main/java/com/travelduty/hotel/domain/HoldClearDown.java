package com.travelduty.hotel.domain;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Hands-off clear-down: synthetic users hold and cancel rooms around the clock, so finished holds
 * older than the retention window are deleted on a schedule instead of piling up in memory.
 */
@Component
public class HoldClearDown {
  private static final Logger log = LoggerFactory.getLogger(HoldClearDown.class);

  private final HoldStore holds;
  private final Clock clock;
  private final Duration retention;
  private final Counter removed;

  public HoldClearDown(
      HoldStore holds,
      Clock clock,
      MeterRegistry registry,
      @Value("${travelduty.cleardown.retention-minutes}") long retentionMinutes) {
    this.holds = holds;
    this.clock = clock;
    this.retention = Duration.ofMinutes(retentionMinutes);
    this.removed =
        Counter.builder("cleardown.records")
            .description("Finished records deleted by the automatic clear-down")
            .tag("store", "holds")
            .register(registry);
  }

  @Scheduled(
      initialDelayString = "${travelduty.cleardown.interval-seconds}",
      fixedDelayString = "${travelduty.cleardown.interval-seconds}",
      timeUnit = java.util.concurrent.TimeUnit.SECONDS)
  public int run() {
    int n = holds.prune(clock.instant().minus(retention));
    if (n > 0) {
      removed.increment(n);
      log.info("cleared down {} finished holds", n);
    }
    return n;
  }
}
