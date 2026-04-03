import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  let controller: HealthController;
  let mockCache: {
    ping: ReturnType<typeof vi.fn>;
    isRedisHealthy: ReturnType<typeof vi.fn>;
  };
  let mockCircuit: {
    getAllStates: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockCache = {
      ping: vi.fn().mockResolvedValue(true),
      isRedisHealthy: vi.fn().mockReturnValue(true),
    };
    mockCircuit = {
      getAllStates: vi.fn().mockReturnValue({ "egov-user": "closed" }),
    };

    controller = new HealthController(mockCache as any, mockCircuit as any);
  });

  it("/healthz returns ok", async () => {
    const result = await controller.liveness();
    expect(result).toEqual({ status: "ok" });
  });

  it("/readyz returns ok when all healthy", async () => {
    const result = await controller.readiness();
    expect(result).toEqual({
      status: "ok",
      redis: "connected",
      circuits: { "egov-user": "closed" },
    });
  });

  it("/readyz returns degraded when redis down", async () => {
    mockCache.ping.mockResolvedValue(false);
    mockCache.isRedisHealthy.mockReturnValue(false);

    await expect(controller.readiness()).rejects.toThrow(HttpException);

    try {
      await controller.readiness();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      const response = (e as HttpException).getResponse();
      expect(response).toEqual({
        status: "degraded",
        redis: "disconnected",
      });
      expect((e as HttpException).getStatus()).toBe(503);
    }
  });

  it("/debug/status returns internal state", async () => {
    const result = await controller.debugStatus();
    expect(result).toHaveProperty("redis", true);
    expect(result).toHaveProperty("circuits", { "egov-user": "closed" });
    expect(result).toHaveProperty("uptime");
    expect(typeof result.uptime).toBe("number");
    expect(result).toHaveProperty("memory");
    expect(result.memory).toHaveProperty("rss");
    expect(result.memory).toHaveProperty("heapUsed");
  });
});
