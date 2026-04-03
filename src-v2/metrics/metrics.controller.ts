import { Controller, Get, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { MetricsService } from "./metrics.service";

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get("metrics")
  async getMetrics(@Res() reply: FastifyReply) {
    reply.header("Content-Type", this.metrics.getContentType());
    reply.send(await this.metrics.getMetrics());
  }
}
