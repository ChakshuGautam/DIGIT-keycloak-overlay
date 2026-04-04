import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";

describe("Diag", () => {
  it("can import nestjs testing", () => {
    expect(Test).toBeDefined();
    expect(FastifyAdapter).toBeDefined();
  });
});
