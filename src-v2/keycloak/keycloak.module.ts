import { Module } from "@nestjs/common";
import { KcAdminService } from "./kc-admin.service";
import { KcSyncService } from "./kc-sync.service";

@Module({
  providers: [KcAdminService, KcSyncService],
  exports: [KcAdminService, KcSyncService],
})
export class KeycloakModule {}
