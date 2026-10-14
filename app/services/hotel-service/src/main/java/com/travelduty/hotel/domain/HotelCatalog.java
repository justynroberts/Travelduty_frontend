package com.travelduty.hotel.domain;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/** Eight fictional hotels per city, generated deterministically from the city code. */
@Component
public class HotelCatalog {
  static final int HOTELS_PER_CITY = 8;

  private static final List<String> NAME_TEMPLATES = List.of(
      "%s Central Suites",
      "Hotel %2$s %1$s",
      "The %2$s House",
      "%s Riverside Lodge",
      "Casa %2$s",
      "%s Skyline Hotel",
      "Old Town Inn %s",
      "%2$s Boutique Rooms");
  private static final List<String> FLAVOURS = List.of(
      "Aurelia", "Linden", "Harbour", "Saffron", "Juniper", "Cobalt", "Willow", "Orchid", "Granite", "Solstice");
  private static final List<String> NEIGHBOURHOODS = List.of(
      "Old Town", "Waterfront", "Business District", "Arts Quarter", "University Quarter", "Riverside",
      "Station Quarter", "Market District");
  private static final List<String> OPTIONAL_AMENITIES = List.of(
      "breakfast", "pool", "gym", "spa", "parking", "airport-shuttle", "bar", "restaurant", "pet-friendly");

  private final Map<String, List<Hotel>> cache = new ConcurrentHashMap<>();

  public List<Hotel> hotelsFor(Airport city) {
    return cache.computeIfAbsent(city.code(), code -> generate(city));
  }

  private static List<Hotel> generate(Airport city) {
    Rng rng = Rng.seeded(city.code());
    List<Hotel> hotels = new ArrayList<>(HOTELS_PER_CITY);
    for (int i = 0; i < HOTELS_PER_CITY; i++) {
      String flavour = rng.pick(FLAVOURS);
      int stars = 2 + rng.nextInt(4);
      double rating = Math.round((6.5 + rng.next() * 3.2) * 10) / 10.0;
      String neighbourhood = rng.pick(NEIGHBOURHOODS);
      List<String> amenities = new ArrayList<>();
      amenities.add("wifi");
      for (String amenity : OPTIONAL_AMENITIES) {
        if (rng.next() < 0.45) amenities.add(amenity);
      }
      double baseRate = Rng.round2(45 * Math.pow(stars, 1.25) * city.costIndex() * (0.85 + rng.next() * 0.4));
      String name = String.format(NAME_TEMPLATES.get(i), city.city(), flavour);
      hotels.add(new Hotel(city.code() + "-" + i, name, stars, rating, neighbourhood, List.copyOf(amenities), baseRate));
    }
    return List.copyOf(hotels);
  }
}
