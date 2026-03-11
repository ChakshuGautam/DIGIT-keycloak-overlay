import { createApp } from "../../src/server.js";
import { initJwks } from "../../src/jwt.js";
import { initCache, closeCache, getRedis } from "../../src/cache.js";
import { initSystemToken } from "../../src/digit-client.js";
import { initRoutes, getRouteMap } from "../../src/routes.js";
import { config } from "../../src/config.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let appPort: number;
let initialized = false;

export async function startTestApp() {
  if (initialized) return appPort;

  // Point config at global setup mocks (env vars set by globalSetup)
  (config as any).digitUserHost =
    process.env.DIGIT_USER_HOST || "http://localhost:18207";
  (config as any).redisHost = process.env.REDIS_HOST || "localhost";
  (config as any).redisPort = parseInt(process.env.REDIS_PORT || "16379");

  // Point gateway at mock backend (used for both KC-proxied and non-KC forwarded requests)
  const pgrPort = process.env.MOCK_PGR_PORT || "18082";
  (config as any).digitGatewayHost = `http://localhost:${pgrPort}`;

  initJwks(process.env.KEYCLOAK_JWKS_URI);
  initCache(`redis://${config.redisHost}:${config.redisPort}`);
  initRoutes();

  // Keep route map entries for backwards compat (not used by proxy anymore, but routes.ts is still loaded)
  const wfPort = process.env.MOCK_WF_PORT || "18109";
  getRouteMap().set("/pgr-services", `http://localhost:${pgrPort}`);
  getRouteMap().set("/egov-workflow-v2", `http://localhost:${wfPort}`);

  await initSystemToken();
  const app = await createApp();
  server = app.listen(0);
  appPort = (server.address() as AddressInfo).port;
  initialized = true;
  return appPort;
}

export async function stopTestApp() {
  server?.close();
  await closeCache();
  initialized = false;
}

export function getAppPort() {
  return appPort;
}

export async function clearCache() {
  const redis = getRedis();
  const keys = await redis.keys("keycloak:*");
  if (keys.length) await redis.del(...keys);
}

export { getRedis, getRouteMap };
