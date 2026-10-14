package com.travelduty.hotel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.matchesPattern;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.LocalDate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

@SpringBootTest
@AutoConfigureMockMvc
@AutoConfigureObservability(tracing = false)
@Import(TestClockConfig.class)
class HotelServiceTest {

  @Autowired MockMvc mvc;
  @Autowired ObjectMapper mapper;
  @Autowired MutableClock clock;

  @BeforeEach
  void resetClock() {
    clock.set(TestClockConfig.START);
  }

  @AfterEach
  void resetChaos() throws Exception {
    mvc.perform(delete("/admin/chaos")).andExpect(status().isOk());
  }

  // --- platform contract ---

  @Test
  void healthAndReady() throws Exception {
    mvc.perform(get("/health"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("ok"))
        .andExpect(jsonPath("$.service").value("hotel-service"))
        .andExpect(jsonPath("$.version").value("dev"))
        .andExpect(jsonPath("$.uptimeSeconds").isNumber());
    mvc.perform(get("/ready"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("ready"))
        .andExpect(jsonPath("$.checks").isMap());
  }

  @Test
  void metricsUseContractNamesAndRouteTemplates() throws Exception {
    mvc.perform(get("/hotels/search").param("city", "LIS").param("checkIn", "2026-11-02").param("checkOut", "2026-11-04"));
    mvc.perform(get("/holds/hh_doesnotexist"));
    mvc.perform(get("/metrics"))
        .andExpect(status().isOk())
        .andExpect(header().string("content-type", containsString("text/plain")))
        .andExpect(content().string(containsString("http_requests_total{")))
        .andExpect(content().string(containsString("route=\"/hotels/search\"")))
        .andExpect(content().string(containsString("route=\"/holds/{id}\"")))
        .andExpect(content().string(containsString("http_request_duration_seconds_bucket{")))
        .andExpect(content().string(containsString("service=\"hotel-service\"")));
  }

  @Test
  void requestIdIsEchoedOrGenerated() throws Exception {
    mvc.perform(get("/health").header("x-request-id", "trace-123"))
        .andExpect(header().string("x-request-id", "trace-123"));
    mvc.perform(get("/health"))
        .andExpect(header().string("x-request-id", matchesPattern("[0-9a-f-]{36}")));
    mvc.perform(get("/health").header("x-request-id", "x".repeat(129)))
        .andExpect(header().string("x-request-id", matchesPattern("[0-9a-f-]{36}")));
  }

  @Test
  void unknownRouteUsesErrorEnvelope() throws Exception {
    mvc.perform(get("/nope"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.error.code").value("NOT_FOUND"))
        .andExpect(jsonPath("$.error.message").isString());
  }

  @Test
  void chaosInjectsFailuresButNotOnOpsEndpoints() throws Exception {
    mvc.perform(put("/admin/chaos").contentType(MediaType.APPLICATION_JSON).content("{\"errorRate\":1,\"errorStatus\":500}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.errorRate").value(1.0))
        .andExpect(jsonPath("$.errorStatus").value(500))
        .andExpect(jsonPath("$.latencyMs").value(0));

    mvc.perform(get("/hotels").param("city", "LIS"))
        .andExpect(status().is(500))
        .andExpect(jsonPath("$.error.code").value("CHAOS_INJECTED"))
        .andExpect(jsonPath("$.error.message").value("Injected failure in hotel-service"));
    mvc.perform(get("/health")).andExpect(status().isOk());
    mvc.perform(get("/metrics")).andExpect(status().isOk());

    mvc.perform(get("/admin/chaos")).andExpect(jsonPath("$.errorRate").value(1.0));
    mvc.perform(delete("/admin/chaos")).andExpect(jsonPath("$.errorRate").value(0.0)).andExpect(jsonPath("$.errorStatus").value(503));
    mvc.perform(get("/hotels").param("city", "LIS")).andExpect(status().isOk());
  }

  @Test
  void chaosLatencyIsApplied() throws Exception {
    mvc.perform(put("/admin/chaos").contentType(MediaType.APPLICATION_JSON).content("{\"latencyMs\":150}"));
    long started = System.nanoTime();
    mvc.perform(get("/hotels").param("city", "LIS")).andExpect(status().isOk());
    assertThat(Duration.ofNanos(System.nanoTime() - started)).isGreaterThanOrEqualTo(Duration.ofMillis(150));
  }

  @Test
  void chaosUpdatesAreValidated() throws Exception {
    for (String body : new String[] {"{\"errorRate\":2}", "{\"latencyMs\":-1}", "{\"errorStatus\":200}", "{\"latencyMs\":60001}", "{\"errorRate\":\"lots\"}"}) {
      mvc.perform(put("/admin/chaos").contentType(MediaType.APPLICATION_JSON).content(body))
          .andExpect(status().isBadRequest())
          .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }
  }

  // --- hotel API ---

  @Test
  void listsEightHotelsPerCity() throws Exception {
    mvc.perform(get("/hotels").param("city", "lis"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.city").value("LIS"))
        .andExpect(jsonPath("$.items.length()").value(8))
        .andExpect(jsonPath("$.items[0].id").value("LIS-0"))
        .andExpect(jsonPath("$.items[0].amenities[0]").value("wifi"));
  }

  @Test
  void searchIsDeterministicAndSortedByTotal() throws Exception {
    String first = search("BCN", "2026-11-02", "2026-11-06", 2).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
    String second = search("BCN", "2026-11-02", "2026-11-06", 2).andReturn().getResponse().getContentAsString();
    assertThat(second).isEqualTo(first);

    JsonNode body = mapper.readTree(first);
    assertThat(body.get("nights").asInt()).isEqualTo(4);
    assertThat(body.get("count").asInt()).isEqualTo(body.get("items").size()).isBetween(1, 8);
    double previous = 0;
    for (JsonNode offer : body.get("items")) {
      assertThat(offer.get("roomsLeft").asInt()).isPositive();
      assertThat(offer.get("totalEur").asDouble()).isGreaterThanOrEqualTo(previous);
      assertThat(offer.get("id").asText()).matches("HT\\.BCN\\.\\d\\.2026-11-02\\.2026-11-06\\.2");
      previous = offer.get("totalEur").asDouble();
    }
  }

  @Test
  void searchValidatesInput() throws Exception {
    expectValidationError(get("/hotels/search").param("checkIn", "2026-11-02").param("checkOut", "2026-11-04"));
    expectValidationError(search("XXX", "2026-11-02", "2026-11-04", 1));
    expectValidationError(search("LIS", "2026-02-30", "2026-03-02", 1));
    expectValidationError(search("LIS", "02/11/2026", "2026-11-04", 1));
    expectValidationError(search("LIS", "2026-11-04", "2026-11-04", 1));
    expectValidationError(search("LIS", "2026-11-04", "2026-11-02", 1));
    expectValidationError(search("LIS", "2026-10-13", "2026-10-15", 1));
    expectValidationError(search("LIS", "2026-11-01", "2026-12-02", 1));
    expectValidationError(search("LIS", "2026-11-02", "2026-11-04", 0));
    expectValidationError(search("LIS", "2026-11-02", "2026-11-04", 7));
    expectValidationError(get("/hotels/search").param("city", "LIS").param("checkIn", "2026-11-02").param("checkOut", "2026-11-04").param("guests", "two"));
  }

  @Test
  void pricesWeekendNightsAndLargeParties() throws Exception {
    LocalDate friday = LocalDate.parse("2026-11-06");
    assertThat(friday.getDayOfWeek()).isEqualTo(DayOfWeek.FRIDAY);

    JsonNode offers = mapper.readTree(search("AMS", "2026-11-06", "2026-11-09", 2).andReturn().getResponse().getContentAsString()).get("items");
    JsonNode offer = offers.get(0);
    double base = offer.get("hotel").get("baseRateEur").asDouble();
    JsonNode nightly = offer.get("nightlyRatesEur");
    assertThat(nightly.size()).isEqualTo(3);
    assertThat(nightly.get(0).asDouble()).isEqualTo(round2(base * 1.15)); // Friday
    assertThat(nightly.get(1).asDouble()).isEqualTo(round2(base * 1.15)); // Saturday
    assertThat(nightly.get(2).asDouble()).isEqualTo(round2(base)); // Sunday
    double total = round2(nightly.get(0).asDouble() + nightly.get(1).asDouble() + nightly.get(2).asDouble());
    assertThat(offer.get("totalEur").asDouble()).isEqualTo(total);
    assertThat(offer.get("avgNightlyEur").asDouble()).isEqualTo(round2(total / 3));

    String hotelId = offer.get("hotel").get("id").asText();
    JsonNode bigParty = mapper.readTree(search("AMS", "2026-11-06", "2026-11-09", 3).andReturn().getResponse().getContentAsString()).get("items");
    for (JsonNode o : bigParty) {
      if (o.get("hotel").get("id").asText().equals(hotelId)) {
        assertThat(o.get("nightlyRatesEur").get(2).asDouble()).isEqualTo(round2(base * 1.4));
        assertThat(o.get("nightlyRatesEur").get(0).asDouble()).isEqualTo(round2(base * 1.15 * 1.4));
      }
    }
  }

  @Test
  void offerCanBeRederivedFromItsId() throws Exception {
    JsonNode offer = firstOffer("FCO", "2026-11-02", "2026-11-05", 1);
    String json = mvc.perform(get("/hotels/offers/" + offer.get("id").asText())).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
    assertThat(mapper.readTree(json)).isEqualTo(offer);
    mvc.perform(get("/hotels/offers/HT.FCO.99.2026-11-02.2026-11-05.1")).andExpect(status().isNotFound()).andExpect(jsonPath("$.error.code").value("NOT_FOUND"));
    mvc.perform(get("/hotels/offers/garbage")).andExpect(status().isNotFound());
  }

  @Test
  void holdConfirmFlow() throws Exception {
    JsonNode offer = firstOffer("LIS", "2026-11-02", "2026-11-06", 2);
    JsonNode hold = createHold(offer.get("id").asText(), null).andExpect(status().isCreated()).andReturnJson();
    String id = hold.get("id").asText();
    assertThat(id).matches("hh_[0-9a-f]{16}");
    assertThat(hold.get("status").asText()).isEqualTo("held");
    assertThat(hold.get("quantity").asInt()).isEqualTo(1);
    assertThat(hold.get("createdAt").asText()).isEqualTo("2026-10-14T09:00:00.000Z");
    assertThat(hold.get("expiresAt").asText()).isEqualTo("2026-10-14T09:15:00.000Z");
    assertThat(hold.get("offer")).isEqualTo(offer);
    assertThat(hold.has("confirmation")).isFalse();

    JsonNode confirmed = json(mvc.perform(post("/holds/" + id + "/confirm")).andExpect(status().isOk()));
    assertThat(confirmed.get("status").asText()).isEqualTo("confirmed");
    assertThat(confirmed.get("confirmedAt").asText()).isEqualTo("2026-10-14T09:00:00.000Z");
    String code = confirmed.get("confirmation").get("confirmationCode").asText();
    assertThat(code).matches("HTL-[A-HJ-NP-Z2-9]{6}");

    JsonNode again = json(mvc.perform(post("/holds/" + id + "/confirm")).andExpect(status().isOk()));
    assertThat(again.get("confirmation").get("confirmationCode").asText()).isEqualTo(code);
    mvc.perform(get("/holds/" + id)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("confirmed"));
  }

  @Test
  void holdsCountAgainstCapacityUntilSoldOut() throws Exception {
    JsonNode offer = firstOffer("KEF", "2026-11-10", "2026-11-12", 1);
    int rooms = offer.get("roomsLeft").asInt();
    String hotelId = offer.get("hotel").get("id").asText();
    createHold(offer.get("id").asText(), rooms).andExpect(status().isCreated());

    createHold(offer.get("id").asText(), 1).andExpect(status().isConflict())
        .andExpect(jsonPath("$.error.code").value("SOLD_OUT"))
        .andExpect(jsonPath("$.error.details.available").value(0));

    JsonNode after = mapper.readTree(search("KEF", "2026-11-10", "2026-11-12", 1).andReturn().getResponse().getContentAsString());
    for (JsonNode o : after.get("items")) assertThat(o.get("hotel").get("id").asText()).isNotEqualTo(hotelId);
  }

  @Test
  void holdRequestIsValidated() throws Exception {
    mvc.perform(post("/holds").contentType(MediaType.APPLICATION_JSON).content("{}"))
        .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    mvc.perform(post("/holds").contentType(MediaType.APPLICATION_JSON).content("not json"))
        .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    createHold("HT.LIS.0.2026-11-02.2026-11-04.1", 0).andExpect(status().isBadRequest());
    createHold("HT.LIS.0.2026-11-02.2026-11-04.1", 7).andExpect(status().isBadRequest());
    createHold("HT.NOPE", 1).andExpect(status().isNotFound()).andExpect(jsonPath("$.error.code").value("NOT_FOUND"));
  }

  @Test
  void expiredHoldsCannotBeConfirmedAndReleaseRooms() throws Exception {
    JsonNode offer = firstOffer("SYD", "2026-11-20", "2026-11-22", 1);
    int rooms = offer.get("roomsLeft").asInt();
    String id = createHold(offer.get("id").asText(), rooms).andReturnJson().get("id").asText();
    createHold(offer.get("id").asText(), 1).andExpect(status().isConflict());

    clock.advance(Duration.ofSeconds(900));
    mvc.perform(get("/holds/" + id)).andExpect(jsonPath("$.status").value("expired"));
    mvc.perform(post("/holds/" + id + "/confirm"))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.error.code").value("HOLD_EXPIRED"));
    createHold(offer.get("id").asText(), 1).andExpect(status().isCreated());
  }

  @Test
  void cancelIsIdempotentAndBlocksConfirmation() throws Exception {
    JsonNode offer = firstOffer("CPT", "2026-11-02", "2026-11-04", 1);
    String id = createHold(offer.get("id").asText(), 1).andReturnJson().get("id").asText();
    mvc.perform(delete("/holds/" + id)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"))
        .andExpect(jsonPath("$.cancelledAt").value("2026-10-14T09:00:00.000Z"));
    mvc.perform(delete("/holds/" + id)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"));
    mvc.perform(post("/holds/" + id + "/confirm"))
        .andExpect(status().isConflict()).andExpect(jsonPath("$.error.code").value("HOLD_CANCELLED"));

    // Cancelling a confirmed hold models a reservation cancellation.
    String other = createHold(offer.get("id").asText(), 1).andReturnJson().get("id").asText();
    mvc.perform(post("/holds/" + other + "/confirm")).andExpect(status().isOk());
    mvc.perform(delete("/holds/" + other)).andExpect(jsonPath("$.status").value("cancelled"));

    mvc.perform(delete("/holds/hh_unknown")).andExpect(status().isNotFound()).andExpect(jsonPath("$.error.code").value("NOT_FOUND"));
  }

  // --- helpers ---

  private ResultActions search(String city, String in, String out, int guests) throws Exception {
    return mvc.perform(get("/hotels/search").param("city", city).param("checkIn", in).param("checkOut", out).param("guests", String.valueOf(guests)));
  }

  private JsonNode firstOffer(String city, String in, String out, int guests) throws Exception {
    JsonNode items = json(search(city, in, out, guests).andExpect(status().isOk())).get("items");
    assertThat(items.size()).isPositive();
    return items.get(0);
  }

  private JsonResult createHold(String offerId, Integer rooms) throws Exception {
    String body = rooms == null
        ? mapper.writeValueAsString(java.util.Map.of("offerId", offerId))
        : mapper.writeValueAsString(java.util.Map.of("offerId", offerId, "rooms", rooms));
    return new JsonResult(mvc.perform(post("/holds").contentType(MediaType.APPLICATION_JSON).content(body)));
  }

  private void expectValidationError(org.springframework.test.web.servlet.RequestBuilder request) throws Exception {
    mvc.perform(request).andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
  }

  private void expectValidationError(ResultActions result) throws Exception {
    result.andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
  }

  private JsonNode json(ResultActions result) throws Exception {
    return mapper.readTree(result.andReturn().getResponse().getContentAsString());
  }

  private static double round2(double n) {
    return Math.round((n + Math.ulp(1.0)) * 100) / 100.0;
  }

  /** Small fluent wrapper so tests can chain expectations and then read the JSON body. */
  private final class JsonResult {
    private final ResultActions actions;

    JsonResult(ResultActions actions) {
      this.actions = actions;
    }

    JsonResult andExpect(org.springframework.test.web.servlet.ResultMatcher matcher) throws Exception {
      actions.andExpect(matcher);
      return this;
    }

    JsonNode andReturnJson() throws Exception {
      return json(actions);
    }
  }
}
