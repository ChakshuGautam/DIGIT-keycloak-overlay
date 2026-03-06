import type { GlobalSetupContext } from "vitest/node";
import { initKeys, createJwksApp, cleanupKeys } from "../mocks/jwks-server.js";

let server: any;

export async function setup(_ctx: GlobalSetupContext) {
  // Generate keys first (globalSetup runs before workers)
  cleanupKeys(); // ensure fresh keys each run
  await initKeys();
  const app = createJwksApp();
  server = app.listen(9999);
  process.env.KEYCLOAK_JWKS_URI =
    "http://localhost:9999/realms/digit-sandbox/protocol/openid-connect/certs";
  process.env.KEYCLOAK_ISSUER = "http://localhost:9999/realms/digit-sandbox";
}

export async function teardown() {
  server?.close();
  cleanupKeys();
}
