package com.travelduty.hotel.domain;

import java.util.List;

public record Offer(
    String id,
    Hotel hotel,
    String city,
    String checkIn,
    String checkOut,
    int nights,
    int guests,
    int roomsLeft,
    List<Double> nightlyRatesEur,
    double avgNightlyEur,
    double totalEur) {

  /** Rooms are counted per hotel per check-in date, matching how availability is seeded. */
  public String inventoryKey() {
    return hotel.id() + "-" + checkIn;
  }
}
