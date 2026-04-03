import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MetricsService } from "../metrics/metrics.service";

@Injectable()
export class KcAdminService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KcAdminService.name);
  private adminToken: string | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const syncEnabled = this.config.get<string>("TENANT_SYNC_ENABLED");
    if (syncEnabled === "true") {
      await this.initWithRetry();
    }
  }

  onModuleDestroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  async initWithRetry(
    maxRetries = 10,
    baseDelayMs = 2000,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.acquireToken();
        this.logger.log(`Admin token acquired on attempt ${attempt}`);
        this.startRefresh();
        return;
      } catch (err) {
        this.logger.warn(
          `Token acquire attempt ${attempt}/${maxRetries} failed: ${(err as Error).message}`,
        );
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    this.logger.error("All retry attempts exhausted");
  }

  private async acquireToken(): Promise<void> {
    const url = `${this.config.get("KEYCLOAK_ADMIN_URL")}/realms/${this.config.get("KEYCLOAK_ADMIN_REALM")}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: this.config.get("KEYCLOAK_ADMIN_CLIENT_ID")!,
      username: this.config.get("KEYCLOAK_ADMIN_USERNAME")!,
      password: this.config.get("KEYCLOAK_ADMIN_PASSWORD")!,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      this.metrics.tokenRefreshTotal.inc({
        token_type: "kc-admin",
        result: "error",
      });
      throw new Error(`Token request failed: ${res.status}`);
    }

    const data = await res.json();
    this.adminToken = data.access_token;
    this.metrics.tokenRefreshTotal.inc({
      token_type: "kc-admin",
      result: "success",
    });
  }

  private startRefresh(): void {
    this.refreshInterval = setInterval(async () => {
      try {
        await this.acquireToken();
      } catch (err) {
        this.metrics.tokenRefreshTotal.inc({
          token_type: "kc-admin",
          result: "error",
        });
        this.logger.warn(
          `Token refresh failed: ${(err as Error).message}`,
        );
      }
    }, 50_000);
  }

  hasAdminToken(): boolean {
    return this.adminToken !== null;
  }

  getAdminToken(): string {
    return this.adminToken ?? "";
  }

  parseTenantConfig(tenantStr: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const entries = tenantStr.split(";");
    for (const entry of entries) {
      const [realm, tenantsStr] = entry.split(":");
      if (realm && tenantsStr) {
        result.set(realm, tenantsStr.split(","));
      }
    }
    return result;
  }

  async syncTenantRealms(): Promise<void> {
    if (!this.adminToken) {
      this.logger.warn("No admin token — skipping tenant realm sync");
      return;
    }
    const tenantStr = this.config.get<string>("DIGIT_TENANTS") ?? "";
    const tenants = this.parseTenantConfig(tenantStr);
    for (const [realm, tenantIds] of tenants) {
      this.logger.log(
        `Syncing realm "${realm}" with tenants: ${tenantIds.join(", ")}`,
      );
    }
  }
}
