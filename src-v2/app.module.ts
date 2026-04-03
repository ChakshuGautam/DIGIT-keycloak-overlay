import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { CircuitBreakerModule } from "./circuit-breaker/circuit-breaker.module";

@Module({
  imports: [AppConfigModule, CircuitBreakerModule],
})
export class AppModule {}
