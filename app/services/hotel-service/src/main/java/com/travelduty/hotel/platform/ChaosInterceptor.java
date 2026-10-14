package com.travelduty.hotel.platform;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.concurrent.ThreadLocalRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * Applies injected latency and failures. Runs as an interceptor (after handler mapping) so the
 * failed requests are still labelled with their route in metrics. Ops paths are excluded in
 * {@link WebConfig}.
 */
@Component
public class ChaosInterceptor implements HandlerInterceptor {
  private static final Logger log = LoggerFactory.getLogger(ChaosInterceptor.class);

  private final ChaosState chaos;
  private final ObjectMapper mapper;

  public ChaosInterceptor(ChaosState chaos, ObjectMapper mapper) {
    this.chaos = chaos;
    this.mapper = mapper;
  }

  @Override
  public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) throws Exception {
    ChaosState.Snapshot s = chaos.snapshot();
    ThreadLocalRandom random = ThreadLocalRandom.current();
    long delay = s.latencyMs() + (s.jitterMs() > 0 ? (long) (random.nextDouble() * s.jitterMs()) : 0);
    if (delay > 0) Thread.sleep(delay);
    if (s.errorRate() > 0 && random.nextDouble() < s.errorRate()) {
      log.warn("chaos: injecting failure");
      res.setStatus(s.errorStatus());
      res.setContentType(MediaType.APPLICATION_JSON_VALUE);
      mapper.writeValue(res.getOutputStream(), ErrorBody.of("CHAOS_INJECTED", "Injected failure in hotel-service"));
      return false;
    }
    return true;
  }
}
