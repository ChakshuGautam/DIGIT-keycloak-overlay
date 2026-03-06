import { config } from "./config.js";

let cachedAdminToken: string | null = null;
let tokenExpiry = 0;

export async function getAdminToken(): Promise<string> {
  if (cachedAdminToken && Date.now() < tokenExpiry) {
    return cachedAdminToken;
  }

  const resp = await fetch(
    `${config.keycloakAdminUrl}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: config.keycloakAdminClientId,
        username: config.keycloakAdminUsername,
        password: config.keycloakAdminPassword,
      }).toString(),
    }
  );

  if (!resp.ok) {
    throw new Error(`Keycloak admin login failed: ${resp.status}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedAdminToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 10) * 1000;
  return cachedAdminToken;
}

export async function searchKeycloakUser(email: string): Promise<boolean> {
  const token = await getAdminToken();
  const resp = await fetch(
    `${config.keycloakAdminUrl}/admin/realms/${config.keycloakUserRealm}/users?email=${encodeURIComponent(email)}&exact=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) return false;
  const users = (await resp.json()) as Array<{ email: string }>;
  return users.length > 0;
}

export async function createKeycloakUser(params: {
  email: string;
  password: string;
  name: string;
}): Promise<void> {
  const token = await getAdminToken();
  const resp = await fetch(
    `${config.keycloakAdminUrl}/admin/realms/${config.keycloakUserRealm}/users`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        username: params.email,
        email: params.email,
        firstName: params.name,
        enabled: true,
        emailVerified: true,
        credentials: [{ type: "password", value: params.password, temporary: false }],
      }),
    }
  );

  if (resp.status === 409) {
    throw new Error("User already exists");
  }
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Keycloak user creation failed: ${resp.status} ${err}`);
  }
}
