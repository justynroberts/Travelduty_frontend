package com.travelduty.hotel.platform;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import static net.logstash.logback.argument.StructuredArguments.kv;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

/**
 * Records the contract's {@code http_requests_total} and {@code http_request_duration_seconds},
 * labelled by route template (e.g. {@code /holds/{id}}) rather than raw path.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class HttpMetricsFilter extends OncePerRequestFilter {
  private static final Logger log = LoggerFactory.getLogger(HttpMetricsFilter.class);
  private static final Duration[] BUCKETS = {
    Duration.ofMillis(10), Duration.ofMillis(25), Duration.ofMillis(50), Duration.ofMillis(100),
    Duration.ofMillis(250), Duration.ofMillis(500), Duration.ofSeconds(1), Duration.ofMillis(2500),
    Duration.ofSeconds(5), Duration.ofSeconds(10)
  };

  private final MeterRegistry registry;

  public HttpMetricsFilter(MeterRegistry registry) {
    this.registry = registry;
  }

  @Override
  protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws ServletException, IOException {
    long started = System.nanoTime();
    try {
      chain.doFilter(req, res);
    } finally {
      Object pattern = req.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
      String route = pattern != null ? pattern.toString() : "unmatched";
      if (!"/metrics".equals(route)) {
        long elapsed = System.nanoTime() - started;
        String status = Integer.toString(res.getStatus());
        Counter.builder("http.requests")
            .description("HTTP requests handled")
            .tags("method", req.getMethod(), "route", route, "status", status)
            .register(registry)
            .increment();
        Timer.builder("http.request.duration")
            .description("HTTP request latency")
            .tags("method", req.getMethod(), "route", route)
            .serviceLevelObjectives(BUCKETS)
            .register(registry)
            .record(Duration.ofNanos(elapsed));
        log.info("request completed", kv("method", req.getMethod()), kv("route", route),
            kv("status", res.getStatus()), kv("durationMs", elapsed / 1_000_000));
      }
    }
  }
}
