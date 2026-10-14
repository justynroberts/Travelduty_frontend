package com.travelduty.hotel.domain;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

/** Immutable snapshot of a hold, as serialised to clients (contract §1 "Holds"). */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Hold(
    String id,
    String status,
    Offer offer,
    int quantity,
    String createdAt,
    String expiresAt,
    String confirmedAt,
    String cancelledAt,
    Map<String, String> confirmation) {}
