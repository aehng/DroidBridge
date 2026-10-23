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
      const isRpcNotification =
        request.method === "POST" &&
        isNotificationOnly(await request.clone().json().catch(() => null));
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.set("x-droidbridge-account-id", account.id);
      headers.set("x-droidbridge-clerk-user-id", account.clerk_user_id);
      const response = await env.DEVICES.get(env.DEVICES.idFromName(account.clerk_user_id)).fetch(
        new Request(request, { headers }),
      );
      if (isRpcNotification && (response.ok || response.status === 202))
        return cors(
          request,
          new Response(null, { status: 202, headers: copyProtocolHeaders(response.headers) }),
        );
      const wantsSse =
        request.method === "POST" &&
        (request.headers.get("Accept") ?? "").includes("text/event-stream") &&
        !(request.headers.get("Accept") ?? "").startsWith("application/json");
      if (
        wantsSse &&
        response.ok &&
        response.headers.get("content-type")?.includes("application/json")
      ) {
        const payload = await response.text();
        return cors(
          request,
          new Response(`event: message\ndata: ${payload}\n\n`, {
            status: response.status,
            headers: copyProtocolHeaders(response.headers, "text/event-stream"),
          }),
        );
      }
      return cors(request, response);
    }
    return json({ error: "not_found" }, 404);
  },
};

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
