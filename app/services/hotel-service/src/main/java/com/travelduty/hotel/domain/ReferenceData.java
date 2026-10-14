package com.travelduty.hotel.domain;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Loads the shared {@code data/airports.json} from REFERENCE_DATA_DIR at startup. */
@Component
public class ReferenceData {
  private static final Logger log = LoggerFactory.getLogger(ReferenceData.class);

  private final Map<String, Airport> byCode = new LinkedHashMap<>();

  public ReferenceData(@Value("${travelduty.reference-data-dir}") String dir, ObjectMapper mapper) throws IOException {
    Path file = Path.of(dir, "airports.json").toAbsolutePath().normalize();
    List<Airport> airports = mapper.readValue(Files.readString(file), new TypeReference<>() {});
    airports.forEach(a -> byCode.put(a.code(), a));
    log.info("loaded {} destinations from {}", byCode.size(), file);
  }

  public Optional<Airport> find(String code) {
    return code == null ? Optional.empty() : Optional.ofNullable(byCode.get(code.toUpperCase(Locale.ROOT)));
  }
}
