import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes, createHash } from "crypto";
import { CircuitBreakerService } from "../circuit-breaker/circuit-breaker.service";
import { MetricsService } from "../metrics/metrics.service";
import { DigitUser } from "../types";

@Injectable()
export class DigitClientService implements OnModuleInit {
  private readonly logger = new Logger(DigitClientService.name);
  private systemToken: string | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.acquireSystemToken();

    // Refresh every 6 days (in ms)
    const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
    this.refreshInterval = setInterval(() => {
      this.acquireSystemToken().catch((err) =>
        this.logger.error("System token refresh failed", err),
      );
    }, SIX_DAYS_MS);
  }

  hasSystemToken(): boolean {
    return this.systemToken !== null;
  }

  getSystemToken(): string | null {
    return this.systemToken;
  }

  generateRandomPassword(): string {
    // Format: Kc{10 random base64url chars}@1 = 14 chars total
    const random = randomBytes(9).toString("base64url").slice(0, 10);
    return `Kc${random}@1`;
  }

  generateMobileNumber(sub: string, seed?: number): string {
    const input = seed !== undefined ? `${sub}:${seed}` : sub;
    const hash = createHash("sha256").update(input).digest("hex");
    const first5 = hash.slice(0, 5);
    const num = parseInt(first5, 16) % 100000;
    return `90000${num.toString().padStart(5, "0")}`;
  }

  /** v1-compatible deterministic password (for backward compat with existing users) */
  generateV1Password(sub: string): string {
    const hash = createHash("sha256").update(sub).digest("hex").slice(0, 6);
    return `Kc${hash}@1`;
  }

  /** System default password for pre-existing DIGIT users */
  getSystemPassword(): string {
    return this.config.get<string>("DIGIT_SYSTEM_PASSWORD") || "eGov@123";
  }

  namespacedUserName(realm: string, email: string): string {
    return `${realm}:${email}`;
  }

  resolveUserType(digitUserType?: string): string {
    return digitUserType === "EMPLOYEE" ? "EMPLOYEE" : "CITIZEN";
  }

  async searchUser(
    email: string,
    tenantId: string,
  ): Promise<DigitUser | null> {
    const host = this.config.get<string>("DIGIT_USER_HOST");
    const url = `${host}/user/_search`;

    return this.circuitBreaker.exec("egov-user", async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            RequestInfo: { apiId: "Rainmaker", authToken: this.systemToken },
            tenantId,
            userName: email,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`searchUser failed: ${res.status}`);
        }

        const data = await res.json();
        const users = data.user || [];
        return users.length > 0 ? users[0] : null;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  async createUser(params: {
    userName: string;
    name: string;
    email: string;
    mobileNumber?: string;
    keycloakSub?: string;
    tenantId: string;
    password: string;
    type: string;
    roles?: Array<{ code: string; name: string; tenantId?: string }>;
  }): Promise<DigitUser> {
    const host = this.config.get<string>("DIGIT_USER_HOST");
    const url = `${host}/user/users/_createnovalidate`;

    const mobile = params.mobileNumber || this.generateMobileNumber(params.keycloakSub || params.userName);

    const body = {
      RequestInfo: { apiId: "Rainmaker", authToken: this.systemToken },
      user: {
        userName: params.userName,
        name: params.name,
        emailId: params.email,
        mobileNumber: mobile,
        tenantId: params.tenantId,
        password: params.password,
        type: params.type,
        roles: params.roles && params.roles.length > 0
          ? params.roles
          : [{ code: "CITIZEN", name: "Citizen", tenantId: params.tenantId }],
        active: true,
      },
    };

    this.logger.log(`createUser: ${JSON.stringify(body.user, null, 0).substring(0, 200)}`);
    try {
      return await this.postToDigit<DigitUser>(url, body, "user");
    } catch (err: any) {
      // Retry on 400 — likely mobile number collision or other constraint violation
      // egov-user returns generic "InvalidUserCreateException" without details
      if (err.message && err.message.includes("400")) {
        this.logger.warn(`User create failed (400), retrying with different mobile: ${err.message.substring(0, 100)}`);
        const newMobile = this.generateMobileNumber(params.keycloakSub || params.userName, 1);
        body.user.mobileNumber = newMobile;
        try {
          return await this.postToDigit<DigitUser>(url, body, "user");
        } catch (retryErr: any) {
          // Second retry with seed=2
          this.logger.warn(`Retry also failed, trying seed=2`);
          body.user.mobileNumber = this.generateMobileNumber(params.keycloakSub || params.userName, 2);
          return this.postToDigit<DigitUser>(url, body, "user");
        }
      }
      throw err;
    }
  }

  async updateUserPassword(
    existingUser: DigitUser,
    password: string,
  ): Promise<void> {
    const host = this.config.get<string>("DIGIT_USER_HOST");
    const url = `${host}/user/users/_updatenovalidate`;

    // Send full user object with updated password — DIGIT requires all fields
    await this.postToDigit(url, {
      RequestInfo: { apiId: "Rainmaker", authToken: this.systemToken },
      user: {
        ...existingUser,
        password,
      },
    });
  }

  async updateUserRoles(
    uuid: string,
    tenantId: string,
    roles: Array<{ code: string; name: string; tenantId?: string }>,
  ): Promise<void> {
    const host = this.config.get<string>("DIGIT_USER_HOST");
    const url = `${host}/user/users/_updatenovalidate`;

    // Always include CITIZEN role
    if (!roles || !Array.isArray(roles)) roles = [];
    const hasCitizen = roles.some((r) => r.code === "CITIZEN");
    const allRoles = hasCitizen
      ? roles
      : [{ code: "CITIZEN", name: "Citizen", tenantId }, ...roles];

    await this.postToDigit(url, {
      RequestInfo: { apiId: "Rainmaker", authToken: this.systemToken },
      user: { uuid, tenantId, roles: allRoles },
    });
  }

  async getUserToken(
    userName: string,
    password: string,
    tenantId: string,
    userType: string,
  ): Promise<{ token: string; expiresIn: number }> {
    const host = this.config.get<string>("DIGIT_USER_HOST");
    const url = `${host}/user/oauth/token`;

    const formBody = new URLSearchParams({
      username: userName,
      password,
      tenantId,
      userType,
      grant_type: "password",
      scope: "read",
      // egov-user uses OTP-based auth for CITIZEN users by default.
      // isInternal=true bypasses OTP validation for service-to-service calls.
      // This is the intended mechanism — token-exchange-svc is an internal service
      // that has already validated the user via Keycloak JWT.
      isInternal: "true",
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic ZWdvdi11c2VyLWNsaWVudDo=",
      },
      body: formBody.toString(),
    });

    if (!res.ok) {
      throw new Error(`getUserToken failed: ${res.status}`);
    }

    const data = await res.json();
    return {
      token: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  private async acquireSystemToken(): Promise<void> {
    const host = this.config.get<string>("DIGIT_USER_HOST");
    const username = this.config.get<string>("DIGIT_SYSTEM_USERNAME");
    const password = this.config.get<string>("DIGIT_SYSTEM_PASSWORD");
    const userType = this.config.get<string>("DIGIT_SYSTEM_USER_TYPE");
    const tenant = this.config.get<string>("DIGIT_SYSTEM_TENANT");

    const url = `${host}/user/oauth/token`;

    const formBody = new URLSearchParams({
      username: username!,
      password: password!,
      tenantId: tenant!,
      userType: userType!,
      grant_type: "password",
      scope: "read",
    });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic ZWdvdi11c2VyLWNsaWVudDo=",
        },
        body: formBody.toString(),
      });

      if (!res.ok) {
        throw new Error(`System token acquisition failed: ${res.status}`);
      }

      const data = await res.json();
      this.systemToken = data.access_token;
      this.metrics.tokenRefreshTotal.inc({
        token_type: "system",
        result: "success",
      });
      this.logger.log("System token acquired successfully");
    } catch (err) {
      this.metrics.tokenRefreshTotal.inc({
        token_type: "system",
        result: "failure",
      });
      this.logger.error("Failed to acquire system token", err);
      throw err;
    }
  }

  private async postToDigit<T>(
    url: string,
    body: unknown,
    responseKey?: string,
  ): Promise<T> {
    return this.circuitBreaker.exec("egov-user", async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const jsonBody = JSON.stringify(body);
        if (url.includes("_createnovalidate")) {
          this.logger.log(`[DEBUG] POST ${url} body length=${jsonBody.length}`);
          this.logger.log(`[DEBUG] body: ${jsonBody.substring(0, 500)}`);
        }
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: jsonBody,
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`DIGIT API error ${res.status}: ${text}`);
        }

        const data = await res.json();
        if (responseKey) {
          const items = data[responseKey];
          return Array.isArray(items) ? items[0] : items;
        }
        return data;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}
