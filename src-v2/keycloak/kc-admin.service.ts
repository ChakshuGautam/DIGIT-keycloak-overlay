import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MetricsService } from "../metrics/metrics.service";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface KcGroup {
  id: string;
  name: string;
  path: string;
}

@Injectable()
export class KcAdminService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KcAdminService.name);
  private adminToken: string | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly kcAdminUrl: string;
  private readonly adminRealm: string;
  private readonly adminClientId: string;
  private readonly adminUsername: string;
  private readonly adminPassword: string;
  private realmTemplate: string = "";

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.kcAdminUrl = config.get("KEYCLOAK_ADMIN_URL") || "http://localhost:8180";
    this.adminRealm = config.get("KEYCLOAK_ADMIN_REALM") || "master";
    this.adminClientId = config.get("KEYCLOAK_ADMIN_CLIENT_ID") || "admin-cli";
    this.adminUsername = config.get("KEYCLOAK_ADMIN_USERNAME") || "admin";
    this.adminPassword = config.get("KEYCLOAK_ADMIN_PASSWORD") || "admin";

    // Load realm template
    try {
      const templatePath = join(process.cwd(), "keycloak", "realm-template.json");
      this.realmTemplate = readFileSync(templatePath, "utf-8");
    } catch {
      this.logger.warn("realm-template.json not found — realm creation will be skipped");
    }
  }

  async onModuleInit(): Promise<void> {
    const syncEnabled = this.config.get("TENANT_SYNC_ENABLED");
    if (syncEnabled === true || syncEnabled === "true") {
      await this.initWithRetry();
      if (this.adminToken) {
        await this.syncTenantRealms();
      }
    }
  }

  onModuleDestroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async initWithRetry(maxRetries = 10, baseDelayMs = 2000): Promise<void> {
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
    this.logger.error("All retry attempts exhausted — KC admin features unavailable");
  }

  private async acquireToken(): Promise<void> {
    const url = `${this.kcAdminUrl}/realms/${this.adminRealm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: this.adminClientId,
      username: this.adminUsername,
      password: this.adminPassword,
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      this.metrics.tokenRefreshTotal.inc({ token_type: "kc-admin", result: "error" });
      throw new Error(`Token request failed: ${resp.status}`);
    }

    const data = await resp.json();
    this.adminToken = data.access_token;
    this.metrics.tokenRefreshTotal.inc({ token_type: "kc-admin", result: "success" });
  }

  private startRefresh(): void {
    this.refreshInterval = setInterval(async () => {
      try {
        await this.acquireToken();
      } catch (err) {
        this.logger.warn(`Token refresh failed: ${(err as Error).message}`);
      }
    }, 50_000);
  }

  hasAdminToken(): boolean {
    return this.adminToken !== null;
  }

  getAdminToken(): string {
    return this.adminToken ?? "";
  }

  private authHeaders(): Record<string, string> {
    if (!this.adminToken) throw new Error("KC admin token not initialized");
    return {
      Authorization: `Bearer ${this.adminToken}`,
      "Content-Type": "application/json",
    };
  }

  // ── Realm ─────────────────────────────────────────────────────────────────

  async createRealm(realmName: string, cities: string[]): Promise<void> {
    if (!this.realmTemplate) {
      this.logger.warn(`No realm template — skipping realm "${realmName}"`);
      return;
    }

    const payload = JSON.parse(this.realmTemplate.replace(/__REALM_NAME__/g, realmName));
    payload.groups = cities.map((c) => ({ name: c }));

    const resp = await fetch(`${this.kcAdminUrl}/admin/realms`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    });

    if (resp.status === 409) {
      this.logger.log(`Realm "${realmName}" already exists, syncing groups...`);
      const existingGroups = await this.getGroupsInRealm(realmName);
      const existingNames = new Set(existingGroups.map((g) => g.name));
      for (const city of cities) {
        if (!existingNames.has(city)) {
          await this.createGroupInRealm(realmName, city).catch(() => {});
        }
      }
      return;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to create realm "${realmName}": ${resp.status} ${text}`);
    }
    this.logger.log(`Created realm "${realmName}" with ${cities.length} city group(s)`);
  }

  async listRealms(): Promise<string[]> {
    const resp = await fetch(`${this.kcAdminUrl}/admin/realms`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (!resp.ok) throw new Error(`Failed to list realms: ${resp.status}`);
    const data = (await resp.json()) as Array<{ realm: string }>;
    return data.map((r) => r.realm);
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  async createGroupInRealm(realm: string, name: string): Promise<string> {
    const resp = await fetch(`${this.kcAdminUrl}/admin/realms/${realm}/groups`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ name }),
    });

    if (resp.status === 409) {
      const groups = await this.getGroupsInRealm(realm);
      const existing = groups.find((g) => g.name === name);
      if (existing) return existing.id;
      throw new Error(`Group "${name}" reported as duplicate but not found`);
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to create group "${name}": ${resp.status} ${text}`);
    }

    const location = resp.headers.get("Location") || "";
    return location.split("/").pop() || "";
  }

  async getGroupsInRealm(realm: string): Promise<KcGroup[]> {
    const resp = await fetch(`${this.kcAdminUrl}/admin/realms/${realm}/groups`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (!resp.ok) throw new Error(`Failed to list groups: ${resp.status}`);
    return (await resp.json()) as KcGroup[];
  }

  // ── User-group ────────────────────────────────────────────────────────────

  async addUserToGroupInRealm(realm: string, userId: string, groupId: string): Promise<void> {
    const resp = await fetch(
      `${this.kcAdminUrl}/admin/realms/${realm}/users/${userId}/groups/${groupId}`,
      { method: "PUT", headers: this.authHeaders() },
    );
    if (!resp.ok) {
      throw new Error(`Failed to add user to group: ${resp.status}`);
    }
  }

  async getUserGroupsInRealm(realm: string, userId: string): Promise<KcGroup[]> {
    const resp = await fetch(
      `${this.kcAdminUrl}/admin/realms/${realm}/users/${userId}/groups`,
      { method: "GET", headers: this.authHeaders() },
    );
    if (!resp.ok) throw new Error(`Failed to get user groups: ${resp.status}`);
    return (await resp.json()) as KcGroup[];
  }

  // ── User-role ─────────────────────────────────────────────────────────────

  async assignRealmRoles(realm: string, userId: string, roleCodes: string[]): Promise<void> {
    const roleRepresentations: Array<{ id: string; name: string }> = [];
    for (const code of roleCodes) {
      const resp = await fetch(
        `${this.kcAdminUrl}/admin/realms/${realm}/roles/${code}`,
        { method: "GET", headers: this.authHeaders() },
      );
      if (!resp.ok) {
        this.logger.warn(`Role "${code}" not found in realm "${realm}": ${resp.status}`);
        continue;
      }
      const role = (await resp.json()) as { id: string; name: string };
      roleRepresentations.push({ id: role.id, name: role.name });
    }

    if (roleRepresentations.length === 0) return;

    const resp = await fetch(
      `${this.kcAdminUrl}/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
      {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(roleRepresentations),
      },
    );
    if (!resp.ok) {
      throw new Error(`Failed to assign roles: ${resp.status}`);
    }
  }

  async getUserRealmRoles(realm: string, userId: string): Promise<Array<{ name: string }>> {
    const resp = await fetch(
      `${this.kcAdminUrl}/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
      { method: "GET", headers: this.authHeaders() },
    );
    if (!resp.ok) throw new Error(`Failed to get user roles: ${resp.status}`);
    return (await resp.json()) as Array<{ name: string }>;
  }

  // ── Tenant Sync ───────────────────────────────────────────────────────────

  parseTenantConfig(tenantStr: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (!tenantStr?.trim()) return result;

    const trimmed = tenantStr.trim();
    if (trimmed.includes(":")) {
      for (const segment of trimmed.split(";")) {
        const [root, citiesPart] = segment.split(":");
        if (root && citiesPart) {
          result.set(root.trim(), citiesPart.split(",").map((c) => c.trim()).filter(Boolean));
        }
      }
    } else {
      for (const entry of trimmed.split(",").map((e) => e.trim()).filter(Boolean)) {
        const root = entry.split(".")[0];
        const existing = result.get(root) || [];
        existing.push(entry);
        result.set(root, existing);
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

    if (tenants.size === 0) {
      this.logger.log("No tenants configured, skipping sync");
      return;
    }

    this.logger.log(`Syncing ${tenants.size} tenant realm(s)...`);
    for (const [root, cities] of tenants) {
      try {
        await this.createRealm(root, cities);
        this.logger.log(`  ${root}: ${cities.length} city group(s) synced`);
      } catch (err) {
        this.logger.error(`  ${root}: failed — ${(err as Error).message}`);
      }
    }
    this.logger.log("Tenant realm sync complete");
  }
}
