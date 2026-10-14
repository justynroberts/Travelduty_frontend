package com.travelduty.hotel;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

/** A clock tests can move forward to expire holds. */
public class MutableClock extends Clock {
  private volatile Instant now;

  public MutableClock(Instant start) {
    this.now = start;
  }

  public void advance(Duration d) {
    now = now.plus(d);
  }

  public void set(Instant instant) {
    now = instant;
  }

  @Override
  public ZoneId getZone() {
    return ZoneOffset.UTC;
  }

  @Override
  public Clock withZone(ZoneId zone) {
    return this;
  }

  @Override
  public Instant instant() {
    return now;
  }
}
