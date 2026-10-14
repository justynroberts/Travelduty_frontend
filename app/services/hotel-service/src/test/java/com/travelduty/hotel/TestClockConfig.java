package com.travelduty.hotel;

import java.time.Instant;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

@TestConfiguration
public class TestClockConfig {
  public static final Instant START = Instant.parse("2026-10-14T09:00:00Z");

  @Bean
  @Primary
  MutableClock testClock() {
    return new MutableClock(START);
  }
}
