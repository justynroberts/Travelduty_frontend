package com.travelduty.hotel.platform;

import org.springframework.http.HttpStatus;

/** An error that maps directly onto the contract's {@code { error: { code, message, details } }} envelope. */
public class ApiException extends RuntimeException {
  private final HttpStatus status;
  private final String code;
  private final transient Object details;

  public ApiException(HttpStatus status, String code, String message, Object details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  public ApiException(HttpStatus status, String code, String message) {
    this(status, code, message, null);
  }

  public static ApiException validation(String message) {
    return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message);
  }

  public static ApiException notFound(String message) {
    return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", message);
  }

  public static ApiException conflict(String code, String message, Object details) {
    return new ApiException(HttpStatus.CONFLICT, code, message, details);
  }

  public HttpStatus status() {
    return status;
  }

  public String code() {
    return code;
  }

  public Object details() {
    return details;
  }
}
