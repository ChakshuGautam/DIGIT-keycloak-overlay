/**
 * Standalone cleanup script for test artifacts.
 *
 * Removes:
 *   - Redis cache keys matching keycloak:* (test user caches)
 *   - PostgreSQL users with test email domains
 *
 * Usage:
 *   npx tsx tests/integration/cleanup.ts
 *
 * Environment:
 *   REDIS_HOST   (default: localhost)
 *   REDIS_PORT   (default: 16379)
 *   DIGIT_DB_URL (default: postgresql://egov:egov123@localhost:15432/egov)
 */

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "16379");
const DB_URL = process.env.DIGIT_DB_URL || "postgresql://egov:egov123@localhost:15432/egov";

const TEST_EMAIL_DOMAINS = [
  "@keycloak-test.example.com",
  "@keycloak-proxy-test.example.com",
];

async function cleanRedis() {
  console.log("\n--- Redis Cleanup ---");
  try {
    const { Redis } = await import("ioredis");
    const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    const keys = await redis.keys("keycloak:*");
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`  Deleted ${keys.length} key(s): ${keys.join(", ")}`);
    } else {
      console.log("  No keycloak:* keys found.");
    }
    await redis.quit();
  } catch (err: any) {
    console.error(`  Redis cleanup failed: ${err.message}`);
  }
}

async function cleanDatabase() {
  console.log("\n--- Database Cleanup ---");
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();

    // List test users before deleting
    const conditions = TEST_EMAIL_DOMAINS.map(
      (d) => `username LIKE '%${d}'`
    ).join(" OR ");

    const list = await client.query(
      `SELECT id, username, name, type, active FROM eg_user WHERE ${conditions}`
    );
    if (list.rows.length > 0) {
      console.log(`  Found ${list.rows.length} test user(s):`);
      for (const row of list.rows) {
        console.log(`    - ${row.username} (${row.name}, ${row.type}, active=${row.active})`);
      }
    }

    const result = await client.query(
      `DELETE FROM eg_user WHERE ${conditions}`
    );
    console.log(`  Deleted ${result.rowCount} test user(s).`);

    await client.end();
  } catch (err: any) {
    console.error(`  Database cleanup failed: ${err.message}`);
    if (err.message.includes("Cannot find module")) {
      console.error("  Install pg: npm install pg");
    }
  }
}

async function main() {
  console.log("Keycloak Overlay — Test Artifact Cleanup");
  await cleanRedis();
  await cleanDatabase();
  console.log("\nDone.");
}

main();
