package com.travelduty.hotel.platform;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/** Every error leaves the service in the contract's envelope — never Spring's defaults. */
@RestControllerAdvice
public class GlobalExceptionHandler {
  private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  @ExceptionHandler(ApiException.class)
  ResponseEntity<ErrorBody> api(ApiException e) {
    return ResponseEntity.status(e.status()).body(ErrorBody.of(e.code(), e.getMessage(), e.details()));
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  ResponseEntity<ErrorBody> invalidBody(MethodArgumentNotValidException e) {
    String message = e.getBindingResult().getFieldErrors().stream()
        .map(f -> f.getField() + " " + f.getDefaultMessage())
        .findFirst()
        .orElse("Invalid request body");
    return validation(message);
  }

  @ExceptionHandler(HandlerMethodValidationException.class)
  ResponseEntity<ErrorBody> invalidParams(HandlerMethodValidationException e) {
    return validation("Invalid request parameters");
  }

  @ExceptionHandler(MissingServletRequestParameterException.class)
  ResponseEntity<ErrorBody> missingParam(MissingServletRequestParameterException e) {
    return validation("Missing required query parameter '" + e.getParameterName() + "'");
  }

  @ExceptionHandler(MethodArgumentTypeMismatchException.class)
  ResponseEntity<ErrorBody> typeMismatch(MethodArgumentTypeMismatchException e) {
    return validation("Invalid value for '" + e.getName() + "'");
  }

  @ExceptionHandler(HttpMessageNotReadableException.class)
  ResponseEntity<ErrorBody> unreadable(HttpMessageNotReadableException e) {
    return validation("Request body is missing or not valid JSON");
  }

  @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
  ResponseEntity<ErrorBody> mediaType(HttpMediaTypeNotSupportedException e) {
    return validation("Content-Type must be application/json");
  }

  @ExceptionHandler({NoHandlerFoundException.class, NoResourceFoundException.class})
  ResponseEntity<ErrorBody> noRoute(Exception e) {
    return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ErrorBody.of("NOT_FOUND", "Route not found"));
  }

  @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
  ResponseEntity<ErrorBody> method(HttpRequestMethodNotSupportedException e) {
    return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
        .body(ErrorBody.of("METHOD_NOT_ALLOWED", "Method " + e.getMethod() + " not allowed"));
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<ErrorBody> unhandled(Exception e) {
    log.error("unhandled error", e);
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
        .body(ErrorBody.of("INTERNAL_ERROR", "Internal server error"));
  }

  private static ResponseEntity<ErrorBody> validation(String message) {
    return ResponseEntity.badRequest().body(ErrorBody.of("VALIDATION_ERROR", message));
  }
}
