/**
 * Synthetic mobile generator for SSO-provisioned citizens.
 *
 * When a KC user logs in via SSO (Google) the JWT has no `phone_number`
 * claim, so the overlay's lazy-provisioning into DIGIT egov-user has no
 * mobile to pass. egov-user rejects empty mobiles against the tenant's
 * `common-masters.UserValidation` regex (e.g. Kenya wants `^0?[17][0-9]{8}$`).
 *
 * This module:
 *   1. Pulls the tenant's mobile-validation rule from MDMS at runtime
 *      (cached). Falls back to a configurable env-var prefix when MDMS is
 *      unreachable or the rule is missing.
 *   2. Generates a string from the rule's regex using randexp, seeded by
 *      the user's KC `sub` so the value is stable across re-provisions.
 *   3. Checks uniqueness against egov-user; on collision, mutates the
 *      seed and retries (capped to avoid runaways).
 *
 * The synthesized number is a placeholder — citizens are expected to
 * replace it via /user/profile/_update on first interaction. Nothing in
 * DIGIT depends on it being a real reachable phone; egov-user uses it
 * only as a unique identifier and for SMS-OTP fallback flows that SSO
 * citizens don't use.
 */
import RandExp from "randexp";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { getRedis } from "./cache.js";

interface MobileRule {
  pattern: string;
  minLength: number;
  maxLength: number;
  // Captured for diagnostics — not enforced separately; the regex already
  // encodes valid starting characters.
  allowedStartingCharacters?: string[];
}

const VALIDATION_CACHE_TTL_S = 300; // 5 minutes
const MAX_GEN_ATTEMPTS = 8;

/**
 * Fetch `common-masters.UserValidation` (fieldType=mobile) for a tenant.
 * Cached in Redis with a 5min TTL to keep MDMS load low and to avoid a
 * round-trip on every SSO citizen first-login.
 *
 * Returns null on any failure — caller falls back to the env-var prefix
 * path so missing MDMS doesn't break provisioning entirely.
 */
async function fetchMobileValidation(
  tenantId: string,
  systemToken: string,
): Promise<MobileRule | null> {
  const cacheKey = `${config.cachePrefix}:uservalidation:mobile:${tenantId}`;
  try {
    const cached = await getRedis().get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Cached miss — don't re-fetch within the TTL window
      if (parsed === null) return null;
      return parsed as MobileRule;
    }
  } catch (e) {
    // Redis hiccup — proceed to MDMS, just don't cache
  }

  let rule: MobileRule | null = null;
  try {
    const resp = await fetch(`${config.digitGatewayHost}/mdms-v2/v2/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        RequestInfo: { apiId: "Rainmaker", authToken: systemToken },
        MdmsCriteria: {
          tenantId,
          schemaCode: "common-masters.UserValidation",
        },
      }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { mdms?: Array<{ data?: { fieldType?: string; rules?: any } }> };
      const row = (data.mdms || []).find(
        (m) => m.data?.fieldType === "mobile" && m.data?.rules?.pattern,
      );
      if (row?.data?.rules) {
        rule = {
          pattern: row.data.rules.pattern as string,
          minLength: row.data.rules.minLength as number,
          maxLength: row.data.rules.maxLength as number,
          allowedStartingCharacters: row.data.rules.allowedStartingCharacters,
        };
      }
    }
  } catch (e) {
    console.warn(
      `[SYNTH-MOBILE] MDMS fetch failed for ${tenantId} — falling back to env prefix:`,
      (e as Error).message,
    );
  }

  // Cache the result (including null) so we don't hammer MDMS on every
  // citizen first-login if the schema is genuinely missing on this tenant.
  try {
    await getRedis().set(
      cacheKey,
      JSON.stringify(rule),
      "EX",
      VALIDATION_CACHE_TTL_S,
    );
  } catch (e) {
    // ignore cache write failures
  }

  return rule;
}

/**
 * Deterministically (per sub+attempt) generate a string matching the
 * regex, within the [minLength, maxLength] window. Uses randexp with a
 * pinned RNG so re-provisioning the same KC user produces the same
 * mobile (idempotent — re-runs don't fork DIGIT-side identity).
 */
function generateFromRegex(
  rule: MobileRule,
  sub: string,
  attempt: number,
): string {
  const rx = new RandExp(rule.pattern);
  // Bound the generated length: randexp respects the regex but quantifiers
  // like `{8}` are already fixed-length; this guard is for `*` / `+` cases.
  rx.max = rule.maxLength;
  // Seed the RNG with sub+attempt so the value is stable for a given
  // (sub, attempt) pair. Hash both into a 32-bit float in [0, 1).
  const seed = parseInt(
    createHash("sha256").update(`${sub}|${attempt}`).digest("hex").slice(0, 8),
    16,
  );
  let counter = seed >>> 0;
  rx.randInt = (from: number, to: number) => {
    // xorshift32 — deterministic for our seed
    counter ^= counter << 13;
    counter ^= counter >>> 17;
    counter ^= counter << 5;
    counter >>>= 0;
    return from + (counter % (to - from + 1));
  };

  let s = rx.gen();
  // Defensive truncation — regex without `$` could over-generate.
  if (s.length > rule.maxLength) s = s.slice(0, rule.maxLength);
  return s;
}

/**
 * Fallback path: regex unavailable, use the env-var prefix + 5-digit hash.
 * Matches the original overlay behavior so non-Kenya deployments without
 * UserValidation in MDMS keep working.
 */
function fallbackPrefixedMobile(sub: string, attempt: number): string {
  const hash =
    parseInt(
      createHash("sha256").update(`${sub}|${attempt}`).digest("hex").slice(0, 5),
      16,
    ) % 100000;
  return `${config.overlaySyntheticMobilePrefix}${String(hash).padStart(5, "0")}`;
}

/**
 * Returns a tenant-valid placeholder mobile that does NOT collide with any
 * existing egov-user row. Throws if MAX_GEN_ATTEMPTS exhausted (which only
 * happens with absurdly tight regexes — Kenya's pattern has 10^7 valid
 * values, so collision is essentially impossible).
 *
 * `isMobileTaken` is injected to keep this module dependency-free of the
 * digit-client (avoids a circular import).
 */
export async function synthesizeUniqueMobile(opts: {
  tenantId: string;
  sub: string;
  systemToken: string;
  isMobileTaken: (mobile: string, tenantId: string) => Promise<boolean>;
}): Promise<{ mobile: string; source: "mdms" | "fallback"; attempts: number }> {
  const rule = await fetchMobileValidation(opts.tenantId, opts.systemToken);
  const source = rule ? "mdms" : "fallback";

  for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
    const candidate = rule
      ? generateFromRegex(rule, opts.sub, attempt)
      : fallbackPrefixedMobile(opts.sub, attempt);

    const taken = await opts.isMobileTaken(candidate, opts.tenantId);
    if (!taken) {
      return { mobile: candidate, source, attempts: attempt + 1 };
    }
    console.log(
      `[SYNTH-MOBILE] collision on attempt ${attempt + 1}: ${candidate} for sub=${opts.sub.slice(0, 8)}, retrying`,
    );
  }

  throw new Error(
    `Failed to synthesize a unique mobile after ${MAX_GEN_ATTEMPTS} attempts ` +
      `for tenant=${opts.tenantId} (rule source=${source}). Regex may be too narrow.`,
  );
}
