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

export async function createApp() {
  const app = express();

  // Parse JSON bodies (needed for RequestInfo injection)
  app.use(express.json({ limit: "10mb" }));

  // Health check
  app.get("/healthz", async (_req, res) => {
    try {
      const redis = getRedis();
      await redis.ping();
      res.json({ status: "ok", redis: "connected" });
    } catch {
      res.status(503).json({ status: "unhealthy", redis: "disconnected" });
    }
  });

  // Main proxy handler
  app.all("*", async (req, res) => {
    // 1. Validate JWT
    const claims = await validateJwt(req.headers.authorization);
    if (!claims) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "Invalid or missing Keycloak JWT" });
    }

    // 2. Extract tenantId from request body
    const tenantId =
      req.body?.RequestInfo?.userInfo?.tenantId ||
      req.body?.tenantId ||
      config.digitDefaultTenant;

    // 3. Resolve Keycloak user -> DIGIT user
    try {
      const digitUser = await resolveUser(claims, tenantId);
      // 4. Proxy to upstream with injected auth
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

// Start server when run directly
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

    const app = await createApp();
    app.listen(config.port, () => {
      console.log(`token-exchange-svc listening on :${config.port}`);
    });

    process.on("SIGTERM", async () => {
      stopTokenRefresh();
      await closeCache();
      process.exit(0);
    });
  })();
}
