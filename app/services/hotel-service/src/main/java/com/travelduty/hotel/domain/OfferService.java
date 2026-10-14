package com.travelduty.hotel.domain;

import com.travelduty.hotel.platform.ApiException;
import java.time.Clock;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Deterministic room offers. Offer ids encode every input
 * ({@code HT.<city>.<hotelIndex>.<checkIn>.<checkOut>.<guests>}), so an offer can be re-derived
 * from its id without storing searches.
 */
@Service
public class OfferService {
  static final int MAX_NIGHTS = 30;
  static final int MAX_GUESTS = 6;
  static final int MAX_ROOMS_PER_HOTEL = 6;
  private static final Pattern OFFER_ID =
      Pattern.compile("^HT\\.([A-Z]{3})\\.(\\d+)\\.(\\d{4}-\\d{2}-\\d{2})\\.(\\d{4}-\\d{2}-\\d{2})\\.(\\d+)$");

  public record Stay(Airport city, LocalDate checkIn, LocalDate checkOut, int guests) {
    public int nights() {
      return (int) ChronoUnit.DAYS.between(checkIn, checkOut);
    }
  }

  private final ReferenceData reference;
  private final HotelCatalog catalog;
  private final HoldStore holds;
  private final Clock clock;

  public OfferService(ReferenceData reference, HotelCatalog catalog, HoldStore holds, Clock clock) {
    this.reference = reference;
    this.catalog = catalog;
    this.holds = holds;
    this.clock = clock;
  }

  public Airport requireCity(String code) {
    return reference.find(code).orElseThrow(() -> ApiException.validation("Unknown city '" + code + "'"));
  }

  public Stay validateStay(String cityCode, String checkIn, String checkOut, int guests) {
    Airport city = requireCity(cityCode);
    LocalDate in = parseDate("checkIn", checkIn);
    LocalDate out = parseDate("checkOut", checkOut);
    if (in.isBefore(LocalDate.now(clock.withZone(ZoneOffset.UTC)))) {
      throw ApiException.validation("checkIn must not be in the past");
    }
    if (!out.isAfter(in)) throw ApiException.validation("checkOut must be after checkIn");
    if (ChronoUnit.DAYS.between(in, out) > MAX_NIGHTS) {
      throw ApiException.validation("Stays are limited to " + MAX_NIGHTS + " nights");
    }
    if (guests < 1 || guests > MAX_GUESTS) throw ApiException.validation("guests must be between 1 and " + MAX_GUESTS);
    return new Stay(city, in, out, guests);
  }

  /** Available offers for a stay, cheapest first; hotels with no rooms left are excluded. */
  public List<Offer> search(Stay stay) {
    List<Hotel> hotels = catalog.hotelsFor(stay.city());
    List<Offer> offers = new ArrayList<>();
    for (int i = 0; i < hotels.size(); i++) {
      Offer offer = build(stay, hotels.get(i), i);
      if (offer.roomsLeft() > 0) offers.add(offer);
    }
    offers.sort(Comparator.comparingDouble(Offer::totalEur));
    return offers;
  }

  /** Re-derives an offer from its id; empty if the id is malformed or no longer valid. */
  public Optional<Offer> find(String offerId) {
    Matcher m = OFFER_ID.matcher(offerId == null ? "" : offerId);
    if (!m.matches()) return Optional.empty();
    try {
      Stay stay = validateStay(m.group(1), m.group(3), m.group(4), Integer.parseInt(m.group(5)));
      int index = Integer.parseInt(m.group(2));
      List<Hotel> hotels = catalog.hotelsFor(stay.city());
      if (index >= hotels.size()) return Optional.empty();
      return Optional.of(build(stay, hotels.get(index), index));
    } catch (ApiException | NumberFormatException e) {
      return Optional.empty();
    }
  }

  public Hold hold(String offerId, int rooms) {
    Offer offer = find(offerId).orElseThrow(() -> ApiException.notFound("Offer " + offerId + " not found"));
    return holds.create(offer, rooms, capacity(offer.hotel(), offer.checkIn()));
  }

  /** Seeded room capacity (0–6) for a hotel on a check-in date, before any holds. */
  static int capacity(Hotel hotel, String checkIn) {
    return Rng.seeded(hotel.id() + "-" + checkIn).nextInt(MAX_ROOMS_PER_HOTEL + 1);
  }

  private Offer build(Stay stay, Hotel hotel, int index) {
    String checkIn = stay.checkIn().toString();
    int roomsLeft = Math.max(0, capacity(hotel, checkIn) - holds.reserved(hotel.id() + "-" + checkIn));
    List<Double> nightly = new ArrayList<>();
    double total = 0;
    for (LocalDate night = stay.checkIn(); night.isBefore(stay.checkOut()); night = night.plusDays(1)) {
      double rate = hotel.baseRateEur();
      if (night.getDayOfWeek() == DayOfWeek.FRIDAY || night.getDayOfWeek() == DayOfWeek.SATURDAY) rate *= 1.15;
      if (stay.guests() > 2) rate *= 1.4;
      rate = Rng.round2(rate);
      nightly.add(rate);
      total += rate;
    }
    int nights = stay.nights();
    double totalEur = Rng.round2(total);
    String id = String.format("HT.%s.%d.%s.%s.%d", stay.city().code(), index, checkIn, stay.checkOut(), stay.guests());
    return new Offer(id, hotel, stay.city().code(), checkIn, stay.checkOut().toString(), nights, stay.guests(),
        roomsLeft, List.copyOf(nightly), Rng.round2(totalEur / nights), totalEur);
  }

  private static LocalDate parseDate(String field, String value) {
    try {
      return LocalDate.parse(value);
    } catch (DateTimeParseException | NullPointerException e) {
      throw ApiException.validation(field + " must be a valid YYYY-MM-DD date");
    }
  }
}
