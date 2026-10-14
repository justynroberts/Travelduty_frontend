package com.travelduty.hotel.domain;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record Airport(
    String code,
    String city,
    String country,
    String countryCode,
    String currency,
    String timezone,
    double lat,
    double lon,
    double costIndex,
    List<String> tags,
    String blurb) {}
