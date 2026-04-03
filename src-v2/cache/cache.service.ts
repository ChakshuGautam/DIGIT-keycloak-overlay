import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { LRUCache } from "lru-cache";
import type { CachedSession } from "../types";

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis;
  private memoryCache: LRUCache<string, CachedSession>;
  private redisHealthy = false;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  private readonly prefix: string;
  private readonly ttlSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.prefix = this.config.get<string>("CACHE_PREFIX") ?? "keycloak";
    this.ttlSeconds = this.config.get<number>("CACHE_TTL_SECONDS") ?? 3600;

    this.redis = new Redis({
      host: this.config.get<string>("REDIS_HOST") ?? "localhost",
      port: this.config.get<number>("REDIS_PORT") ?? 6379,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });

    this.memoryCache = new LRUCache<string, CachedSession>({
      max: 5000,
      ttl: 10 * 60 * 1000, // 10 minutes
    });

    this.redis.on("error", (err) => {
      if (this.redisHealthy) {
        this.logger.warn(`Redis connection lost: ${err.message}`);
        this.redisHealthy = false;
        this.startHealthCheck();
      }
    });

    this.redis.on("connect", () => {
      this.logger.log("Redis connected");
      this.redisHealthy = true;
      this.stopHealthCheck();
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.redis.connect();
      this.redisHealthy = true;
      this.logger.log("Redis connected successfully");
    } catch (err) {
      this.logger.warn(
        `Redis unavailable, using memory-only cache: ${(err as Error).message}`,
      );
      this.redisHealthy = false;
      this.startHealthCheck();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHealthCheck();
    try {
      await this.redis.quit();
    } catch {
      // ignore disconnect errors
    }
  }

  private buildKey(sub: string, tenantId: string): string {
    return `${this.prefix}:${sub}:${tenantId}`;
  }

  async get(sub: string, tenantId: string): Promise<CachedSession | null> {
    const key = this.buildKey(sub, tenantId);

    if (this.redisHealthy) {
      try {
        const raw = await this.redis.get(key);
        if (raw) {
          const session = JSON.parse(raw) as CachedSession;
          // Populate memory cache on read-through
          this.memoryCache.set(key, session);
          return session;
        }
        return null;
      } catch (err) {
        this.logger.warn(`Redis get failed, falling back to memory: ${(err as Error).message}`);
        this.redisHealthy = false;
        this.startHealthCheck();
      }
    }

    // Fallback to memory
    return this.memoryCache.get(key) ?? null;
  }

  async set(sub: string, tenantId: string, session: CachedSession): Promise<void> {
    const key = this.buildKey(sub, tenantId);

    // Always write to memory
    this.memoryCache.set(key, session);

    if (this.redisHealthy) {
      try {
        await this.redis.set(key, JSON.stringify(session), "EX", this.ttlSeconds);
      } catch (err) {
        this.logger.warn(`Redis set failed: ${(err as Error).message}`);
        this.redisHealthy = false;
        this.startHealthCheck();
      }
    }
  }

  async delete(sub: string, tenantId: string): Promise<void> {
    const key = this.buildKey(sub, tenantId);

    this.memoryCache.delete(key);

    if (this.redisHealthy) {
      try {
        await this.redis.del(key);
      } catch (err) {
        this.logger.warn(`Redis delete failed: ${(err as Error).message}`);
        this.redisHealthy = false;
        this.startHealthCheck();
      }
    }
  }

  async deleteAllForSub(sub: string): Promise<number> {
    const pattern = `${this.prefix}:${sub}:*`;
    let deletedCount = 0;

    // Delete from memory cache
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(`${this.prefix}:${sub}:`)) {
        this.memoryCache.delete(key);
        deletedCount++;
      }
    }

    if (this.redisHealthy) {
      try {
        const allKeys: string[] = [];
        await new Promise<void>((resolve, reject) => {
          const stream = this.redis.scanStream({ match: pattern, count: 100 });
          stream.on("data", (keys: string[]) => {
            allKeys.push(...keys);
          });
          stream.on("end", () => resolve());
          stream.on("error", (err: Error) => reject(err));
        });

        if (allKeys.length > 0) {
          await this.redis.del(...allKeys);
          deletedCount = allKeys.length;
        }
      } catch (err) {
        this.logger.warn(`Redis deleteAll failed: ${(err as Error).message}`);
        this.redisHealthy = false;
        this.startHealthCheck();
      }
    }

    return deletedCount;
  }

  isStale(session: CachedSession, maxAgeSeconds?: number): boolean {
    const ttl = maxAgeSeconds ?? this.ttlSeconds;
    const ageMs = Date.now() - session.cachedAt;
    return ageMs > ttl * 1000;
  }

  isRedisHealthy(): boolean {
    return this.redisHealthy;
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(async () => {
      try {
        const result = await this.redis.ping();
        if (result === "PONG") {
          this.logger.log("Redis recovered");
          this.redisHealthy = true;
          this.stopHealthCheck();
        }
      } catch {
        // still down
      }
    }, 5000);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}
