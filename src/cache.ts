import { Redis } from "ioredis";
import { config } from "./config.js";
import type { CachedSession } from "./types.js";

let redis: Redis;

export function initCache(redisUrl?: string) {
  redis = redisUrl
    ? new Redis(redisUrl)
    : new Redis({ host: config.redisHost, port: config.redisPort });
  return redis;
}

export function getRedis() {
  return redis;
}

function cacheKey(sub: string, tenantId: string): string {
  return `${config.cachePrefix}:${sub}:${tenantId}`;
}

export async function getCached(
  sub: string,
  tenantId: string,
): Promise<CachedSession | null> {
  const raw = await redis.get(cacheKey(sub, tenantId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedSession;
  } catch {
    return null;
  }
}

export async function setCached(
  sub: string,
  tenantId: string,
  session: CachedSession,
): Promise<void> {
  await redis.set(
    cacheKey(sub, tenantId),
    JSON.stringify(session),
    "EX",
    config.cacheTtlSeconds,
  );
}

export async function delCached(
  sub: string,
  tenantId: string,
): Promise<void> {
  await redis.del(cacheKey(sub, tenantId));
}

export async function closeCache(): Promise<void> {
  await redis?.quit();
}
