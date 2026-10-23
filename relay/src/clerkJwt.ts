export const CLERK_FRONTEND_API = "https://creative-arachnid-9483.clerk.accounts.dev";
const JWKS_URL = `${CLERK_FRONTEND_API}/.well-known/jwks.json`;
const JWKS_CACHE_NAME = "droidbridge-clerk-jwks-v1";
const encoder = new TextEncoder();

interface ClerkJsonWebKey extends JsonWebKey {
  readonly kid?: string;
}

interface JsonWebKeySet {
  readonly keys: ClerkJsonWebKey[];
}

export interface ClerkSessionClaims {
  readonly sub: string;
  readonly iss: string;
  readonly exp: number;
  readonly nbf?: number;
  readonly azp: string;
  readonly [claim: string]: unknown;
}

interface CachedKeys {
  readonly keys: ClerkJsonWebKey[];
  readonly expiresAt: number;
}

let cachedJwks: CachedKeys | undefined;
let cachedJwksUrl: string | undefined;

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function decodeJsonSegment(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as unknown;
}

async function loadJwks(fetcher: typeof fetch, force = false): Promise<ClerkJsonWebKey[]> {
  if (!force && cachedJwksUrl === JWKS_URL && cachedJwks && cachedJwks.expiresAt > Date.now())
    return cachedJwks.keys;

  const cacheKey = new Request(JWKS_URL);
  if (force) {
    cachedJwks = undefined;
    cachedJwksUrl = undefined;
    if (typeof caches !== "undefined") {
      const cache = await caches.open(JWKS_CACHE_NAME);
      await cache.delete(cacheKey);
    }
  } else if (typeof caches !== "undefined") {
    const cached = await (await caches.open(JWKS_CACHE_NAME)).match(cacheKey);
    if (cached) {
      const set = (await cached.json()) as JsonWebKeySet;
      if (Array.isArray(set.keys)) {
        cachedJwks = { keys: set.keys, expiresAt: Date.now() + 60_000 };
        cachedJwksUrl = JWKS_URL;
        return set.keys;
      }
    }
  }

  const response = await fetcher(JWKS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Clerk signing keys could not be loaded.");
  const set = (await response.json()) as JsonWebKeySet;
  if (!Array.isArray(set.keys)) throw new Error("Clerk signing keys response is invalid.");
  cachedJwks = { keys: set.keys, expiresAt: Date.now() + 60_000 };
  cachedJwksUrl = JWKS_URL;
  if (typeof caches !== "undefined") {
    const cache = await caches.open(JWKS_CACHE_NAME);
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(set), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
      }),
    );
  }
  return set.keys;
}

async function keyForKid(
  kid: string,
  fetcher: typeof fetch,
  force = false,
): Promise<ClerkJsonWebKey | undefined> {
  const keys = await loadJwks(fetcher, force);
  return keys.find((key) => key.kid === kid && key.kty === "RSA" && key.use !== "enc");
}

function validateClaims(
  value: unknown,
  allowedOrigins: readonly string[],
  nowSeconds: number,
): ClerkSessionClaims {
  if (!value || typeof value !== "object") throw new Error("Clerk session claims are invalid.");
  const claims = value as Record<string, unknown>;
  if (
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.iss !== CLERK_FRONTEND_API ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds ||
    (claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" ||
        !Number.isFinite(claims.nbf) ||
        claims.nbf > nowSeconds)) ||
    typeof claims.azp !== "string" ||
    !allowedOrigins.includes(claims.azp)
  )
    throw new Error("Clerk session token claims are invalid.");
  return claims as unknown as ClerkSessionClaims;
}

export async function verifyClerkSessionToken(
  token: string,
  allowedOriginsValue: string,
  options: { readonly fetch?: typeof fetch; readonly nowSeconds?: number } = {},
): Promise<ClerkSessionClaims> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("Clerk session token is malformed.");
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature)
    throw new Error("Clerk session token is malformed.");
  const headerValue = decodeJsonSegment(encodedHeader);
  if (!headerValue || typeof headerValue !== "object")
    throw new Error("Clerk session token header is invalid.");
  const header = headerValue as Record<string, unknown>;
  if (header.alg !== "RS256" || typeof header.kid !== "string")
    throw new Error("Clerk session token algorithm or key ID is invalid.");

  const fetcher = options.fetch ?? fetch;
  let jwk = await keyForKid(header.kid, fetcher);
  if (!jwk) jwk = await keyForKid(header.kid, fetcher, true);
  if (!jwk) throw new Error("Clerk signing key was not found.");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedContent = encoder.encode(`${encodedHeader}.${encodedPayload}`);
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    Uint8Array.from(decodeBase64Url(encodedSignature)).buffer,
    signedContent,
  );
  if (!validSignature) throw new Error("Clerk session token signature is invalid.");

  const allowedOrigins = allowedOriginsValue
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return validateClaims(
    decodeJsonSegment(encodedPayload),
    allowedOrigins,
    options.nowSeconds ?? Math.floor(Date.now() / 1000),
  );
}
