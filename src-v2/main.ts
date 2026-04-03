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

  const config = app.get(ConfigService);
  const origins = config.get<string>("CORS_ALLOWED_ORIGINS");
  if (origins) {
    app.enableCors({
      origin: origins.split(",").map((o) => o.trim()),
      credentials: true,
      methods: ["GET", "POST", "OPTIONS", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    });
  } else {
    app.enableCors();
  }

  const port = config.get<number>("PORT") || 3000;
  await app.listen(port, "0.0.0.0");
  console.log(`token-exchange-svc v2 listening on :${port}`);
}

bootstrap();
