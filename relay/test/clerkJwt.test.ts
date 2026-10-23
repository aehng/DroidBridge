import { beforeAll, describe, expect, it, vi } from "vitest";
import { CLERK_FRONTEND_API, verifyClerkSessionToken } from "../src/clerkJwt";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;
const encoder = new TextEncoder();

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signedToken(claims: Record<string, unknown>, kid = "clerk-key-1"): Promise<string> {
  const header = encode(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const payload = encode(encoder.encode(JSON.stringify(claims)));
  const signed = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(signed),
  );
  return `${signed}.${encode(new Uint8Array(signature))}`;
}

const claims = (overrides: Record<string, unknown> = {}) => ({
  sub: "user-1",
  iss: CLERK_FRONTEND_API,
  exp: Math.floor(Date.now() / 1000) + 300,
  nbf: Math.floor(Date.now() / 1000) - 5,
  azp: "https://relay.example",
  ...overrides,
});

function keyFetcher() {
  return vi.fn(async () => Response.json({ keys: [publicJwk] })) as unknown as typeof fetch;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "clerk-key-1",
    alg: "RS256",
    use: "sig",
  };
});

describe("Clerk session JWT verification", () => {
  it("accepts a valid RS256 session token with an allowed origin", async () => {
    const token = await signedToken(claims());
    const result = await verifyClerkSessionToken(token, "https://relay.example", {
      fetch: keyFetcher(),
    });
    expect(result.sub).toBe("user-1");
  });

  it("rejects expired tokens", async () => {
    const token = await signedToken(claims({ exp: 1 }));
    await expect(
      verifyClerkSessionToken(token, "https://relay.example", {
        fetch: keyFetcher(),
        nowSeconds: 2,
      }),
    ).rejects.toThrow("claims are invalid");
  });
});
