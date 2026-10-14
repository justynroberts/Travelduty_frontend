package com.travelduty.hotel.web;

import com.travelduty.hotel.domain.Airport;
import com.travelduty.hotel.domain.Hold;
import com.travelduty.hotel.domain.HoldStore;
import com.travelduty.hotel.domain.HotelCatalog;
import com.travelduty.hotel.domain.Offer;
import com.travelduty.hotel.domain.OfferService;
import com.travelduty.hotel.platform.ApiException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HotelController {
  private final OfferService offers;
  private final HotelCatalog catalog;
  private final HoldStore holds;

  public HotelController(OfferService offers, HotelCatalog catalog, HoldStore holds) {
    this.offers = offers;
    this.catalog = catalog;
    this.holds = holds;
  }

  @GetMapping("/hotels")
  Map<String, Object> hotels(@RequestParam String city) {
    Airport a = offers.requireCity(city);
    return Map.of("city", a.code(), "items", catalog.hotelsFor(a));
  }

  @GetMapping("/hotels/search")
  Map<String, Object> search(
      @RequestParam String city,
      @RequestParam String checkIn,
      @RequestParam String checkOut,
      @RequestParam(defaultValue = "1") int guests) {
    OfferService.Stay stay = offers.validateStay(city, checkIn, checkOut, guests);
    List<Offer> items = offers.search(stay);
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("city", stay.city().code());
    body.put("checkIn", stay.checkIn().toString());
    body.put("checkOut", stay.checkOut().toString());
    body.put("nights", stay.nights());
    body.put("guests", stay.guests());
    body.put("count", items.size());
    body.put("items", items);
    return body;
  }

  @GetMapping("/hotels/offers/{offerId}")
  Offer offer(@PathVariable String offerId) {
    return offers.find(offerId).orElseThrow(() -> ApiException.notFound("Offer " + offerId + " not found"));
  }

  public record HoldRequest(@NotBlank String offerId, @Min(1) @Max(6) Integer rooms) {}

  @PostMapping("/holds")
  @ResponseStatus(HttpStatus.CREATED)
  Hold createHold(@Valid @RequestBody HoldRequest req) {
    return offers.hold(req.offerId(), req.rooms() == null ? 1 : req.rooms());
  }

  @GetMapping("/holds/{id}")
  Hold getHold(@PathVariable String id) {
    return holds.get(id);
  }

  @PostMapping("/holds/{id}/confirm")
  Hold confirm(@PathVariable String id) {
    return holds.confirm(id);
  }

  @DeleteMapping("/holds/{id}")
  Hold cancel(@PathVariable String id) {
    return holds.cancel(id);
  }
}
