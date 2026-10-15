package com.travelduty.hotel.domain;

import com.travelduty.hotel.platform.ApiException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * In-memory room reservations. The booking saga holds a room, takes payment, then confirms the
 * hold — or cancels it if a later step fails. Held and confirmed rooms count against capacity.
 */
@Component
public class HoldStore {
  private static final DateTimeFormatter ISO_MILLIS =
      DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);
  private static final String CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  private static final class Entry {
    final String id;
    final Offer offer;
    final int quantity;
    final Instant createdAt;
    final Instant expiresAt;
    String status = "held";
    Instant confirmedAt;
    Instant cancelledAt;
    String confirmationCode;

    Entry(String id, Offer offer, int quantity, Instant createdAt, Instant expiresAt) {
      this.id = id;
      this.offer = offer;
      this.quantity = quantity;
      this.createdAt = createdAt;
      this.expiresAt = expiresAt;
    }
  }

  private final Map<String, Entry> holds = new HashMap<>();
  private final Clock clock;
  private final long ttlSeconds;
  private final SecureRandom random = new SecureRandom();

  public HoldStore(Clock clock, @Value("${travelduty.hold-ttl-seconds}") long ttlSeconds) {
    this.clock = clock;
    this.ttlSeconds = ttlSeconds;
  }

  /** Rooms currently held or confirmed against an inventory key. */
  public synchronized int reserved(String inventoryKey) {
    int total = 0;
    for (Entry e : holds.values()) {
      expireIfDue(e);
      if (("held".equals(e.status) || "confirmed".equals(e.status)) && e.offer.inventoryKey().equals(inventoryKey)) {
        total += e.quantity;
      }
    }
    return total;
  }

  /** Atomically checks availability and creates the hold. */
  public synchronized Hold create(Offer offer, int rooms, int capacity) {
    int available = capacity - reserved(offer.inventoryKey());
    if (rooms > available) {
      int left = Math.max(available, 0);
      throw ApiException.conflict("SOLD_OUT", "Only " + left + " rooms left", Map.of("available", left));
    }
    Instant now = clock.instant();
    String id = "hh_" + HexFormat.of().formatHex(randomBytes(8));
    Entry e = new Entry(id, offer, rooms, now, now.plusSeconds(ttlSeconds));
    holds.put(id, e);
    return view(e);
  }

  public synchronized Hold get(String id) {
    return view(require(id));
  }

  public synchronized Hold confirm(String id) {
    Entry e = require(id);
    switch (e.status) {
      case "confirmed" -> {
        return view(e);
      }
      case "expired" -> throw ApiException.conflict(
          "HOLD_EXPIRED", "Hold " + id + " expired at " + ISO_MILLIS.format(e.expiresAt), null);
      case "cancelled" -> throw ApiException.conflict("HOLD_CANCELLED", "Hold " + id + " was cancelled", null);
      default -> {
        e.status = "confirmed";
        e.confirmedAt = clock.instant();
        e.confirmationCode = "HTL-" + randomCode(6);
        return view(e);
      }
    }
  }

  /** Idempotent; cancelling a confirmed hold models a reservation cancellation. */
  public synchronized Hold cancel(String id) {
    Entry e = require(id);
    if ("held".equals(e.status) || "confirmed".equals(e.status)) {
      e.status = "cancelled";
      e.cancelledAt = clock.instant();
    }
    return view(e);
  }

  /**
   * Deletes holds that finished (cancelled, or expired unconfirmed) before the cutoff and returns
   * how many went. Finished holds no longer count against capacity, so availability is unchanged.
   */
  public synchronized int prune(Instant cutoff) {
    int before = holds.size();
    holds.values().removeIf(e -> {
      expireIfDue(e);
      Instant finished = switch (e.status) {
        case "cancelled" -> e.cancelledAt;
        case "expired" -> e.expiresAt;
        default -> null;
      };
      return finished != null && finished.isBefore(cutoff);
    });
    return before - holds.size();
  }

  public synchronized int size() {
    return holds.size();
  }

  private Entry require(String id) {
    Entry e = holds.get(id);
    if (e == null) throw ApiException.notFound("Hold " + id + " not found");
    expireIfDue(e);
    return e;
  }

  private void expireIfDue(Entry e) {
    if ("held".equals(e.status) && !clock.instant().isBefore(e.expiresAt)) e.status = "expired";
  }

  private Hold view(Entry e) {
    return new Hold(
        e.id,
        e.status,
        e.offer,
        e.quantity,
        ISO_MILLIS.format(e.createdAt),
        ISO_MILLIS.format(e.expiresAt),
        e.confirmedAt == null ? null : ISO_MILLIS.format(e.confirmedAt),
        e.cancelledAt == null ? null : ISO_MILLIS.format(e.cancelledAt),
        e.confirmationCode == null ? null : Map.of("confirmationCode", e.confirmationCode));
  }

  private byte[] randomBytes(int n) {
    byte[] bytes = new byte[n];
    random.nextBytes(bytes);
    return bytes;
  }

  private String randomCode(int length) {
    StringBuilder sb = new StringBuilder(length);
    for (int i = 0; i < length; i++) sb.append(CODE_ALPHABET.charAt(random.nextInt(CODE_ALPHABET.length())));
    return sb.toString();
  }
}
