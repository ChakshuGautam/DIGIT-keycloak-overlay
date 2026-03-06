import { config } from "./config.js";
import type { DigitUser, DigitLoginResponse } from "./types.js";
import { createHash, randomBytes } from "node:crypto";

let systemToken: string | null = null;
let systemTokenRefreshTimer: ReturnType<typeof setInterval> | null = null;

function digitUrl(path: string): string {
  return `${config.digitUserHost}${path}`;
}

export async function initSystemToken(): Promise<string> {
  const params = new URLSearchParams({
    username: config.digitSystemUsername,
    password: config.digitSystemPassword,
    tenantId: config.digitSystemTenant,
    userType: "SYSTEM",
    grant_type: "password",
    scope: "read",
  });
  const resp = await fetch(digitUrl("/user/oauth/token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic ZWdvdi11c2VyLWNsaWVudDo=",
    },
    body: params.toString(),
  });
  if (!resp.ok) throw new Error(`System login failed: ${resp.status}`);
  const data = (await resp.json()) as DigitLoginResponse;
  systemToken = data.access_token;
  return systemToken;
}

export function getSystemToken(): string {
  if (!systemToken) throw new Error("System token not initialized");
  return systemToken;
}

export function startTokenRefresh(intervalMs = 6 * 24 * 60 * 60 * 1000) {
  systemTokenRefreshTimer = setInterval(() => {
    initSystemToken().catch(console.error);
  }, intervalMs);
}

export function stopTokenRefresh() {
  if (systemTokenRefreshTimer) clearInterval(systemTokenRefreshTimer);
}

export async function searchUser(
  emailId: string,
  tenantId: string,
): Promise<DigitUser | null> {
  const resp = await fetch(digitUrl("/user/_search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      emailId,
      tenantId,
      pageSize: 1,
    }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { user: DigitUser[] };
  return data.user?.[0] || null;
}

export async function createUser(params: {
  name: string;
  email: string;
  tenantId: string;
  keycloakSub: string;
  phoneNumber?: string;
}): Promise<DigitUser> {
  const mobileHash =
    parseInt(
      createHash("sha256")
        .update(params.keycloakSub)
        .digest("hex")
        .slice(0, 5),
      16,
    ) % 100000;
  const resp = await fetch(digitUrl("/user/users/_createnovalidate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      user: {
        userName: params.email,
        name: params.name,
        emailId: params.email,
        mobileNumber:
          params.phoneNumber ||
          `90000${String(mobileHash).padStart(5, "0")}`,
        password: randomBytes(32).toString("hex"),
        tenantId: params.tenantId,
        type: "CITIZEN",
        active: true,
        roles: [
          { code: "CITIZEN", name: "Citizen", tenantId: params.tenantId },
        ],
      },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`User creation failed: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as { user: DigitUser[] };
  return data.user[0];
}

export async function updateUser(
  uuid: string,
  updates: { name?: string; emailId?: string },
): Promise<void> {
  await fetch(digitUrl("/user/users/_updatenovalidate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      user: { uuid, ...updates },
    }),
  });
}
