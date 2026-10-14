package com.travelduty.hotel.platform;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ErrorBody(Detail error) {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Detail(String code, String message, Object details) {}

  public static ErrorBody of(String code, String message) {
    return new ErrorBody(new Detail(code, message, null));
  }

  public static ErrorBody of(String code, String message, Object details) {
    return new ErrorBody(new Detail(code, message, details));
  }
}
