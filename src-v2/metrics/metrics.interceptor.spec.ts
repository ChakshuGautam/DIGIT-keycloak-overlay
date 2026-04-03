import { describe, it, expect, beforeEach, vi } from "vitest";
import { MetricsInterceptor } from "./metrics.interceptor";
import { MetricsService } from "./metrics.service";
import { of, throwError } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";

function createMockContext(method = "GET", url = "/test"): ExecutionContext {
  const request = { method, url };
  const response = { statusCode: 200 };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function createMockCallHandler(value: any = {}): CallHandler {
  return { handle: () => of(value) };
}

function createErrorCallHandler(err: Error): CallHandler {
  return { handle: () => throwError(() => err) };
}

describe("MetricsInterceptor", () => {
  let interceptor: MetricsInterceptor;
  let metricsService: MetricsService;

  beforeEach(() => {
    metricsService = new MetricsService();
    interceptor = new MetricsInterceptor(metricsService);
  });

  it("increments counter and observes duration on success", async () => {
    const incSpy = vi.spyOn(metricsService.httpRequestsTotal, "inc");
    const timerSpy = vi.spyOn(metricsService.httpRequestDuration, "startTimer");

    const context = createMockContext("GET", "/test");
    const handler = createMockCallHandler({ ok: true });

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve, reject) => {
      result$.subscribe({
        next: () => {},
        complete: () => {
          expect(timerSpy).toHaveBeenCalled();
          expect(incSpy).toHaveBeenCalledWith({ method: "GET", path: "/test", status: "200" });
          resolve();
        },
        error: reject,
      });
    });
  });

  it("increments counter with status 500 on error", async () => {
    const incSpy = vi.spyOn(metricsService.httpRequestsTotal, "inc");

    const context = createMockContext("POST", "/fail");
    const handler = createErrorCallHandler(new Error("boom"));

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        error: () => {
          expect(incSpy).toHaveBeenCalledWith({ method: "POST", path: "/fail", status: "500" });
          resolve();
        },
      });
    });
  });
});
