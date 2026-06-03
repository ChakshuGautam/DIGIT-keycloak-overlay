import { config } from "./config.js";
import type { DigitUser, DigitLoginResponse } from "./types.js";
import { createHash } from "node:crypto";
import { synthesizeUniqueMobile } from "./synthetic-mobile.js";

// Generate a password that meets DIGIT's policy:
// 8-15 chars, at least one uppercase, lowercase, digit, special (@#$%)
export function generatePassword(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 6);
  return `Kc${hash}@1`;  // 10 chars: uppercase K, lowercase c, 6 hex chars, @, digit
}

// DIGIT stores users at the state-root tenant level (e.g. "pg" not "pg.citya").
// Extract root from any city-level tenant ID.
export function rootTenant(tenantId: string): string {
  return tenantId.split(".")[0];
}

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
    userType: config.digitSystemUserType,
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

export async function getUserToken(
  userName: string,
  password: string,
  tenantId: string,
): Promise<{ token: string; expiresIn: number }> {
  const params = new URLSearchParams({
    username: userName,
    password,
    tenantId: rootTenant(tenantId),
    userType: "CITIZEN",
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
  if (!resp.ok) throw new Error(`Citizen login failed: ${resp.status}`);
  const data = (await resp.json()) as DigitLoginResponse;
  return { token: data.access_token, expiresIn: data.expires_in * 1000 };
}

export async function searchUser(
  emailOrUserName: string,
  tenantId: string,
): Promise<DigitUser | null> {
  // Search by userName (not emailId) because DIGIT encrypts emails via
  // egov-enc-service, making plaintext email searches unreliable.
  // Our provisioning sets userName = email, so this works correctly.
  const resp = await fetch(digitUrl("/user/_search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      userName: emailOrUserName,
      tenantId: rootTenant(tenantId),
      pageSize: 1,
    }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { user: DigitUser[] };
  return data.user?.[0] || null;
}

/**
 * Search for an existing DIGIT user by userName, optionally filtering by type.
 * Used for employee resolution — when KC claims indicate an employee, we need
 * to find their existing DIGIT account (which has type=EMPLOYEE, userName=ADMIN etc).
 */
/**
 * Search for an existing DIGIT user by mobileNumber. Used by the synthetic-
 * mobile collision check in createUser. Returns null on any non-2xx, on
 * empty results, or when the system token isn't initialized.
 */
export async function searchUserByMobile(
  mobileNumber: string,
  tenantId: string,
): Promise<DigitUser | null> {
  const resp = await fetch(digitUrl("/user/_search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      tenantId: rootTenant(tenantId),
      mobileNumber,
      pageSize: 1,
    }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { user?: DigitUser[] };
  return data.user?.[0] || null;
}

export async function searchUserByUserName(
  userName: string,
  tenantId: string,
  userType?: string,
): Promise<DigitUser | null> {
  const body: Record<string, unknown> = {
    RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
    userName,
    tenantId: rootTenant(tenantId),
    pageSize: 1,
  };
  if (userType) body.userType = userType;

  const resp = await fetch(digitUrl("/user/_search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  roles?: Array<{ code: string; name: string }>;
}): Promise<DigitUser> {
  const root = rootTenant(params.tenantId);
  const citizenRole = { code: "CITIZEN", name: "Citizen", tenantId: root };
  const roles = params.roles?.length
    ? params.roles.map(r => ({ ...r, tenantId: root }))
    : [citizenRole];
  if (!roles.find(r => r.code === "CITIZEN")) {
    roles.push(citizenRole);
  }

  // Mobile resolution: prefer the JWT's phone_number when present.
  // Otherwise synthesize a placeholder that satisfies the tenant's
  // mobile-validation regex (pulled from MDMS common-masters.UserValidation)
  // AND is unique against existing egov-user rows. Falls back to the
  // env-var prefix shape when MDMS is unreachable.
  let mobileNumber = params.phoneNumber;
  if (!mobileNumber) {
    if (!systemToken) {
      throw new Error("system token not initialized — cannot synthesize mobile");
    }
    const result = await synthesizeUniqueMobile({
      tenantId: root,
      sub: params.keycloakSub,
      systemToken,
      isMobileTaken: async (m, tid) => {
        const u = await searchUserByMobile(m, tid);
        return u !== null;
      },
    });
    mobileNumber = result.mobile;
    console.log(
      `[CREATE-USER] synthesized mobile=${mobileNumber} (source=${result.source}, attempts=${result.attempts}) for sub=${params.keycloakSub.slice(0, 8)}`,
    );
  }

  const resp = await fetch(digitUrl("/user/users/_createnovalidate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      user: {
        userName: params.email,
        name: params.name,
        emailId: params.email,
        mobileNumber,
        password: generatePassword(params.keycloakSub),
        tenantId: root,
        type: "CITIZEN",
        active: true,
        roles,
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

export async function updateUserRoles(
  uuid: string,
  tenantId: string,
  roles: Array<{ code: string; name: string }>,
): Promise<void> {
  const root = rootTenant(tenantId);
  const rolesWithTenant = roles.map(r => ({ ...r, tenantId: root }));
  if (!rolesWithTenant.find(r => r.code === "CITIZEN")) {
    rolesWithTenant.push({ code: "CITIZEN", name: "Citizen", tenantId: root });
  }
  await fetch(digitUrl("/user/users/_updatenovalidate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
      user: { uuid, roles: rolesWithTenant },
    }),
  });
}
