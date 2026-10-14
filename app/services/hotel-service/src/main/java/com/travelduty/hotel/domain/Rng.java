package com.travelduty.hotel.domain;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * The contract's cross-language seeding scheme: 32-bit FNV-1a + mulberry32. Java's int overflow
 * matches JavaScript's {@code Math.imul}, so the same seed yields the same sequence in every service.
 */
public final class Rng {
  private int state;

  private Rng(int seed) {
    this.state = seed;
  }

  public static int fnv1a(String input) {
    int h = 0x811c9dc5;
    for (byte b : input.getBytes(StandardCharsets.UTF_8)) {
      h ^= (b & 0xff);
      h *= 0x01000193;
    }
    return h;
  }

  public static Rng seeded(String seed) {
    return new Rng(fnv1a(seed));
  }

  /** Next float in [0, 1). */
  public double next() {
    state += 0x6d2b79f5;
    int t = state;
    t = (t ^ (t >>> 15)) * (t | 1);
    t ^= t + (t ^ (t >>> 7)) * (t | 61);
    return ((t ^ (t >>> 14)) & 0xffffffffL) / 4294967296.0;
  }

  public int nextInt(int boundExclusive) {
    return (int) Math.floor(next() * boundExclusive);
  }

  public <T> T pick(List<T> items) {
    return items.get(nextInt(items.size()));
  }

  /** Same rounding as the TypeScript services: {@code Math.round((n + EPSILON) * 100) / 100}. */
  public static double round2(double n) {
    return Math.round((n + Math.ulp(1.0)) * 100) / 100.0;
  }
}
