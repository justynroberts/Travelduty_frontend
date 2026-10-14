package com.travelduty.hotel.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** Accepts or generates {@code x-request-id}, echoes it, and puts it in the logging MDC. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {
  public static final String HEADER = "x-request-id";
  public static final String MDC_KEY = "requestId";

  @Override
  protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws ServletException, IOException {
    String incoming = req.getHeader(HEADER);
    String id = incoming != null && !incoming.isBlank() && incoming.length() <= 128 ? incoming : UUID.randomUUID().toString();
    res.setHeader(HEADER, id);
    MDC.put(MDC_KEY, id);
    try {
      chain.doFilter(req, res);
    } finally {
      MDC.remove(MDC_KEY);
    }
  }
}
