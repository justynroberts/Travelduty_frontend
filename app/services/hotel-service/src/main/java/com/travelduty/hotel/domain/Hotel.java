package com.travelduty.hotel.domain;

import java.util.List;

public record Hotel(
    String id,
    String name,
    int stars,
    double rating,
    String neighbourhood,
    List<String> amenities,
    double baseRateEur) {}
