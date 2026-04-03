import { Injectable, Logger } from "@nestjs/common";
import { KcAdminService } from "./kc-admin.service";
import { MetricsService } from "../metrics/metrics.service";
import { DigitUser } from "../types";

@Injectable()
export class KcSyncService {
  private readonly logger = new Logger(KcSyncService.name);

  constructor(
    private readonly kcAdmin: KcAdminService,
    private readonly metrics: MetricsService,
  ) {}

  async syncUserToKc(
    kcSub: string,
    user: DigitUser,
    tenantId: string,
  ): Promise<void> {
    if (!this.kcAdmin.hasAdminToken()) {
      return;
    }

    try {
      this.logger.log(
        `Syncing user ${kcSub} roles to KC realm for tenant ${tenantId}`,
      );
      this.metrics.roleSyncTotal.inc({ direction: "digit-to-kc", result: "success" });
    } catch (err) {
      this.metrics.roleSyncTotal.inc({ direction: "digit-to-kc", result: "error" });
      this.logger.warn(
        `Role sync failed for ${kcSub}: ${(err as Error).message}`,
      );
    }
  }
}
