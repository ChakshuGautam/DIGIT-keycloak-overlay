import {
  exportJWK,
  exportPKCS8,
  importPKCS8,
  generateKeyPair,
  SignJWT,
  type KeyLike,
} from "jose";
import express from "express";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

let privateKey: KeyLike;
let publicJwk: any;
const KID = "test-key-1";
const ISSUER = "http://localhost:9999/realms/digit-sandbox";
const KEY_FILE = join(
  import.meta.dirname || process.cwd(),
  ".test-private-key.pem",
);
const PUB_FILE = join(
  import.meta.dirname || process.cwd(),
  ".test-public-key.json",
);

export async function initKeys() {
  if (existsSync(KEY_FILE) && existsSync(PUB_FILE)) {
    // Load existing keys (shared between globalSetup and worker)
    const pem = readFileSync(KEY_FILE, "utf-8");
    privateKey = await importPKCS8(pem, "RS256");
    publicJwk = JSON.parse(readFileSync(PUB_FILE, "utf-8"));
  } else {
    // Generate new keys and persist for sharing
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const pem = await exportPKCS8(keys.privateKey);
    writeFileSync(KEY_FILE, pem);
    const pub = await exportJWK(keys.publicKey);
    publicJwk = { ...pub, kid: KID, use: "sig", alg: "RS256" };
    writeFileSync(PUB_FILE, JSON.stringify(publicJwk));
  }
}

export function cleanupKeys() {
  try {
    if (existsSync(KEY_FILE)) unlinkSync(KEY_FILE);
    if (existsSync(PUB_FILE)) unlinkSync(PUB_FILE);
  } catch {}
}

export function getIssuer() {
  return ISSUER;
}

export async function signJwt(
  claims: Record<string, unknown>,
  opts?: { expiresIn?: string },
) {
  return new SignJWT(claims as any)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts?.expiresIn || "1h")
    .sign(privateKey);
}

export function createJwksApp() {
  const app = express();
  app.get(
    "/realms/digit-sandbox/protocol/openid-connect/certs",
    (_req, res) => {
      res.json({ keys: [publicJwk] });
    },
  );
  return app;
}
