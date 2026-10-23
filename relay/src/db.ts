export interface D1Result<T = never> {
  readonly results?: T[];
  readonly success?: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface AccountRow {
  readonly id: string;
  readonly clerk_user_id: string;
  readonly created_at: number;
}

export interface DeviceRow {
  readonly device_id: string;
  readonly account_id: string;
  readonly name: string | null;
  readonly credential_hash: string;
  readonly created_at: number;
  readonly revoked_at: number | null;
}

export interface OAuthClientRow {
  readonly client_id: string;
  readonly redirect_uris_json: string;
  readonly created_at: number;
}

export interface OAuthTokenRow {
  readonly token_hash: string;
  readonly token_type: "access" | "refresh";
  readonly account_id: string;
  readonly client_id: string | null;
  readonly paired_token_hash: string | null;
  readonly expires_at: number | null;
  readonly created_at: number;
}

export async function getOrCreateAccount(
  db: D1Database,
  clerkUserId: string,
  now = Date.now(),
): Promise<AccountRow> {
  await db
    .prepare("INSERT OR IGNORE INTO accounts (id, clerk_user_id, created_at) VALUES (?, ?, ?)")
    .bind(crypto.randomUUID(), clerkUserId, now)
    .run();
  const account = await db
    .prepare("SELECT id, clerk_user_id, created_at FROM accounts WHERE clerk_user_id = ?")
    .bind(clerkUserId)
    .first<AccountRow>();
  if (!account) throw new Error("Account creation did not produce an account row.");
  return account;
}

export async function getAccountById(
  db: D1Database,
  accountId: string,
): Promise<AccountRow | null> {
  return db
    .prepare("SELECT id, clerk_user_id, created_at FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<AccountRow>();
}

export async function createOAuthClient(
  db: D1Database,
  clientId: string,
  redirectUris: readonly string[],
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_clients (client_id, redirect_uris_json, created_at) VALUES (?, ?, ?)",
    )
    .bind(clientId, JSON.stringify(redirectUris), now)
    .run();
}

export async function getOAuthClient(
  db: D1Database,
  clientId: string,
): Promise<OAuthClientRow | null> {
  return db
    .prepare(
      "SELECT client_id, redirect_uris_json, created_at FROM oauth_clients WHERE client_id = ?",
    )
    .bind(clientId)
    .first<OAuthClientRow>();
}

export async function saveOAuthToken(db: D1Database, token: OAuthTokenRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_tokens
        (token_hash, token_type, account_id, client_id, paired_token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      token.token_hash,
      token.token_type,
      token.account_id,
      token.client_id,
      token.paired_token_hash,
      token.expires_at,
      token.created_at,
    )
    .run();
}

export async function getOAuthToken(
  db: D1Database,
  tokenHash: string,
  now = Date.now(),
): Promise<OAuthTokenRow | null> {
  const token = await getOAuthTokenRecord(db, tokenHash);
  return token && (token.expires_at === null || token.expires_at > now) ? token : null;
}

export async function getOAuthTokenRecord(
  db: D1Database,
  tokenHash: string,
): Promise<OAuthTokenRow | null> {
  return db
    .prepare(
      `SELECT token_hash, token_type, account_id, client_id, paired_token_hash, expires_at, created_at
       FROM oauth_tokens WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<OAuthTokenRow>();
}

export async function deleteOAuthToken(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").bind(tokenHash).run();
}

export async function saveDevice(db: D1Database, device: DeviceRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO devices
        (device_id, account_id, name, credential_hash, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
        name = excluded.name, credential_hash = excluded.credential_hash,
        revoked_at = excluded.revoked_at`,
    )
    .bind(
      device.device_id,
      device.account_id,
      device.name,
      device.credential_hash,
      device.created_at,
      device.revoked_at,
    )
    .run();
}

export async function getDeviceByCredentialHash(
  db: D1Database,
  credentialHash: string,
): Promise<DeviceRow | null> {
  return db
    .prepare(
      `SELECT device_id, account_id, name, credential_hash, created_at, revoked_at
       FROM devices WHERE credential_hash = ? AND revoked_at IS NULL`,
    )
    .bind(credentialHash)
    .first<DeviceRow>();
}

export async function listAccountDevices(db: D1Database, accountId: string): Promise<DeviceRow[]> {
  const result = await db
    .prepare(
      `SELECT device_id, account_id, name, credential_hash, created_at, revoked_at
       FROM devices WHERE account_id = ? AND revoked_at IS NULL`,
    )
    .bind(accountId)
    .all<DeviceRow>();
  return result.results ?? [];
}

export async function revokeAccountDevices(
  db: D1Database,
  accountId: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare("UPDATE devices SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL")
    .bind(now, accountId)
    .run();
}
