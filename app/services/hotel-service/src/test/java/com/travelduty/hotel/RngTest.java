package com.travelduty.hotel;

import static org.assertj.core.api.Assertions.assertThat;

import com.travelduty.hotel.domain.Rng;
import org.junit.jupiter.api.Test;

/** Reference values produced by the JavaScript implementation, so seeding matches across languages. */
class RngTest {

  @Test
  void fnv1aMatchesJavaScript() {
    assertThat(Integer.toUnsignedLong(Rng.fnv1a("LIS"))).isEqualTo(2250699151L);
    assertThat(Integer.toUnsignedLong(Rng.fnv1a("LHR-LIS-2026-11-02-economy"))).isEqualTo(1474013850L);
  }

  @Test
  void mulberry32MatchesJavaScript() {
    Rng a = Rng.seeded("LIS");
    assertThat(a.next()).isEqualTo(0.8088932905811816);
    assertThat(a.next()).isEqualTo(0.6161138054449111);
    assertThat(a.next()).isEqualTo(0.6937944612000138);

    Rng b = Rng.seeded("LHR-LIS-2026-11-02-economy");
    assertThat(b.next()).isEqualTo(0.67204211326316);
    assertThat(b.next()).isEqualTo(0.07595136086456478);
    assertThat(b.next()).isEqualTo(0.30505932960659266);
  }

  @Test
  void round2MatchesJavaScript() {
    assertThat(Rng.round2(163.875)).isEqualTo(163.88);
    assertThat(Rng.round2(1.005)).isEqualTo(1.01);
    assertThat(Rng.round2(142.5)).isEqualTo(142.5);
  }
}
