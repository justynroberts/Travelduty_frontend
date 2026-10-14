package com.travelduty.hotel.platform;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {
  private final ChaosInterceptor chaos;

  public WebConfig(ChaosInterceptor chaos) {
    this.chaos = chaos;
  }

  @Override
  public void addInterceptors(InterceptorRegistry registry) {
    registry.addInterceptor(chaos)
        .addPathPatterns("/**")
        .excludePathPatterns("/health", "/ready", "/metrics", "/admin", "/admin/**");
  }
}
