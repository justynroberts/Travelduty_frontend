package com.travelduty.hotel;

import java.time.Clock;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class HotelServiceApplication {

  public static void main(String[] args) {
    SpringApplication.run(HotelServiceApplication.class, args);
  }

  /** Injectable so tests can move time forward to expire holds. */
  @Bean
  Clock clock() {
    return Clock.systemUTC();
  }
}
