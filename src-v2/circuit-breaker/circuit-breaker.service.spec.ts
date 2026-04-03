import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreakerService } from "./circuit-breaker.service.js";

describe("CircuitBreakerService", () => {
  let service: CircuitBreakerService;

  beforeEach(() => {
    service = new CircuitBreakerService();
  });

  it("allows calls when circuit is closed", async () => {
    const result = await service.exec("test", async () => "ok");
    expect(result).toBe("ok");
    expect(service.getState("test")).toBe("closed");
  });

  it("opens circuit after threshold failures", async () => {
    const failing = () => Promise.reject(new Error("boom"));

    for (let i = 0; i < 5; i++) {
      await expect(service.exec("test", failing)).rejects.toThrow("boom");
    }

    expect(service.getState("test")).toBe("open");

    // Next call should be rejected by the circuit breaker itself
    await expect(service.exec("test", async () => "ok")).rejects.toThrow(
      "Circuit test is OPEN — rejecting request",
    );
  });

  it("transitions to half-open after reset timeout", async () => {
    const failing = () => Promise.reject(new Error("boom"));

    // Trip the circuit
    for (let i = 0; i < 5; i++) {
      await expect(service.exec("test", failing)).rejects.toThrow("boom");
    }
    expect(service.getState("test")).toBe("open");

    // Simulate that the reset timeout has elapsed
    const circuit = (service as any).circuits.get("test");
    circuit.nextAttempt = Date.now() - 1;

    // Next call should transition to half-open and attempt the function
    // If fn succeeds, circuit closes
    await expect(service.exec("test", failing)).rejects.toThrow("boom");
    expect(service.getState("test")).toBe("open");
  });

  it("closes circuit on success after half-open", async () => {
    const failing = () => Promise.reject(new Error("boom"));

    // Trip the circuit
    for (let i = 0; i < 5; i++) {
      await expect(service.exec("test", failing)).rejects.toThrow("boom");
    }
    expect(service.getState("test")).toBe("open");

    // Simulate that the reset timeout has elapsed
    const circuit = (service as any).circuits.get("test");
    circuit.nextAttempt = Date.now() - 1;

    // Successful call should close the circuit
    const result = await service.exec("test", async () => "recovered");
    expect(result).toBe("recovered");
    expect(service.getState("test")).toBe("closed");
  });

  it("reports state as numeric gauge", async () => {
    // Closed = 0
    expect(service.getStateNumeric("test")).toBe(0);

    const failing = () => Promise.reject(new Error("boom"));

    // Trip the circuit to open
    for (let i = 0; i < 5; i++) {
      await expect(service.exec("test", failing)).rejects.toThrow("boom");
    }

    // Open = 2
    expect(service.getStateNumeric("test")).toBe(2);

    // Simulate half-open
    const circuit = (service as any).circuits.get("test");
    circuit.status = "half-open";

    // Half-open = 1
    expect(service.getStateNumeric("test")).toBe(1);
  });
});
