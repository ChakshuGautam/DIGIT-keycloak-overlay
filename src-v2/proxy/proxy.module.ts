import { Module } from "@nestjs/common";
import { ProxyController } from "./proxy.controller";
import { ProxyService } from "./proxy.service";
import { KeycloakModule } from "../keycloak/keycloak.module";

@Module({
  imports: [KeycloakModule],
  controllers: [ProxyController],
  providers: [ProxyService],
})
export class ProxyModule {}
