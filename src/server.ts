import express from "express";
import { config } from "./config.js";
import { initJwks, validateJwt } from "./jwt.js";
import { initCache, getRedis, closeCache } from "./cache.js";
import {
  initSystemToken,
  startTokenRefresh,
  stopTokenRefresh,
} from "./digit-client.js";
import { resolveUser } from "./user-resolver.js";
import { initRoutes } from "./routes.js";
import { proxyRequest } from "./proxy.js";
import { initKcAdmin, stopKcAdminRefresh, syncTenantRealms } from "./kc-admin.js";

export async function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/healthz", async (_req, res) => {
    try {
      const redis = getRedis();
      await redis.ping();
      res.json({ status: "ok", redis: "connected" });
    } catch {
      res.status(503).json({ status: "unhealthy", redis: "disconnected" });
    }
  });

  app.all("*", async (req, res) => {
    const claims = await validateJwt(req.headers.authorization);
    if (!claims) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "Invalid or missing Keycloak JWT" });
    }

    const tenantId =
      req.body?.RequestInfo?.userInfo?.tenantId ||
      req.body?.tenantId ||
      config.digitDefaultTenant;

    try {
      const digitUser = await resolveUser(claims, tenantId);
      await proxyRequest(req, res, digitUser);
    } catch (err) {
      console.error("User resolution error:", err);
      res
        .status(500)
        .json({ error: "Internal error", message: "Failed to resolve user" });
    }
  });

  return app;
}

const isMain =
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js");
if (isMain) {
  (async () => {
    initJwks();
    initCache();
    initRoutes();
    await initSystemToken();
    startTokenRefresh();

    if (config.tenantSyncEnabled) {
      try {
        await initKcAdmin();
        await syncTenantRealms();
      } catch (err) {
        console.warn("KC Admin init failed (non-fatal):", (err as Error).message);
      }
    }

    const app = await createApp();
    app.listen(config.port, () => {
      console.log(`token-exchange-svc listening on :${config.port}`);
    });

    process.on("SIGTERM", async () => {
      stopTokenRefresh();
      stopKcAdminRefresh();
      await closeCache();
      process.exit(0);
    });
  })();
}
