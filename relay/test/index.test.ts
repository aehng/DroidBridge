import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, {
  DeviceRelay,
  hash,
  type DurableObjectState,
  type Env,
  type KVNamespace,
} from "../src/index";
import type {
  AccountRow,
  D1Database,
  D1PreparedStatement,
  DeviceRow,
  OAuthClientRow,
  OAuthTokenRow,
} from "../src/db";
import { CLERK_FRONTEND_API } from "../src/clerkJwt";

class TestD1 implements D1Database {
  readonly accounts = new Map<string, AccountRow>();
  readonly clients = new Map<string, OAuthClientRow>();
  readonly tokens = new Map<string, OAuthTokenRow>();
  readonly devices = new Map<string, DeviceRow>();

  prepare(query: string): D1PreparedStatement {
    return new TestD1Statement(this, query);
  }

  first<T>(query: string, values: unknown[]): T | null {
    const sql = query.replace(/\s+/g, " ").trim().toLowerCase();
    let row: unknown;
    if (sql.includes("from accounts where clerk_user_id"))
      row = [...this.accounts.values()].find((account) => account.clerk_user_id === values[0]);
    else if (sql.includes("from accounts where id")) row = this.accounts.get(String(values[0]));
    else if (sql.includes("from oauth_clients")) row = this.clients.get(String(values[0]));
    else if (sql.includes("from oauth_tokens")) {
      const token = this.tokens.get(String(values[0]));
      row = token
        ? token.expires_at !== null && token.expires_at <= Date.now()
          ? null
          : token
        : null;
    } else if (sql.includes("from devices where credential_hash"))
      row = [...this.devices.values()].find(
        (device) => device.credential_hash === values[0] && device.revoked_at === null,
      );
    else throw new Error(`Unexpected D1 query: ${query}`);
    return row ? (structuredClone(row) as T) : null;
  }

  all<T>(query: string, values: unknown[]): T[] {
    if (!query.toLowerCase().includes("from devices where account_id")) return [];
    return [...this.devices.values()]
      .filter((device) => device.account_id === values[0] && device.revoked_at === null)
      .map((device) => structuredClone(device) as T);
  }

  run(query: string, values: unknown[]): void {
    const sql = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("insert or ignore into accounts")) {
      if (![...this.accounts.values()].some((account) => account.clerk_user_id === values[1])) {
        const row: AccountRow = {
          id: String(values[0]),
          clerk_user_id: String(values[1]),
          created_at: Number(values[2]),
        };
        this.accounts.set(row.id, row);
      }
    } else if (sql.startsWith("insert into oauth_clients")) {
      this.clients.set(String(values[0]), {
        client_id: String(values[0]),
        redirect_uris_json: String(values[1]),
        created_at: Number(values[2]),
      });
    } else if (sql.startsWith("insert into oauth_tokens")) {
      const row: OAuthTokenRow = {
        token_hash: String(values[0]),
        token_type: values[1] as OAuthTokenRow["token_type"],
        account_id: String(values[2]),
        client_id: values[3] === null ? null : String(values[3]),
        paired_token_hash: values[4] === null ? null : String(values[4]),
        expires_at: values[5] === null ? null : Number(values[5]),
        created_at: Number(values[6]),
      };
      this.tokens.set(row.token_hash, row);
    } else if (sql.startsWith("delete from oauth_tokens")) {
      this.tokens.delete(String(values[0]));
    } else if (sql.startsWith("insert into devices")) {
      const row: DeviceRow = {
        device_id: String(values[0]),
        account_id: String(values[1]),
        name: values[2] === null ? null : String(values[2]),
        credential_hash: String(values[3]),
        created_at: Number(values[4]),
        revoked_at: values[5] === null ? null : Number(values[5]),
      };
      this.devices.set(row.device_id, row);
    } else if (sql.startsWith("update devices set revoked_at")) {
      const now = Number(values[0]);
      const accountId = String(values[1]);
      for (const [id, device] of this.devices)
        if (device.account_id === accountId && device.revoked_at === null)
          this.devices.set(id, { ...device, revoked_at: now });
    } else throw new Error(`Unexpected D1 write: ${query}`);
  }
}

class TestD1Statement implements D1PreparedStatement {
  private values: unknown[] = [];
  constructor(
    private readonly database: TestD1,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return this.database.first<T>(this.query, this.values);
  }
  async all<T>() {
    return { results: this.database.all<T>(this.query, this.values) };
  }
  async run() {
    this.database.run(this.query, this.values);
    return { success: true };
  }
}

class RelaySocket {
  readyState = 1;
  attachment: unknown;
  sent: string[] = [];
  closed: Array<{ code: number; reason?: string }> = [];
  close(code: number, reason?: string) {
    this.readyState = 3;
    this.closed.push({ code, reason });
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  send(value: string) {
    this.sent.push(value);
  }
}

function relayHarness() {
  const sockets: RelaySocket[] = [];
  const values = new Map<string, unknown>();
  const state: DurableObjectState = {
    getWebSockets: () => sockets as unknown as WebSocket[],
    acceptWebSocket: (socket) => {
      sockets.push(socket as unknown as RelaySocket);
    },
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      delete: async (key: string) => {
        values.delete(key);
      },
    },
  };
  return { relay: new DeviceRelay(state), sockets, state };
}

function harness() {
  const store = new Map<string, string>();
  const kv: KVNamespace = {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
  const devices = new Map<string, { fetch: (request: Request) => Promise<Response> }>();
  const db = new TestD1();
  const env = {
    TOKENS: kv,
    DB: db,
    CLERK_PUBLISHABLE_KEY: "pk_test_Y3JlYXRpdmUtYXJhY2huaWQtOTQ4My5jbGVyay5hY2NvdW50cy5kZXYk",
    CLERK_ALLOWED_ORIGINS: "https://droid.example",
    DEVICES: {
      idFromName: (name: string) => name,
      get: (id: string) => devices.get(id) ?? { fetch: async () => new Response(null, { status: 503 }) },
    },
  } as unknown as Env;
  return { env, store, devices, db };
}

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

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
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sessionToken(sub = "clerk-user-1", azp = "https://droid.example"): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [publicJwk] })),
  );
  const header = encode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-key" })));
  const payload = encode(
    new TextEncoder().encode(
      JSON.stringify({
        sub,
        iss: CLERK_FRONTEND_API,
        exp: Math.floor(Date.now() / 1000) + 300,
        nbf: Math.floor(Date.now() / 1000) - 5,
        azp,
      }),
    ),
  );
  const signed = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${encode(new Uint8Array(signature))}`;
}

async function issueAccess(env: Env, db: TestD1, clerkUserId = "clerk-user-1"): Promise<string> {
  const token = await sessionToken(clerkUserId);
  const pair = await worker.fetch(
    new Request("https://droid.example/pair", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://droid.example" },
      body: JSON.stringify({ sessionToken: token }),
    }),
    env,
  );
  const { code } = (await pair.json()) as { code: string };
  const redeem = await worker.fetch(
    new Request("https://droid.example/device/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: "Pixel" }),
    }),
    env,
  );
  expect(redeem.status).toBe(200);
  const client = await worker.fetch(
    new Request("https://droid.example/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/callback"] }),
    }),
    env,
  );
  const { client_id } = (await client.json()) as { client_id: string };
  const verifier = "c".repeat(43);
  const challenge = encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const authorizeGet = await worker.fetch(
    new Request(
      `https://droid.example/authorize?response_type=code&client_id=${client_id}&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&code_challenge=${challenge}&code_challenge_method=S256`,
    ),
    env,
  );
  const html = await authorizeGet.text();
  const requestMatch = /request: ("req_[^"]+")/.exec(html);
  const authorizePost = await worker.fetch(
    new Request("https://droid.example/authorize", {
      method: "POST",
      headers: { Origin: "https://droid.example", "content-type": "application/json" },
      body: JSON.stringify({ request: JSON.parse(requestMatch![1]!), sessionToken: token }),
    }),
    env,
  );
  const { redirect } = (await authorizePost.json()) as { redirect: string };
  const codeParam = new URL(redirect).searchParams.get("code")!;
  const tokens = await worker.fetch(
    new Request("https://droid.example/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: codeParam,
        code_verifier: verifier,
        client_id,
        redirect_uri: "https://client.example/callback",
      }),
    }),
    env,
  );
  const body = (await tokens.json()) as { access_token: string };
  return body.access_token;
}

describe("OAuth metadata and CORS", () => {
  it("publishes protected-resource metadata from the request origin", async () => {
    const { env } = harness();
    const response = await worker.fetch(
      new Request("https://droid.synqra.info/.well-known/oauth-protected-resource"),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: "https://droid.synqra.info/mcp",
      authorization_servers: ["https://droid.synqra.info"],
    });
  });

  it("publishes authorization-server metadata from workers.dev origin", async () => {
    const { env } = harness();
    const response = await worker.fetch(
      new Request("https://droidbridge-relay.example.workers.dev/.well-known/oauth-authorization-server"),
      env,
    );
    const body = (await response.json()) as { issuer: string; code_challenge_methods_supported: string[] };
    expect(body.issuer).toBe("https://droidbridge-relay.example.workers.dev");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  it("challenges unauthenticated /mcp with WWW-Authenticate resource_metadata", async () => {
    const { env } = harness();
    const response = await worker.fetch(
      new Request("https://droid.example/mcp", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://droid.example/.well-known/oauth-protected-resource"',
    );
  });

  it("answers CORS preflight from ChatGPT origins", async () => {
    const { env } = harness();
    const response = await worker.fetch(
      new Request("https://droid.example/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://chatgpt.com", "access-control-request-method": "POST" },
      }),
      env,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("healthz is ok", async () => {
    const { env } = harness();
    const response = await worker.fetch(new Request("https://droid.example/healthz"), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe("pairing", () => {
  it("issues an 8-character pairing code and redeems it once", async () => {
    const { env, db, store } = harness();
    const token = await sessionToken();
    const issue = await worker.fetch(
      new Request("https://droid.example/pair", {
        method: "POST",
        headers: { "content-type": "application/json", Origin: "https://droid.example" },
        body: JSON.stringify({ sessionToken: token }),
      }),
      env,
    );
    expect(issue.status).toBe(200);
    const { code } = (await issue.json()) as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect([...store.keys()].some((key) => key.startsWith("pair:"))).toBe(true);

    const redeem = await worker.fetch(
      new Request("https://droid.example/device/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, deviceName: "Pixel 9" }),
      }),
      env,
    );
    expect(redeem.status).toBe(200);
    const paired = (await redeem.json()) as {
      deviceToken: string;
      accountId: string;
      mcpUrl: string;
    };
    expect(paired.deviceToken.startsWith("dbt_")).toBe(true);
    expect(paired.mcpUrl).toBe("https://droid.example/mcp");
    expect([...db.devices.values()][0]?.credential_hash).toBe(await hash(paired.deviceToken));
    expect([...db.devices.values()][0]?.credential_hash).not.toContain(paired.deviceToken);

    const reuse = await worker.fetch(
      new Request("https://droid.example/device/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, deviceName: "Pixel 9" }),
      }),
      env,
    );
    expect(reuse.status).toBe(410);
  });

  it("rejects expired pairing codes", async () => {
    const { env, store } = harness();
    const token = await sessionToken();
    await worker.fetch(
      new Request("https://droid.example/pair", {
        method: "POST",
        headers: { "content-type": "application/json", Origin: "https://droid.example" },
        body: JSON.stringify({ sessionToken: token }),
      }),
      env,
    );
    for (const key of [...store.keys()]) if (key.startsWith("pair:")) store.delete(key);
    const redeem = await worker.fetch(
      new Request("https://droid.example/device/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "ABCD2345", deviceName: "Pixel" }),
      }),
      env,
    );
    expect(redeem.status).toBe(410);
  });

  it("rejects malformed pairing codes with 400", async () => {
    const { env } = harness();
    const redeem = await worker.fetch(
      new Request("https://droid.example/device/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "nope", deviceName: "Pixel" }),
      }),
      env,
    );
    expect(redeem.status).toBe(400);
  });
});

describe("device websocket auth", () => {
  it("rejects missing or invalid device tokens", async () => {
    const { env } = harness();
    const missing = await worker.fetch(
      new Request("https://droid.example/device/ws", {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );
    expect(missing.status).toBe(401);
    const invalid = await worker.fetch(
      new Request("https://droid.example/device/ws?token=dbt_nope", {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );
    expect(invalid.status).toBe(401);
  });

  it("accepts a valid device token via Authorization or query", async () => {
    const { env, devices } = harness();
    const session = await sessionToken();
    const issue = await worker.fetch(
      new Request("https://droid.example/pair", {
        method: "POST",
        headers: { "content-type": "application/json", Origin: "https://droid.example" },
        body: JSON.stringify({ sessionToken: session }),
      }),
      env,
    );
    const { code } = (await issue.json()) as { code: string };
    let forwardedAuth = 0;
    let forwardedQuery = 0;
    devices.set("clerk-user-1", {
      fetch: async (request) => {
        if (new URL(request.url).searchParams.get("token")) forwardedQuery += 1;
        else forwardedAuth += 1;
        return new Response("ok", { status: 200 });
      },
    });
    const redeem = await worker.fetch(
      new Request("https://droid.example/device/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, deviceName: "Pixel" }),
      }),
      env,
    );
    const { deviceToken } = (await redeem.json()) as { deviceToken: string };

    const upgraded = await worker.fetch(
      new Request("https://droid.example/device/ws", {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${deviceToken}` },
      }),
      env,
    );
    expect(upgraded.status).toBe(200);
    expect(forwardedAuth).toBe(1);

    const viaQuery = await worker.fetch(
      new Request(`https://droid.example/device/ws?token=${encodeURIComponent(deviceToken)}`, {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );
    expect(viaQuery.status).toBe(200);
    expect(forwardedQuery).toBe(1);
  });
});

describe("DeviceRelay forwarding", () => {
  it("forwards rpc and returns the phone body unchanged", async () => {
    const { relay, sockets } = relayHarness();
    const socket = new RelaySocket();
    sockets.push(socket);
    const tools = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "screenshot", annotations: { readOnlyHint: true } }] },
    };
    const pending = relay.fetch(
      new Request("https://droid.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    const frame = JSON.parse(socket.sent[0]!) as {
      type: string;
      id: string;
      body: unknown;
      headers: Record<string, string>;
    };
    expect(frame.type).toBe("rpc");
    expect(frame.body).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await relay.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "rpc_result",
        id: frame.id,
        status: 200,
        body: tools,
        headers: { "mcp-session-id": "sess-1" },
      }),
    );
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("sess-1");
    await expect(response.json()).resolves.toEqual(tools);
  });

  it("returns -32002 when no phone is connected", async () => {
    const { relay } = relayHarness();
    const response = await relay.fetch(
      new Request("https://droid.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32002, message: "device offline" },
    });
  });

  it("returns -32001 after 30s without rpc_result", async () => {
    vi.useFakeTimers();
    const { relay, sockets } = relayHarness();
    sockets.push(new RelaySocket());
    const pending = relay.fetch(
      new Request("https://droid.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pending;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32001, message: "device timeout" },
    });
  });

  it("replies to ping with pong", async () => {
    const { relay } = relayHarness();
    const socket = new RelaySocket();
    await relay.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ type: "ping", t: 12345 }),
    );
    expect(socket.sent).toEqual([JSON.stringify({ type: "pong", t: 12345 })]);
  });
});

describe("MCP notifications", () => {
  it("returns 202 for JSON-RPC notifications with no id", async () => {
    const { env, devices } = harness();
    const { relay, sockets } = relayHarness();
    const socket = new RelaySocket();
    sockets.push(socket);
    devices.set("clerk-user-1", {
      fetch: async (request) => {
        const p = relay.fetch(request);
        await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
        const frame = JSON.parse(socket.sent.at(-1)!) as { id: string };
        await relay.webSocketMessage(
          socket as unknown as WebSocket,
          JSON.stringify({ type: "rpc_result", id: frame.id, status: 200, body: null }),
        );
        return p;
      },
    });
    const access = await issueAccess(env, env.DB as unknown as TestD1);
    const response = await worker.fetch(
      new Request("https://droid.example/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${access}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
      env,
    );
    expect(response.status).toBe(202);
  });
});
