package com.travelduty.hotel;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = "travelduty.admin-token=s3cret")
@AutoConfigureMockMvc
@AutoConfigureObservability(tracing = false)
class AdminTokenTest {

  @Autowired MockMvc mvc;

  @Test
  void adminEndpointsRequireTokenWhenConfigured() throws Exception {
    mvc.perform(get("/admin/chaos"))
        .andExpect(status().isUnauthorized())
        .andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"));
    mvc.perform(put("/admin/chaos").header("x-admin-token", "wrong").contentType(MediaType.APPLICATION_JSON).content("{\"latencyMs\":1}"))
        .andExpect(status().isUnauthorized());
    mvc.perform(get("/admin/chaos").header("x-admin-token", "s3cret"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.errorStatus").value(503));
  }
}
