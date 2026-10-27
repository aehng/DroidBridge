import { clerkMountSignInOptions, renderAuthPage } from "./authTheme";
import { CLERK_FRONTEND_API, verifyClerkSessionToken } from "./clerkJwt";
import {
  createOAuthClient,
  deleteOAuthToken,
  getAccountById,
  getDeviceByCredentialHash,
  getOAuthClient,
  getOAuthToken,
  getOAuthTokenRecord,
  getOrCreateAccount,
  listAccountDevices,
  revokeAccountDevices,
  saveDevice,
  saveOAuthToken,
  type D1Database,
} from "./db";

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface DurableObjectNamespace<_T> {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface DurableObjectState {
  acceptWebSocket(socket: WebSocket): void;
  setWebSocketAutoResponse?(response: WebSocketRequestResponsePair): void;
  getWebSockets(tag?: string): WebSocket[];
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
}
declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}
interface UpgradeResponseInit extends ResponseInit {
  webSocket?: WebSocket;
}
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}
export interface Env {
  DEVICES: DurableObjectNamespace<DeviceRelay>;
  TOKENS: KVNamespace;
  DB: D1Database;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_ALLOWED_ORIGINS?: string;
}

const encoder = new TextEncoder();
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const PAIRING_TTL_SEC = 10 * 60;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const hash = async (value: string) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const allowedOrigins = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
function cors(request: Request, response: Response): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins.has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set(
    "access-control-allow-headers",
    "authorization,content-type,mcp-session-id,mcp-protocol-version,last-event-id",
  );
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-expose-headers", "Mcp-Session-Id,MCP-Protocol-Version");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
const oauthPaths = new Set([
  "/mcp",
  "/register",
  "/authorize",
  "/token",
  "/revoke",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
]);
const newSecret = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function randomPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
}

function randomDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `dbt_${b64url(bytes)}`;
}

async function accountForOAuthBearer(env: Env, bearer: string): Promise<string | null> {
  const record = await getOAuthToken(env.DB, await hash(bearer));
  if (record && record.token_type !== "refresh") return record.account_id;
  return null;
}

async function issueOAuth(env: Env, accountId: string, clientId: string | null) {
  const access = newSecret("sma_");
  const refresh = newSecret("smr_");
  const accessHash = await hash(access);
  const refreshHash = await hash(refresh);
  const now = Date.now();
  await Promise.all([
    saveOAuthToken(env.DB, {
      token_hash: accessHash,
      token_type: "access",
      account_id: accountId,
      client_id: clientId,
      paired_token_hash: refreshHash,
      expires_at: now + 60 * 60 * 1000,
      created_at: now,
    }),
    saveOAuthToken(env.DB, {
      token_hash: refreshHash,
      token_type: "refresh",
      account_id: accountId,
      client_id: clientId,
      paired_token_hash: accessHash,
      expires_at: now + 7 * 24 * 60 * 60 * 1000,
      created_at: now,
    }),
  ]);
  return json({
    access_token: access,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refresh,
    scope: "mcp",
  });
}

async function revokeOAuthToken(env: Env, token: string): Promise<void> {
  const tokenHash = await hash(token);
  const stored = await getOAuthTokenRecord(env.DB, tokenHash);
  await deleteOAuthToken(env.DB, tokenHash);
  if (stored?.paired_token_hash) await deleteOAuthToken(env.DB, stored.paired_token_hash);
}

interface AuthorizationRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
  readonly resource?: string | null;
}

async function completeAuthorization(
  env: Env,
  accountId: string,
  record: AuthorizationRecord,
): Promise<string> {
  const authCode = newSecret("sac_");
  await env.TOKENS.put(`code:${await hash(authCode)}`, JSON.stringify({ accountId, ...record }), {
    expirationTtl: 300,
  });
  const redirect = new URL(record.redirectUri);
  redirect.searchParams.set("code", authCode);
  if (record.state) redirect.searchParams.set("state", record.state);
  return redirect.toString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function clerkCsp(): string {
  return (
    `default-src 'none'; script-src 'self' 'unsafe-inline' ${CLERK_FRONTEND_API}; ` +
    `style-src 'self' 'unsafe-inline' ${CLERK_FRONTEND_API}; img-src 'self' data: ${CLERK_FRONTEND_API}; ` +
    `font-src 'self' data: ${CLERK_FRONTEND_API}; connect-src 'self' ${CLERK_FRONTEND_API}; ` +
    `frame-src ${CLERK_FRONTEND_API}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
  );
}

function htmlPage(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": clerkCsp(),
    },
  });
}

function authorizePage(requestId: string, publishableKey: string | undefined) {
  const signIn = publishableKey
    ? `<div id="clerk-sign-in"></div>
       <script defer crossorigin="anonymous" src="${CLERK_FRONTEND_API}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
       <script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(publishableKey)}" src="${CLERK_FRONTEND_API}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
       <script>
         window.addEventListener("load", async () => {
           const status = document.getElementById("status");
           let submitted = false;
           const submitSession = async (session) => {
             if (!session || submitted) return;
             submitted = true;
             try {
               const sessionToken = await session.getToken();
               const response = await fetch("/authorize", {
                 method: "POST",
                 headers: { "content-type": "application/json" },
                 body: JSON.stringify({ request: ${JSON.stringify(requestId)}, sessionToken })
               });
               const result = await response.json();
               if (!response.ok || typeof result.redirect !== "string") throw new Error("Sign-in could not be completed.");
               window.location.assign(result.redirect);
             } catch (error) {
               submitted = false;
               status.textContent = error instanceof Error ? error.message : "Sign-in could not be completed.";
             }
           };
           try {
             await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
             Clerk.addListener(({ session }) => { void submitSession(session); });
             if (Clerk.session) void submitSession(Clerk.session);
             else Clerk.mountSignIn(document.getElementById("clerk-sign-in"), ${clerkMountSignInOptions()});
           } catch {
             status.textContent = "Sign-in could not be loaded. Refresh and try again.";
           }
         });
       </script>`
    : "";
  return htmlPage(
    renderAuthPage({
      title: "Connect DroidBridge",
      heading: "Connect DroidBridge",
      intro: "Sign in to authorize this MCP client.",
      body: `${signIn}<p id="status" role="status"></p>`,
    }),
  );
}

function pairPage(publishableKey: string | undefined) {
  const signIn = publishableKey
    ? `<div id="clerk-sign-in"></div>
       <p id="code" hidden></p>
       <script defer crossorigin="anonymous" src="${CLERK_FRONTEND_API}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
       <script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(publishableKey)}" src="${CLERK_FRONTEND_API}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
       <script>
         window.addEventListener("load", async () => {
           const status = document.getElementById("status");
           let submitted = false;
           const submitSession = async (session) => {
             if (!session || submitted) return;
             submitted = true;
             try {
               const sessionToken = await session.getToken();
               const response = await fetch("/pair", {
                 method: "POST",
                 headers: { "content-type": "application/json" },
                 body: JSON.stringify({ sessionToken })
               });
               const result = await response.json();
               if (!response.ok || typeof result.code !== "string") throw new Error(result.error || "Could not issue a pairing code.");
               const codeEl = document.getElementById("code");
               codeEl.hidden = false;
               codeEl.textContent = result.code;
               status.textContent = "Enter this code in the DroidBridge app. It expires in 10 minutes.";
             } catch (error) {
               submitted = false;
               status.textContent = error instanceof Error ? error.message : "Could not issue a pairing code.";
             }
           };
           try {
             await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
             Clerk.addListener(({ session }) => { void submitSession(session); });
             if (Clerk.session) void submitSession(Clerk.session);
             else Clerk.mountSignIn(document.getElementById("clerk-sign-in"), ${clerkMountSignInOptions()});
           } catch {
             status.textContent = "Sign-in could not be loaded. Refresh and try again.";
           }
         });
       </script>`
    : "";
  return htmlPage(
    renderAuthPage({
      title: "Pair DroidBridge",
      heading: "Pair your phone",
      intro: "Sign in to get a one-time pairing code.",
      body: `${signIn}<p id="status" role="status"></p>`,
    }),
  );
}

function bearer(request: Request): string {
  return request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

function copyProtocolHeaders(source: Headers, contentType?: string): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of ["mcp-session-id", "mcp-protocol-version"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  if (contentType) headers.set("content-type", `${contentType}; charset=utf-8`);
  return headers;
}

function isNotificationOnly(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return (
    items.length > 0 &&
    items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { method?: unknown }).method === "string" &&
        !("id" in item),
    )
  );
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function firstRpcId(value: unknown): unknown {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (item && typeof item === "object" && "id" in item) return (item as { id: unknown }).id;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/healthz" && request.method === "GET") return json({ ok: true });
    if (path === "/.well-known/oauth-protected-resource" && request.method === "GET")
      return cors(
        request,
        json({
          resource: `${url.origin}/mcp`,
          authorization_servers: [url.origin],
          bearer_methods_supported: ["header"],
          scopes_supported: ["mcp"],
        }),
      );
    if (path === "/.well-known/oauth-authorization-server" && request.method === "GET")
      return cors(
        request,
        json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          registration_endpoint: `${url.origin}/register`,
          revocation_endpoint: `${url.origin}/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mcp"],
        }),
      );
    if (oauthPaths.has(path) && request.method === "OPTIONS")
      return cors(request, new Response(null, { status: 204 }));

    if (path === "/pair" && request.method === "GET") {
      if (!env.CLERK_PUBLISHABLE_KEY)
        return new Response("Sign-in is not configured.", { status: 503 });
      return pairPage(env.CLERK_PUBLISHABLE_KEY);
    }
    if (path === "/pair" && request.method === "POST") {
      if (request.headers.get("Origin") && request.headers.get("Origin") !== url.origin)
        return json({ error: "invalid_origin" }, 403);
      const body = (await request.json().catch(() => ({}))) as { sessionToken?: unknown };
      if (typeof body.sessionToken !== "string") return json({ error: "invalid_session" }, 400);
      let claims;
      try {
        claims = await verifyClerkSessionToken(body.sessionToken, env.CLERK_ALLOWED_ORIGINS ?? "");
      } catch {
        return json({ error: "invalid_session" }, 403);
      }
      const account = await getOrCreateAccount(env.DB, claims.sub);
      const code = randomPairingCode();
      await env.TOKENS.put(
        `pair:${await hash(code)}`,
        JSON.stringify({ accountId: account.id, clerkUserId: claims.sub }),
        { expirationTtl: PAIRING_TTL_SEC },
      );
      return json({ code, expiresIn: PAIRING_TTL_SEC });
    }

    if (path === "/device/pair" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        code?: unknown;
        deviceName?: unknown;
      };
      if (typeof body.code !== "string" || !body.code.trim())
        return json({ error: "code is required" }, 400);
      const code = body.code.trim().toUpperCase();
      if (!/^[A-Z2-9]{8}$/.test(code)) return json({ error: "invalid code" }, 400);
      const key = `pair:${await hash(code)}`;
      const stored = await env.TOKENS.get(key);
      if (!stored) return json({ error: "code expired or already used" }, 410);
      await env.TOKENS.delete(key);
      const record = JSON.parse(stored) as { accountId: string; clerkUserId: string };
      const now = Date.now();
      const previous = await listAccountDevices(env.DB, record.accountId);
      await revokeAccountDevices(env.DB, record.accountId, now);
      if (previous.length > 0) {
        const stub = new Request(`${url.origin}/internal/revoke`, { method: "POST" });
        await env.DEVICES.get(env.DEVICES.idFromName(record.clerkUserId)).fetch(stub);
      }
      const deviceToken = randomDeviceToken();
      const deviceId = crypto.randomUUID();
      const name =
        typeof body.deviceName === "string" && body.deviceName.trim()
          ? body.deviceName.trim().slice(0, 100)
          : "Phone";
      await saveDevice(env.DB, {
        device_id: deviceId,
        account_id: record.accountId,
        name,
        credential_hash: await hash(deviceToken),
        created_at: now,
        revoked_at: null,
      });
      return json({
        deviceToken,
        accountId: record.accountId,
        mcpUrl: `${url.origin}/mcp`,
      });
    }

    if (path === "/device/unpair" && request.method === "POST") {
      const token = bearer(request);
      const body = (await request.json().catch(() => ({}))) as { sessionToken?: unknown };
      const session = token || (typeof body.sessionToken === "string" ? body.sessionToken : "");
      if (!session) return json({ error: "unauthorized" }, 401);
      let claims;
      try {
        claims = await verifyClerkSessionToken(session, env.CLERK_ALLOWED_ORIGINS ?? "");
      } catch {
        return json({ error: "unauthorized" }, 401);
      }
      const account = await getOrCreateAccount(env.DB, claims.sub);
      await revokeAccountDevices(env.DB, account.id);
      await env.DEVICES.get(env.DEVICES.idFromName(claims.sub)).fetch(
        new Request(`${url.origin}/internal/revoke`, { method: "POST" }),
      );
      return json({ ok: true });
    }

    if (path === "/device/ws" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const token =
        bearer(request) || url.searchParams.get("token")?.trim() || "";
      if (!token) return new Response("Unauthorized", { status: 401 });
      const device = await getDeviceByCredentialHash(env.DB, await hash(token));
      if (!device) return new Response("Unauthorized", { status: 401 });
      const account = await getAccountById(env.DB, device.account_id);
      if (!account) return new Response("Unauthorized", { status: 401 });
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.set("x-droidbridge-account-id", account.id);
      headers.set("x-droidbridge-clerk-user-id", account.clerk_user_id);
      headers.set("x-droidbridge-device-id", device.device_id);
      return env.DEVICES.get(env.DEVICES.idFromName(account.clerk_user_id)).fetch(
        new Request(request, { headers }),
      );
    }
    if (path === "/device/ws") return new Response("Upgrade Required", { status: 426 });

    if (path === "/register" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { redirect_uris?: unknown };
      const redirects = body.redirect_uris;
      if (
        !Array.isArray(redirects) ||
        redirects.length === 0 ||
        redirects.some((uri) => typeof uri !== "string" || !/^https?:\/\//.test(uri))
      )
        return cors(request, json({ error: "invalid_client_metadata" }, 400));
      const clientId = crypto.randomUUID();
      await createOAuthClient(env.DB, clientId, redirects as string[]);
      return cors(
        request,
        json(
          {
            client_id: clientId,
            redirect_uris: redirects,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          },
          201,
        ),
      );
    }
    if (path === "/authorize" && request.method === "GET") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const resource = url.searchParams.get("resource");
      const client = await getOAuthClient(env.DB, clientId);
      let redirectUris: string[] = [];
      try {
        redirectUris = client ? (JSON.parse(client.redirect_uris_json) as string[]) : [];
      } catch {
        redirectUris = [];
      }
      let validResource = true;
      if (resource) {
        try {
          const parsedResource = new URL(resource);
          validResource =
            parsedResource.protocol === "https:" &&
            parsedResource.toString() === `${url.origin}/mcp`;
        } catch {
          validResource = false;
        }
      }
      if (
        !validResource ||
        !redirectUris.includes(redirectUri) ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)
      )
        return new Response("Invalid OAuth request", { status: 400 });
      const consentRequest = newSecret("req_");
      await env.TOKENS.put(
        `consent:${await hash(consentRequest)}`,
        JSON.stringify({
          clientId,
          redirectUri,
          challenge,
          state,
          resource,
        }),
        { expirationTtl: 300 },
      );
      if (!env.CLERK_PUBLISHABLE_KEY)
        return new Response("Sign-in is not configured.", { status: 503 });
      return authorizePage(consentRequest, env.CLERK_PUBLISHABLE_KEY);
    }
    if (path === "/authorize" && request.method === "POST") {
      if (request.headers.get("Origin") !== url.origin)
        return json({ error: "invalid_origin" }, 403);
      const body = (await request.json().catch(() => ({}))) as {
        request?: unknown;
        sessionToken?: unknown;
      };
      if (typeof body.request !== "string" || typeof body.sessionToken !== "string")
        return json({ error: "invalid_authorization" }, 400);
      const consentKey = `consent:${await hash(body.request)}`;
      const consent = await env.TOKENS.get(consentKey);
      if (!consent) return json({ error: "authorization_expired" }, 403);
      let claims;
      try {
        claims = await verifyClerkSessionToken(body.sessionToken, env.CLERK_ALLOWED_ORIGINS ?? "");
      } catch {
        return json({ error: "invalid_session" }, 403);
      }
      const account = await getOrCreateAccount(env.DB, claims.sub);
      const record = JSON.parse(consent) as AuthorizationRecord;
      const redirect = await completeAuthorization(env, account.id, record);
      await env.TOKENS.delete(consentKey);
      return json({ redirect });
    }
    if (path === "/token" && request.method === "POST") {
      const form = await request.formData();
      if (form.get("grant_type") === "authorization_code") {
        const code = String(form.get("code") ?? "");
        const key = `code:${await hash(code)}`;
        const value = await env.TOKENS.get(key);
        if (!value) return cors(request, json({ error: "invalid_grant" }, 400));
        await env.TOKENS.delete(key);
        const record = JSON.parse(value) as {
          accountId: string;
          clientId: string;
          redirectUri: string;
          challenge: string;
          resource?: string | null;
        };
        const verifier = String(form.get("code_verifier") ?? "");
        const derived = b64url(
          new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))),
        );
        if (
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          derived !== record.challenge ||
          form.get("client_id") !== record.clientId ||
          form.get("redirect_uri") !== record.redirectUri ||
          (record.resource && form.get("resource") !== record.resource)
        )
          return cors(request, json({ error: "invalid_grant" }, 400));
        return cors(request, await issueOAuth(env, record.accountId, record.clientId));
      }
      if (form.get("grant_type") === "refresh_token") {
        const token = String(form.get("refresh_token") ?? "");
        const stored = await getOAuthToken(env.DB, await hash(token));
        if (!stored || stored.token_type !== "refresh")
          return cors(request, json({ error: "invalid_grant" }, 400));
        if (stored.client_id && form.get("client_id") && form.get("client_id") !== stored.client_id)
          return cors(request, json({ error: "invalid_grant" }, 400));
        await revokeOAuthToken(env, token);
        return cors(request, await issueOAuth(env, stored.account_id, stored.client_id));
      }
      return cors(request, json({ error: "unsupported_grant_type" }, 400));
    }
    if (path === "/revoke" && request.method === "POST") {
      const form = await request.formData();
      const token = String(form.get("token") ?? "");
      if (token) await revokeOAuthToken(env, token);
      return cors(
        request,
        new Response(null, { status: 200, headers: { "cache-control": "no-store" } }),
      );
    }

    if (path === "/mcp" && ["GET", "POST", "DELETE"].includes(request.method)) {
      const token = bearer(request);
      const accountId = token ? await accountForOAuthBearer(env, token) : null;
      if (!accountId)
        return cors(
          request,
          new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
            },
          }),
        );
      const account = await getAccountById(env.DB, accountId);
      if (!account)
        return cors(
          request,
          new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
            },
          }),
        );
      return cors(request, await handleMcp(request, env, account));
    }    return json({ error: "not_found" }, 404);
  },
};

// ---- Relay-side MCP handling -------------------------------------------------
// The relay answers the MCP handshake and tool discovery itself so ChatGPT can
// connect even while the phone is offline. Only tools/call goes to the phone.
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const PHONE_PROTOCOL_VERSION = "2026-07-28";
const PHONE_META_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO = { name: "DroidBridge", version: "relay" };

export const VOICE_INSTRUCTIONS =
  "DroidBridge controls the user's Android phone. Rules: (1) CONFIRM OUT LOUD: before any critical or irreversible action - sending a text, message, or email, calling someone, submitting a form, buying or paying, deleting data, changing settings, or running a shell command that modifies anything - tell the user in plain words exactly what you are about to do (who, what, content) and ask 'Should I go ahead?'. Wait for the user's spoken yes. If they say no or are unsure, do not do it. Do not rely on any on-screen approval dialog; the user's spoken answer is the confirmation. Reading the screen, taking screenshots, and checking status need no confirmation. (2) PREFER BACKGROUND SHELL: when Shizuku is available, do tasks with the shell tool (e.g. am start/broadcast intents, settings put/get, cmd, content queries, service call) instead of opening and driving apps on screen; use the UI tools (screen, tap, type, swipe, open_app, navigate) only when shell cannot do it or the user asks. (3) SHIZUKU: shell and any Shizuku-backed tool require Shizuku to be running and authorized for DroidBridge. Call shizuku_status once at the start of a session before using them; if it reports not connected, tell the user and fall back to UI tools. A SHIZUKU_NOT_CONNECTED error means the same. (4) After UI actions, the reply contains the new screen; read it before acting again.";

const toolDef = (
  name: string,
  title: string,
  description: string,
  readOnly: boolean,
  inputSchema: Record<string, unknown>,
) => ({
  name,
  title,
  description,
  inputSchema,
  annotations: readOnly
    ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
});
export const AUTOMATION_TRIGGER_SCHEMA = {
  type: "object",
  description:
    "Trigger condition for when the automation should fire. Must be one of: 'at' (specific timestamp), 'interval' (periodic milliseconds), 'rrule' (calendar recurrence), or 'event' (system event).",
  oneOf: [
    {
      type: "object",
      description: "Trigger at an exact point in time (ISO 8601 string)",
      properties: {
        type: { type: "string", enum: ["at"], description: "Trigger kind 'at'" },
        at: { type: "string", description: "ISO 8601 / RFC 3339 timestamp string (e.g. '2026-10-27T08:00:00Z')" },
      },
      required: ["type", "at"],
    },
    {
      type: "object",
      description: "Trigger periodically at a fixed interval in milliseconds",
      properties: {
        type: { type: "string", enum: ["interval"], description: "Trigger kind 'interval'" },
        every_ms: {
          type: "integer",
          minimum: 60000,
          maximum: 2592000000,
          description: "Interval period in milliseconds (min 60000 ms [1m], max 2592000000 ms [30d])",
        },
      },
      required: ["type", "every_ms"],
    },
    {
      type: "object",
      description: "Trigger on a recurring calendar schedule using RFC 5545 RRULE syntax and IANA timezone",
      properties: {
        type: { type: "string", enum: ["rrule"], description: "Trigger kind 'rrule'" },
        rrule: { type: "string", description: "iCalendar RFC 5545 recurrence rule (e.g. 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0')" },
        timezone: { type: "string", description: "IANA timezone identifier (e.g. 'America/New_York' or 'UTC')" },
      },
      required: ["type", "rrule", "timezone"],
    },
    {
      type: "object",
      description: "Trigger when a system or device event occurs",
      properties: {
        type: { type: "string", enum: ["event"], description: "Trigger kind 'event'" },
        name: { type: "string", description: "Event name string (e.g. 'battery_low', 'screen_off', 'boot_completed')" },
        match: {
          type: "object",
          description: "Optional key-value filters to match against event payload",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
      },
      required: ["type", "name"],
    },
  ],
};

export const AUTOMATION_ACTION_SCHEMA = {
  type: "object",
  description:
    "Action tree node to execute when triggered. Can be a 'call', 'sequence', 'conditional', 'repeat', 'delay', or 'set_state'.",
  oneOf: [
    {
      type: "object",
      description: "Execute a device tool (command, android, visual, filesystem, or network)",
      properties: {
        type: { type: "string", enum: ["call"], description: "Action kind 'call'" },
        tool: {
          type: "string",
          enum: ["command", "android", "visual", "filesystem", "network"],
          description: "Target tool name",
        },
        action: {
          type: "string",
          description:
            "Tool action: 'run' for command; 'launch' or 'clipboard' for android; 'element' or 'interact' for visual; 'manage' or 'download' for filesystem; 'diagnose' for network",
        },
        args: {
          type: "object",
          description:
            "Arguments for the tool action. E.g. command run: {\"command\": \"...\", \"run_as\": \"shell\"}; android launch: {\"operation\": \"package\", \"package_name\": \"com.android.settings\"}; android clipboard: {\"operation\": \"clear\"}; visual element: {\"operation\": \"tap\", \"by\": \"text\", \"value\": \"Settings\"}",
        },
        on_failure: {
          type: "string",
          enum: ["stop", "continue"],
          default: "stop",
          description:
            "'stop' (default) ends execution on failure; 'continue' records failure for result condition and proceeds",
        },
      },
      required: ["type", "tool", "action", "args"],
    },
    {
      type: "object",
      description: "Execute child actions sequentially in order",
      properties: {
        type: { type: "string", enum: ["sequence"], description: "Action kind 'sequence'" },
        children: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          description: "Array of child action nodes (1 to 64 items)",
          items: { type: "object", description: "Action node" },
        },
      },
      required: ["type", "children"],
    },
    {
      type: "object",
      description: "Conditional branching based on state variable, trigger payload, or previous step result",
      properties: {
        type: { type: "string", enum: ["conditional"], description: "Action kind 'conditional'" },
        condition: {
          type: "object",
          description: "Condition check",
          properties: {
            source: {
              type: "string",
              enum: ["state", "trigger", "result"],
              description: "Source of value: state variable, trigger payload, or previous step result",
            },
            key: { type: "string", description: "Key to evaluate in source" },
            operator: {
              type: "string",
              enum: ["equals", "not_equals", "greater_than", "less_than", "exists"],
              description: "Comparison operator",
            },
            value: {
              type: ["string", "number", "boolean"],
              description: "Value to compare against (omitted for 'exists')",
            },
          },
          required: ["source", "key", "operator"],
        },
        then: { type: "object", description: "Action node to execute if condition is true" },
        else: { type: "object", description: "Optional action node to execute if condition is false" },
      },
      required: ["type", "condition", "then"],
    },
    {
      type: "object",
      description: "Repeat an action a specified number of times with optional delay between repetitions",
      properties: {
        type: { type: "string", enum: ["repeat"], description: "Action kind 'repeat'" },
        count: { type: "integer", minimum: 1, maximum: 1000, description: "Number of iterations (1-1000)" },
        action: { type: "object", description: "Action node to repeat" },
        delay_ms: {
          type: "integer",
          minimum: 0,
          maximum: 86400000,
          default: 0,
          description: "Delay between iterations in milliseconds (0-86400000 ms)",
        },
      },
      required: ["type", "count", "action"],
    },
    {
      type: "object",
      description: "Pause execution for a fixed duration",
      properties: {
        type: { type: "string", enum: ["delay"], description: "Action kind 'delay'" },
        duration_ms: {
          type: "integer",
          minimum: 1,
          maximum: 86400000,
          description: "Duration to pause in milliseconds (1 to 86400000 ms [up to 24 hours])",
        },
      },
      required: ["type", "duration_ms"],
    },
    {
      type: "object",
      description: "Store a persistent state variable in the automation's state map",
      properties: {
        type: { type: "string", enum: ["set_state"], description: "Action kind 'set_state'" },
        key: { type: "string", description: "State variable key name" },
        value: { type: ["string", "number", "boolean"], description: "Scalar value to store" },
      },
      required: ["type", "key", "value"],
    },
  ],
};

// Mirrors voice_tool_definitions() in rust/crates/runtime/src/voice_mcp.rs.
export const VOICE_TOOLS = [
  toolDef(
    "screen",
    "Read Screen",
    "Use this when reading the current screen state as a compact node tree. The reply is the new screen.",
    true,
    { type: "object", properties: {} },
  ),
  toolDef(
    "tap",
    "Tap Screen",
    "Use this when tapping an interactive element or text on the screen, then returning the new screen. Before critical actions (sending, submitting, buying, deleting, changing settings) say exactly what you will do and get the user's spoken yes first.",
    false,
    {
      type: "object",
      properties: {
        node_ref: { type: "string", description: "Node reference ID of the element to tap" },
        text: { type: "string", description: "Visible text of the element to tap if node_ref is not known" },
      },
    },
  ),
  toolDef(
    "long_press",
    "Long Press Screen",
    "Use this when long-pressing an element or text on the screen, then returning the new screen. Before critical actions (sending, submitting, buying, deleting, changing settings) say exactly what you will do and get the user's spoken yes first.",
    false,
    {
      type: "object",
      properties: {
        node_ref: { type: "string", description: "Node reference ID of the element to long-press" },
        text: { type: "string", description: "Visible text of the element to long-press" },
      },
    },
  ),
  toolDef(
    "swipe",
    "Swipe Screen",
    "Use this when swiping or scrolling on the screen, then returning the new screen. Before critical actions (sending, submitting, buying, deleting, changing settings) say exactly what you will do and get the user's spoken yes first.",
    false,
    {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Swipe direction (up, down, left, right)" },
        from_x: { type: "integer", description: "Starting X coordinate in display pixels" },
        from_y: { type: "integer", description: "Starting Y coordinate in display pixels" },
        to_x: { type: "integer", description: "Ending X coordinate in display pixels" },
        to_y: { type: "integer", description: "Ending Y coordinate in display pixels" },
      },
    },
  ),
  toolDef(
    "type",
    "Type Text",
    "Use this when typing text into a focused or named field, then returning the new screen. Before critical actions (sending, submitting, buying, deleting, changing settings) say exactly what you will do and get the user's spoken yes first.",
    false,
    {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to type into the target field" },
        node_ref: { type: "string", description: "Node reference ID of the target field" },
        field: { type: "string", description: "Label or placeholder of the target field" },
      },
      required: ["text"],
    },
  ),
  toolDef(
    "open_app",
    "Open App",
    "Use this when launching an app by its package name, then returning the new screen. Before critical actions (sending, submitting, buying, deleting, changing settings) say exactly what you will do and get the user's spoken yes first.",
    false,
    {
      type: "object",
      properties: {
        package: { type: "string", description: "Android package name to launch" },
      },
      required: ["package"],
    },
  ),
  toolDef(
    "navigate",
    "Navigate",
    "Use this when pressing Back, Home, or Recents, then returning the new screen. Before critical actions (sending, submitting, buying, deleting, changing settings) say exactly what you will do and get the user's spoken yes first.",
    false,
    {
      type: "object",
      properties: {
        destination: { type: "string", enum: ["back", "home", "recents"], description: "Navigation action: back, home, or recents" },
      },
      required: ["destination"],
    },
  ),
  toolDef(
    "screenshot",
    "Take Screenshot",
    "Use this when capturing screen pixels is needed to inspect visual appearance. The reply is the new screen.",
    true,
    { type: "object", properties: {} },
  ),
  toolDef(
    "shizuku_status",
    "Shizuku Status",
    "Use this when checking if Shizuku is running and authorized for DroidBridge before running shell commands.",
    true,
    { type: "object", properties: {} },
  ),
  toolDef(
    "shell",
    "Execute Shell Command",
    "Use this when executing a shell command via Shizuku. Requires Shizuku running and authorized (check shizuku_status first). Prefer this over driving apps on screen. Before critical actions (sending, submitting, buying, deleting, changing settings) say exactly what you will do and get the user's spoken yes first.",
    false,
    {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run via Shizuku" },
        timeout_ms: { type: "integer", description: "Execution timeout in milliseconds (1000-60000, default 15000)", minimum: 1000, maximum: 60000, default: 15000 },
        max_output_bytes: { type: "integer", description: "Maximum bytes of output to return (1-65536, default 16384)", minimum: 1, maximum: 65536, default: 16384 },
      },
      required: ["command"],
    },
  ),
  toolDef(
    "automation_list",
    "List Automations",
    "Use this when listing persistent automations saved on the phone.",
    true,
    {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maximum number of automations to return (1-500, default 100)", minimum: 1, maximum: 500, default: 100 },
      },
    },
  ),
  toolDef(
    "automation_get",
    "Get Automation",
    "Use this when viewing an automation definition and recent execution history by ID.",
    true,
    {
      type: "object",
      properties: {
        automation_id: { type: "string", description: "UUID of the automation to retrieve" },
        history_limit: { type: "integer", description: "Maximum number of history entries (1-100, default 20)", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["automation_id"],
    },
  ),
  toolDef(
    "automation_create",
    "Create Automation",
    "CRITICAL: before calling, say out loud the automation's name, trigger and actions (or which one is deleted) and wait for the user's spoken yes. Use this when creating a persistent automation on the phone. Trigger kinds: (1) at: exact timestamp 'at' (e.g. {\"type\":\"at\",\"at\":\"2026-10-27T08:00:00Z\"}), (2) interval: periodic milliseconds 'every_ms' (60000-2592000000, e.g. {\"type\":\"interval\",\"every_ms\":3600000}), (3) rrule: iCalendar 'rrule' with 'timezone' (e.g. {\"type\":\"rrule\",\"rrule\":\"FREQ=DAILY;BYHOUR=9;BYMINUTE=0\",\"timezone\":\"America/New_York\"}), (4) event: system event 'name' with optional 'match' (e.g. {\"type\":\"event\",\"name\":\"battery_low\"}). Action kinds: (1) call: device tool with 'tool', 'action', 'args', optional 'on_failure' ('stop'|'continue'), e.g. tool 'command' action 'run' args {\"command\":\"settings put system screen_brightness 100\",\"run_as\":\"shell\"} or tool 'android' action 'launch' args {\"operation\":\"package\",\"package_name\":\"com.android.settings\"}, (2) sequence: list of child actions in 'children', (3) conditional: checks 'condition' ({source:'state'|'trigger'|'result',key,operator,value}) then runs 'then' and optional 'else', (4) repeat: repeats 'action' for 'count' (1-1000) with optional 'delay_ms', (5) delay: pauses for 'duration_ms' (1-86400000), (6) set_state: stores 'key' and scalar 'value'. Example create: {\"name\":\"mute_at_night\",\"enabled\":true,\"trigger\":{\"type\":\"at\",\"at\":\"2026-10-27T22:00:00Z\"},\"action\":{\"type\":\"call\",\"tool\":\"command\",\"action\":\"run\",\"args\":{\"command\":\"cmd audio set-volume 0\",\"run_as\":\"shell\"}}}.",
    false,
    {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the automation" },
        enabled: { type: "boolean", description: "Whether the automation is enabled upon creation" },
        trigger: AUTOMATION_TRIGGER_SCHEMA,
        action: AUTOMATION_ACTION_SCHEMA,
      },
      required: ["name", "enabled", "trigger", "action"],
    },
  ),
  toolDef(
    "automation_update",
    "Update Automation",
    "CRITICAL: before calling, say out loud the automation's name, trigger and actions (or which one is deleted) and wait for the user's spoken yes. Use this when editing an existing persistent automation on the phone (requires automation_id and current expected_revision from automation_get or automation_list). Trigger kinds: (1) at: exact timestamp 'at' (ISO 8601), (2) interval: milliseconds 'every_ms' (60000-2592000000), (3) rrule: recurrence rule 'rrule' with 'timezone', (4) event: event 'name' with optional 'match'. Action kinds: (1) call: 'tool', 'action', 'args', optional 'on_failure', (2) sequence: 'children', (3) conditional: 'condition', 'then', optional 'else', (4) repeat: 'count', 'action', optional 'delay_ms', (5) delay: 'duration_ms', (6) set_state: 'key', 'value'.",
    false,
    {
      type: "object",
      properties: {
        automation_id: { type: "string", description: "UUID of the existing automation to update" },
        expected_revision: { type: "integer", description: "Current revision from automation_get or automation_list" },
        name: { type: "string", description: "Name for the automation" },
        enabled: { type: "boolean", description: "Whether the automation is enabled" },
        trigger: AUTOMATION_TRIGGER_SCHEMA,
        action: AUTOMATION_ACTION_SCHEMA,
      },
      required: ["automation_id", "expected_revision", "name", "enabled", "trigger", "action"],
    },
  ),
  toolDef(
    "automation_set_enabled",
    "Set Automation Enabled",
    "Use this when enabling or disabling an existing automation. Before critical actions (sending, submitting, buying, deleting, changing settings) say exactly what you will do and get the user's spoken yes first.",
    false,
    {
      type: "object",
      properties: {
        automation_id: { type: "string", description: "UUID of the automation" },
        enabled: { type: "boolean", description: "True to enable, false to disable" },
        expected_revision: { type: "integer", description: "Current revision from automation_get or automation_list" },
      },
      required: ["automation_id", "enabled", "expected_revision"],
    },
  ),
  toolDef(
    "automation_delete",
    "Delete Automation",
    "CRITICAL: before calling, say out loud the automation's name, trigger and actions (or which one is deleted) and wait for the user's spoken yes. Use this when deleting an automation by ID. Requires automation_id and current expected_revision from automation_get or automation_list.",
    false,
    {
      type: "object",
      properties: {
        automation_id: { type: "string", description: "UUID of the automation to delete" },
        expected_revision: { type: "integer", description: "Current revision from automation_get or automation_list" },
      },
      required: ["automation_id", "expected_revision"],
    },
  ),
  toolDef(
    "automation_run",
    "Run Automation",
    "Use this when immediately running an existing automation outside its normal schedule. Before critical actions (sending, submitting, buying, deleting, changing settings) say exactly what you will do and get the user's spoken yes first.",
    false,
    {
      type: "object",
      properties: {
        automation_id: { type: "string", description: "UUID of the automation to run" },
      },
      required: ["automation_id"],
    },
  ),
];
const VOICE_TOOL_NAMES = new Set(VOICE_TOOLS.map((tool) => tool.name));

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
const rpcOk = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const toolError = (id: unknown, text: string) =>
  rpcOk(id, { content: [{ type: "text", text }], isError: true });

async function handleOne(
  msg: Rpc,
  env: Env,
  account: { id: string; clerk_user_id: string },
  ctx: { sessionId?: string; protocolVersion?: string },
): Promise<unknown | null> {
  const isRequest = msg && typeof msg === "object" && "id" in msg && msg.id !== undefined;
  const method = typeof msg?.method === "string" ? msg.method : "";
  if (!isRequest) return null; // notifications (incl. notifications/initialized) -> 202
  const id = msg.id;
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      ctx.protocolVersion = version;
      ctx.sessionId = crypto.randomUUID();
      return rpcOk(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: VOICE_INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcOk(id, {});
    case "tools/list":
      return rpcOk(id, { tools: VOICE_TOOLS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!VOICE_TOOL_NAMES.has(name))
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const forwardBody = {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: params.arguments ?? {},
          _meta: {
            [PHONE_META_KEY]: PHONE_PROTOCOL_VERSION,
            // The phone (mcp.rs validate_metadata_headers) rejects tools/call with -32602
            // unless clientCapabilities is an object; clientInfo is optional but must be well-formed.
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "droidbridge-relay", version: "1" },
          },
        },
      };
      const response = await env.DEVICES.get(env.DEVICES.idFromName(account.clerk_user_id)).fetch(
        new Request("https://device.internal/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-droidbridge-account-id": account.id,
            "x-droidbridge-clerk-user-id": account.clerk_user_id,
            "mcp-protocol-version": PHONE_PROTOCOL_VERSION,
            "mcp-method": "tools/call",
            "mcp-name": name,
          },
          body: JSON.stringify(forwardBody),
        }),
      );
      const text = await response.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      const code = parsed?.error?.code;
      if (code === -32002 || response.status === 503)
        return toolError(id, "DroidBridge phone is offline. Open DroidBridge on the phone and check that the relay shows Connected.");
      if (code === -32001 || response.status === 504)
        return toolError(id, "DroidBridge phone did not respond in time. Try again.");
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
        if (parsed.result && typeof parsed.result === "object") delete parsed.result.resultType;
        if (parsed.error) return toolError(id, `DroidBridge error: ${parsed.error.message ?? "unknown"}`);
        return { jsonrpc: "2.0", id, result: parsed.result };
      }
      return toolError(id, `DroidBridge phone returned HTTP ${response.status}.`);
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  }
}

async function handleMcp(
  request: Request,
  env: Env,
  account: { id: string; clerk_user_id: string },
): Promise<Response> {
  if (request.method === "GET")
    return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  const decoded = (await request.json().catch(() => undefined)) as Rpc | Rpc[] | undefined;
  if (decoded === undefined || decoded === null || typeof decoded !== "object")
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  const ctx: { sessionId?: string; protocolVersion?: string } = {};
  const batch = Array.isArray(decoded);
  const items = batch ? (decoded as Rpc[]) : [decoded as Rpc];
  const results = (await Promise.all(items.map((item) => handleOne(item, env, account, ctx)))).filter(
    (item) => item !== null,
  );
  const headers = new Headers({ "cache-control": "no-store" });
  const sessionId = ctx.sessionId ?? request.headers.get("mcp-session-id");
  if (sessionId) headers.set("Mcp-Session-Id", sessionId);
  const version = ctx.protocolVersion ?? request.headers.get("mcp-protocol-version");
  if (version) headers.set("MCP-Protocol-Version", version);
  if (results.length === 0) return new Response(null, { status: 202, headers });
  const payload = JSON.stringify(batch ? results : results[0]);
  const accept = request.headers.get("Accept") ?? "";
  if (accept.includes("text/event-stream") && !accept.startsWith("application/json")) {
    headers.set("content-type", "text/event-stream");
    return new Response(`event: message\ndata: ${payload}\n\n`, { status: 200, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(payload, { status: 200, headers });
}
interface RelaySocketWithAttachment extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export class DeviceRelay {
  private readonly pending = new Map<
    string,
    { resolve: (response: Response) => void; socket: WebSocket }
  >();

  constructor(private readonly state: DurableObjectState) {
    if (
      typeof state.setWebSocketAutoResponse === "function" &&
      typeof WebSocketRequestResponsePair !== "undefined"
    ) {
      try {
        state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      } catch {
        /* test runtimes */
      }
    }
  }

  private sockets(): WebSocket[] {
    return this.state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/internal/revoke") && request.method === "POST") {
      for (const socket of this.sockets()) {
        try {
          socket.send(JSON.stringify({ type: "revoked" }));
        } catch {
          /* ignore */
        }
        socket.close(4001, "unpaired");
      }
      return json({ ok: true });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      const deviceId = request.headers.get("x-droidbridge-device-id") ?? "";
      (pair[1] as RelaySocketWithAttachment).serializeAttachment({ deviceId });
      for (const socket of this.sockets()) {
        if (socket === pair[1]) continue;
        try {
          socket.send(JSON.stringify({ type: "revoked" }));
        } catch {
          /* ignore */
        }
        socket.close(4001, "replaced");
      }
      return new Response(null, { status: 101, webSocket: pair[0] } as UpgradeResponseInit);
    }

    const rawBody = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
    let decoded: unknown = null;
    try {
      decoded = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      decoded = null;
    }
    const live = this.sockets();
    const socket = live[0];
    if (!socket) {
      return json(rpcError(firstRpcId(decoded), -32002, "device offline"), 503);
    }
    const id = crypto.randomUUID();
    const headers: Record<string, string> = {};
    const sessionId = request.headers.get("mcp-session-id");
    const protocolVersion = request.headers.get("mcp-protocol-version");
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    for (const extra of ["mcp-method", "mcp-name"]) {
      const value = request.headers.get(extra);
      if (value) headers[extra] = value;
    }
    const frame = {
      type: "rpc",
      id,
      body: decoded ?? (rawBody ? rawBody : null),
      headers,
    };
    const encoded = JSON.stringify(frame);
    if (encoder.encode(encoded).byteLength > MAX_FRAME_BYTES)
      return json({ error: "frame too large" }, 413);
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(json(rpcError(firstRpcId(decoded), -32001, "device timeout"), 504));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        socket,
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
      });
      try {
        socket.send(encoded);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(json(rpcError(firstRpcId(decoded), -32002, "device offline"), 503));
      }
    });
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const payload = typeof message === "string" ? message : new TextDecoder().decode(message);
      if (encoder.encode(payload).byteLength > MAX_FRAME_BYTES) {
        _socket.close(1009, "frame too large");
        return;
      }
      const parsed = JSON.parse(payload) as {
        type?: string;
        t?: number;
        id?: string;
        status?: number;
        body?: unknown;
        headers?: Record<string, string>;
      };
      if (parsed.type === "ping") {
        _socket.send(JSON.stringify({ type: "pong", t: parsed.t }));
        return;
      }
      if (parsed.type !== "rpc_result" || typeof parsed.id !== "string") return;
      const entry = this.pending.get(parsed.id);
      if (!entry || entry.socket !== _socket) return;
      this.pending.delete(parsed.id);
      const status = Number.isInteger(parsed.status) ? parsed.status! : 200;
      const headers = new Headers();
      if (parsed.headers) {
        for (const [key, value] of Object.entries(parsed.headers)) {
          if (key.toLowerCase() === "set-cookie" || key.toLowerCase() === "authorization") continue;
          headers.set(key, value);
        }
      }
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      const body =
        parsed.body === null || parsed.body === undefined
          ? ""
          : typeof parsed.body === "string"
            ? parsed.body
            : JSON.stringify(parsed.body);
      entry.resolve(new Response(body, { status, headers }));
    } catch {
      /* ignore invalid frames */
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.failPending(socket);
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    await this.failPending(socket);
  }
  private async failPending(socket: WebSocket): Promise<void> {
    for (const [id, entry] of this.pending) {
      if (entry.socket !== socket) continue;
      entry.resolve(json(rpcError(null, -32002, "device offline"), 503));
      this.pending.delete(id);
    }
  }
}
