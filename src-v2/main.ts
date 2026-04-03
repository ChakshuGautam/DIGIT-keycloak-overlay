import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.enableShutdownHooks();

  // NestJS Fastify adapter auto-registers JSON + URL-encoded parsers

  // CORS handled via middleware in proxy controller to avoid
  // Fastify route conflict with @All("*") wildcard handler
  const config = app.get(ConfigService);

  const port = config.get<number>("PORT") || 3000;
  await app.listen(port, "0.0.0.0");
  console.log(`token-exchange-svc v2 listening on :${port}`);
}

bootstrap();
