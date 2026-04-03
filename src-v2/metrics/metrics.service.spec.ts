import { describe, it, expect, beforeEach } from "vitest";
import { MetricsService } from "./metrics.service";

describe("MetricsService", () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  it("increments http request counter without throwing", () => {
    expect(() => {
      service.httpRequestsTotal.inc({ method: "GET", path: "/test", status: "200" });
    }).not.toThrow();
  });

  it("observes http request duration without throwing", () => {
    expect(() => {
      const end = service.httpRequestDuration.startTimer({ method: "GET", path: "/test" });
      end();
    }).not.toThrow();
  });

  it("exposes registry with all metric names", async () => {
    const output = await service.getMetrics();

    expect(output).toContain("tes_http_requests_total");
    expect(output).toContain("tes_http_request_duration_seconds");
    expect(output).toContain("tes_jwt_validation_total");
    expect(output).toContain("tes_cache_ops_total");
    expect(output).toContain("tes_user_provision_total");
    expect(output).toContain("tes_circuit_breaker_state");
    expect(output).toContain("tes_token_refresh_total");
    expect(output).toContain("tes_role_sync_total");
  });
});
