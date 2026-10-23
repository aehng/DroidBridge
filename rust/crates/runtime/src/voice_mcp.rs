//! Streamable-HTTP MCP adapter for the ChatGPT voice connector (P1-02 / P1-03).
//! Mother-tool loopback `/mcp` stays on [`crate::McpFacade`].

use crate::{
    INVALID_REQUEST, MCP_BODY_LIMIT_BYTES, MCP_PROTOCOL_VERSION,
    META_PROTOCOL_VERSION, META_SERVER_INFO, METHOD_NOT_FOUND, McpRequest, McpResponse, PARSE_ERROR,
    PortFuture, UNSUPPORTED_PROTOCOL_VERSION, content_type_is_json, field_detail, header_values,
    invalid_params, is_protocol_date, rpc_error, rpc_result, single_header, validate_metadata_headers,
};
use domain::DomainError;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub const VOICE_LEGACY_VERSIONS: [&str; 3] = ["2025-03-26", "2025-06-18", "2025-11-25"];
pub const VOICE_SUPPORTED_VERSIONS: [&str; 4] = [
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    MCP_PROTOCOL_VERSION,
];
const RETRY_TTL: Duration = Duration::from_secs(90);
const RETRY_CAP: usize = 64;
const DEFAULT_LEGACY_VERSION: &str = "2025-11-25";

pub const VOICE_TOOL_NAMES: [&str; 8] = [
    "screen",
    "tap",
    "long_press",
    "swipe",
    "type",
    "open_app",
    "navigate",
    "screenshot",
];

/// Pluggable voice `tools/call` target. P1-04 supplies the runtime mapping.
pub trait VoiceToolExecutor: Send + Sync {
    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
        request_id: String,
    ) -> PortFuture<'a, Result<Value, DomainError>>;
}

/// Test and pre-P1-04 stub: echoes the tool name and a fresh request id.
#[derive(Default)]
pub struct StubVoiceExecutor;

impl VoiceToolExecutor for StubVoiceExecutor {
    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
        request_id: String,
    ) -> PortFuture<'a, Result<Value, DomainError>> {
        Box::pin(async move {
            Ok(json!({
                "ok": true,
                "tool": name,
                "request_id": request_id,
                "arguments": arguments,
            }))
        })
    }
}

#[derive(Clone, Debug)]
pub struct VoiceHttpResponse {
    pub status: u16,
    pub body: Option<Vec<u8>>,
    pub headers: Vec<(String, String)>,
}

impl From<McpResponse> for VoiceHttpResponse {
    fn from(response: McpResponse) -> Self {
        Self {
            status: response.status,
            body: response.body,
            headers: Vec::new(),
        }
    }
}

struct RetryEntry {
    session: String,
    id_key: String,
    body_hash: [u8; 32],
    stored_at: Instant,
    response: VoiceHttpResponse,
}

struct SharedInflight {
    id_key: String,
    body_hash: [u8; 32],
    tx: tokio::sync::watch::Sender<Option<VoiceHttpResponse>>,
}

/// Per-TCP-connection state for modern in-flight join.
#[derive(Default)]
pub struct VoiceConnection {
    inflight: Mutex<Option<SharedInflight>>,
}

pub struct VoiceMcp {
    product_version: String,
    executor: Arc<dyn VoiceToolExecutor>,
    kill_flag: Arc<AtomicBool>,
    sessions: Mutex<HashMap<String, String>>,
    retry: Mutex<VecDeque<RetryEntry>>,
    mutation_busy: AtomicBool,
}

impl VoiceMcp {
    pub fn new(
        product_version: String,
        executor: Arc<dyn VoiceToolExecutor>,
        kill_flag: Arc<AtomicBool>,
    ) -> Self {
        Self {
            product_version,
            executor,
            kill_flag,
            sessions: Mutex::new(HashMap::new()),
            retry: Mutex::new(VecDeque::new()),
            mutation_busy: AtomicBool::new(false),
        }
    }

    pub async fn handle(&self, request: &McpRequest, conn: &VoiceConnection) -> VoiceHttpResponse {
        if request.method != "POST" {
            return empty(405);
        }
        if !content_type_is_json(request) {
            return empty(415);
        }
        if request.body.len() > MCP_BODY_LIMIT_BYTES {
            return empty(413);
        }
        let message: Value = match serde_json::from_slice(&request.body) {
            Ok(value) => value,
            Err(_) => return rpc_error(400, Value::Null, PARSE_ERROR, "Parse error", None).into(),
        };
        let Some(object) = message.as_object() else {
            return rpc_error(400, Value::Null, INVALID_REQUEST, "Invalid Request", None).into();
        };
        if object.contains_key("result") || object.contains_key("error") {
            return rpc_error(400, Value::Null, INVALID_REQUEST, "Invalid Request", None).into();
        }

        let method_name = object.get("method").and_then(Value::as_str).unwrap_or("");
        let is_notification = object.get("method").is_some_and(Value::is_string)
            && !object.contains_key("id");

        if is_notification {
            return self.handle_notification(request, object, method_name);
        }

        let id = match object.get("id") {
            Some(Value::String(_)) => object["id"].clone(),
            Some(Value::Number(number)) if number.is_i64() || number.is_u64() => {
                object["id"].clone()
            }
            _ => return rpc_error(200, Value::Null, INVALID_REQUEST, "Invalid Request", None).into(),
        };
        let (Some(Value::String(version)), Some(Value::String(method))) =
            (object.get("jsonrpc"), object.get("method"))
        else {
            return rpc_error(200, id, INVALID_REQUEST, "Invalid Request", None).into();
        };
        if version != "2.0" {
            return rpc_error(200, id, INVALID_REQUEST, "Invalid Request", None).into();
        }
        let params = match object.get("params") {
            Some(Value::Object(params)) => params.clone(),
            None => Map::new(),
            Some(_) => return rpc_error(200, id, INVALID_REQUEST, "Invalid Request", None).into(),
        };

        let era = match classify_era(request, method, &params) {
            Era::Unsupported(requested) => {
                return rpc_error(
                    400,
                    id,
                    UNSUPPORTED_PROTOCOL_VERSION,
                    "Unsupported protocol version",
                    Some(json!({
                        "supported": VOICE_SUPPORTED_VERSIONS,
                        "requested": requested,
                    })),
                )
                .into();
            }
            Era::Modern => Era::Modern,
            Era::Legacy(v) => Era::Legacy(v),
        };

        match era {
            Era::Modern => self.handle_modern(request, conn, id, method, params).await,
            Era::Legacy(legacy_version) => {
                self.handle_legacy(request, id, method, params, legacy_version)
                    .await
            }
            Era::Unsupported(_) => unreachable!(),
        }
    }

    fn handle_notification(
        &self,
        request: &McpRequest,
        object: &Map<String, Value>,
        method_name: &str,
    ) -> VoiceHttpResponse {
        if classify_header_or_meta_modern(request, object.get("params").and_then(Value::as_object))
        {
            return empty(400);
        }
        if method_name != "notifications/initialized" {
            return empty(400);
        }
        let Some(session) = single_header(request, "mcp-session-id") else {
            return empty(400);
        };
        if !self.sessions.lock().unwrap().contains_key(session) {
            return empty(400);
        }
        empty(202)
    }

    async fn handle_modern(
        &self,
        request: &McpRequest,
        conn: &VoiceConnection,
        id: Value,
        method: &str,
        params: Map<String, Value>,
    ) -> VoiceHttpResponse {
        if let Err(response) = validate_metadata_headers(request, &id, method, &params) {
            return response.into();
        }
        match method {
            "initialize" | "notifications/initialized" => {
                rpc_error(404, id, METHOD_NOT_FOUND, "Method not found", None).into()
            }
            "server/discover" => self.discover(id, &params).into(),
            "tools/list" => self.list_tools_modern(id, &params).into(),
            "tools/call" => self.call_tool(request, conn, id, params, None).await,
            _ => rpc_error(404, id, METHOD_NOT_FOUND, "Method not found", None).into(),
        }
    }

    async fn handle_legacy(
        &self,
        request: &McpRequest,
        id: Value,
        method: &str,
        params: Map<String, Value>,
        negotiated: String,
    ) -> VoiceHttpResponse {
        match method {
            "initialize" => self.initialize_legacy(id, &params),
            "ping" => {
                if self.require_session(request).is_err() {
                    return empty(400);
                }
                rpc_result(id, json!({})).into()
            }
            "tools/list" => {
                if self.require_session(request).is_err() {
                    return empty(400);
                }
                let _ = negotiated;
                rpc_result(id, json!({ "tools": voice_tool_definitions() })).into()
            }
            "tools/call" => {
                let session = match self.require_session(request) {
                    Ok(session) => session,
                    Err(()) => return empty(400),
                };
                self.call_tool(request, &VoiceConnection::default(), id, params, Some(session))
                    .await
            }
            "server/discover" => {
                rpc_error(404, id, METHOD_NOT_FOUND, "Method not found", None).into()
            }
            _ => rpc_error(404, id, METHOD_NOT_FOUND, "Method not found", None).into(),
        }
    }

    fn initialize_legacy(&self, id: Value, params: &Map<String, Value>) -> VoiceHttpResponse {
        let requested = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_LEGACY_VERSION);
        if requested == MCP_PROTOCOL_VERSION {
            return rpc_error(404, id, METHOD_NOT_FOUND, "Method not found", None).into();
        }
        if is_protocol_date(requested) && !VOICE_LEGACY_VERSIONS.contains(&requested) {
            return rpc_error(
                400,
                id,
                UNSUPPORTED_PROTOCOL_VERSION,
                "Unsupported protocol version",
                Some(json!({
                    "supported": VOICE_SUPPORTED_VERSIONS,
                    "requested": requested,
                })),
            )
            .into();
        }
        let protocol_version = if VOICE_LEGACY_VERSIONS.contains(&requested) {
            requested
        } else {
            DEFAULT_LEGACY_VERSION
        };
        let session = uuid::Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .unwrap()
            .insert(session.clone(), protocol_version.to_owned());
        let mut response: VoiceHttpResponse = rpc_result(
            id,
            json!({
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "DroidBridge", "version": self.product_version},
            }),
        )
        .into();
        response
            .headers
            .push(("Mcp-Session-Id".to_owned(), session));
        response
    }

    fn discover(&self, id: Value, params: &Map<String, Value>) -> McpResponse {
        if !params.keys().all(|key| key == "_meta") {
            return invalid_params(id, field_detail("params", "expected only _meta"));
        }
        rpc_result(
            id,
            json!({
                "resultType": "complete",
                "supportedVersions": VOICE_SUPPORTED_VERSIONS,
                "capabilities": {"tools": {}},
                "ttlMs": 0,
                "cacheScope": "private",
                "_meta": self.server_meta(),
            }),
        )
    }

    fn list_tools_modern(&self, id: Value, params: &Map<String, Value>) -> McpResponse {
        if !params
            .keys()
            .all(|key| key == "_meta" || key == "cursor")
        {
            return invalid_params(id, field_detail("params", "expected only _meta and cursor"));
        }
        rpc_result(
            id,
            json!({
                "resultType": "complete",
                "tools": voice_tool_definitions(),
                "ttlMs": 0,
                "cacheScope": "private",
                "_meta": self.server_meta(),
            }),
        )
    }

    fn server_meta(&self) -> Value {
        json!({META_SERVER_INFO: {"name": "DroidBridge", "version": self.product_version}})
    }

    fn require_session(&self, request: &McpRequest) -> Result<String, ()> {
        let Some(session) = single_header(request, "mcp-session-id") else {
            return Err(());
        };
        if self.sessions.lock().unwrap().contains_key(session) {
            Ok(session.to_owned())
        } else {
            Err(())
        }
    }

    async fn call_tool(
        &self,
        request: &McpRequest,
        conn: &VoiceConnection,
        id: Value,
        params: Map<String, Value>,
        legacy_session: Option<String>,
    ) -> VoiceHttpResponse {
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return invalid_params(id, field_detail("params.name", "expected a string")).into();
        };
        if !VOICE_TOOL_NAMES.contains(&name) {
            return invalid_params(id, field_detail("params.name", "not an advertised tool")).into();
        }
        let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
        let mutating = !read_only_tool(name);
        let id_key = serde_json::to_string(&id).unwrap_or_default();
        let body_hash = sha256_body(&request.body);

        if let Some(session) = legacy_session.as_deref() {
            if let Some(replay) = self.lookup_retry(session, &id_key, &body_hash) {
                return replay;
            }
        }

        let waiter = if legacy_session.is_none() {
            match register_inflight(conn, id_key.clone(), body_hash) {
                InflightSlot::Join(rx) => {
                    return wait_inflight(rx).await.unwrap_or_else(|| empty(500));
                }
                InflightSlot::Lead(tx) => Some(tx),
            }
        } else {
            None
        };

        if mutating
            && self
                .mutation_busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            let response = tool_error_result(
                id,
                json!({"code": "screen_busy", "retryable": true}),
            );
            finish_inflight(conn, waiter, response.clone());
            return response;
        }

        if self.kill_flag.load(Ordering::SeqCst) {
            if mutating {
                self.mutation_busy.store(false, Ordering::SeqCst);
            }
            let response: VoiceHttpResponse =
                rpc_error(403, id, INVALID_REQUEST, "voice serving is disabled", None).into();
            finish_inflight(conn, waiter, response.clone());
            return response;
        }

        let request_id = uuid::Uuid::new_v4().to_string();
        let started = Instant::now();
        let outcome = self.executor.call(name, arguments, request_id).await;
        if mutating {
            self.mutation_busy.store(false, Ordering::SeqCst);
        }
        let latency_ms = started.elapsed().as_millis() as u64;
        let response = match outcome {
            Ok(structured) => {
                let mut structured = structured;
                if let Some(object) = structured.as_object_mut() {
                    object
                        .entry("latency_ms")
                        .or_insert_with(|| json!(latency_ms));
                }
                rpc_result(
                    id,
                    json!({
                        "content": [{"type": "text", "text": structured.to_string()}],
                        "structuredContent": structured,
                        "isError": false,
                    }),
                )
                .into()
            }
            Err(error) => tool_error_result(
                id,
                json!({"code": error.code, "message": error.reason}),
            ),
        };

        if let Some(session) = legacy_session {
            self.store_retry(session, id_key, body_hash, response.clone());
        }
        finish_inflight(conn, waiter, response.clone());
        response
    }

    fn lookup_retry(
        &self,
        session: &str,
        id_key: &str,
        body_hash: &[u8; 32],
    ) -> Option<VoiceHttpResponse> {
        let mut queue = self.retry.lock().unwrap();
        prune_retry(&mut queue);
        queue.iter().find_map(|entry| {
            (entry.session == session
                && entry.id_key == id_key
                && entry.body_hash == *body_hash)
                .then(|| entry.response.clone())
        })
    }

    fn store_retry(
        &self,
        session: String,
        id_key: String,
        body_hash: [u8; 32],
        response: VoiceHttpResponse,
    ) {
        let mut queue = self.retry.lock().unwrap();
        prune_retry(&mut queue);
        queue.retain(|entry| {
            !(entry.session == session && entry.id_key == id_key && entry.body_hash == body_hash)
        });
        while queue.len() >= RETRY_CAP {
            queue.pop_front();
        }
        queue.push_back(RetryEntry {
            session,
            id_key,
            body_hash,
            stored_at: Instant::now(),
            response,
        });
    }
}

enum Era {
    Legacy(String),
    Modern,
    Unsupported(String),
}

fn classify_era(request: &McpRequest, method: &str, params: &Map<String, Value>) -> Era {
    let header = single_header(request, "mcp-protocol-version");
    let meta_version = params
        .get("_meta")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get(META_PROTOCOL_VERSION))
        .and_then(Value::as_str);
    let init_version = (method == "initialize")
        .then(|| params.get("protocolVersion").and_then(Value::as_str))
        .flatten();

    let declared = header.or(meta_version).or(init_version);
    match declared {
        Some(MCP_PROTOCOL_VERSION) => Era::Modern,
        Some(version) if VOICE_LEGACY_VERSIONS.contains(&version) => {
            Era::Legacy(version.to_owned())
        }
        Some(version) if is_protocol_date(version) => Era::Unsupported(version.to_owned()),
        Some(_) if header.is_some() => {
            // Non-date header on a modern-looking request is a mismatch later.
            if header == Some(MCP_PROTOCOL_VERSION) {
                Era::Modern
            } else if header.is_some() && !VOICE_LEGACY_VERSIONS.contains(&header.unwrap_or("")) {
                if is_protocol_date(header.unwrap()) {
                    Era::Unsupported(header.unwrap().to_owned())
                } else {
                    Era::Legacy(DEFAULT_LEGACY_VERSION.to_owned())
                }
            } else {
                Era::Legacy(DEFAULT_LEGACY_VERSION.to_owned())
            }
        }
        _ => Era::Legacy(DEFAULT_LEGACY_VERSION.to_owned()),
    }
}

fn classify_header_or_meta_modern(request: &McpRequest, params: Option<&Map<String, Value>>) -> bool {
    if single_header(request, "mcp-protocol-version") == Some(MCP_PROTOCOL_VERSION) {
        return true;
    }
    params
        .and_then(|params| params.get("_meta"))
        .and_then(Value::as_object)
        .and_then(|meta| meta.get(META_PROTOCOL_VERSION))
        .and_then(Value::as_str)
        == Some(MCP_PROTOCOL_VERSION)
}

fn read_only_tool(name: &str) -> bool {
    matches!(name, "screen" | "screenshot")
}

pub fn voice_origin_allowed(request: &McpRequest) -> bool {
    match header_values(request, "origin").as_slice() {
        [] => true,
        [origin] => {
            *origin == "https://chatgpt.com" || *origin == "https://chat.openai.com"
        }
        _ => false,
    }
}

pub fn voice_host_allowed(request: &McpRequest, port: u16, tunnel_hostname: Option<&str>) -> bool {
    let Some(host) = single_header(request, "host") else {
        return false;
    };
    let loopback = format!("127.0.0.1:{port}");
    let localhost = format!("localhost:{port}");
    host.eq_ignore_ascii_case(&loopback)
        || host.eq_ignore_ascii_case(&localhost)
        || tunnel_hostname.is_some_and(|name| host.eq_ignore_ascii_case(name))
}

pub fn voice_tool_definitions() -> Value {
    json!([
        tool_def(
            "screen",
            "Read the current screen as a compact node tree. The reply is the new screen.",
            true,
            json!({"type": "object", "additionalProperties": true}),
        ),
        tool_def(
            "tap",
            "Tap a node or visible text, then return the new screen.",
            false,
            json!({"type": "object", "additionalProperties": true}),
        ),
        tool_def(
            "long_press",
            "Long-press a node or visible text, then return the new screen.",
            false,
            json!({"type": "object", "additionalProperties": true}),
        ),
        tool_def(
            "swipe",
            "Swipe on the screen, then return the new screen.",
            false,
            json!({"type": "object", "additionalProperties": true}),
        ),
        tool_def(
            "type",
            "Type Unicode text into a focused or named field, then return the new screen.",
            false,
            json!({"type": "object", "additionalProperties": true}),
        ),
        tool_def(
            "open_app",
            "Launch an app by package name, then return the new screen.",
            false,
            json!({"type": "object", "additionalProperties": true}),
        ),
        tool_def(
            "navigate",
            "Press Back, Home, or Recents, then return the new screen.",
            false,
            json!({"type": "object", "additionalProperties": true}),
        ),
        tool_def(
            "screenshot",
            "Capture screen pixels when the model needs to see them. The reply is the new screen.",
            true,
            json!({"type": "object", "additionalProperties": true}),
        ),
    ])
}

fn tool_def(name: &str, description: &str, read_only: bool, schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": schema,
        "annotations": {"readOnlyHint": read_only},
    })
}

fn sha256_body(body: &[u8]) -> [u8; 32] {
    Sha256::digest(body).into()
}

fn prune_retry(queue: &mut VecDeque<RetryEntry>) {
    let now = Instant::now();
    while queue
        .front()
        .is_some_and(|entry| now.saturating_duration_since(entry.stored_at) > RETRY_TTL)
    {
        queue.pop_front();
    }
}

fn empty(status: u16) -> VoiceHttpResponse {
    VoiceHttpResponse {
        status,
        body: None,
        headers: Vec::new(),
    }
}

fn tool_error_result(id: Value, structured: Value) -> VoiceHttpResponse {
    rpc_result(
        id,
        json!({
            "content": [{"type": "text", "text": structured.to_string()}],
            "structuredContent": structured,
            "isError": true,
        }),
    )
    .into()
}

enum InflightSlot {
    Lead(tokio::sync::watch::Sender<Option<VoiceHttpResponse>>),
    Join(tokio::sync::watch::Receiver<Option<VoiceHttpResponse>>),
}

fn register_inflight(
    conn: &VoiceConnection,
    id_key: String,
    body_hash: [u8; 32],
) -> InflightSlot {
    let mut guard = conn.inflight.lock().unwrap();
    if let Some(existing) = guard.as_ref() {
        if existing.id_key == id_key && existing.body_hash == body_hash {
            return InflightSlot::Join(existing.tx.subscribe());
        }
    }
    let (tx, _rx) = tokio::sync::watch::channel(None);
    *guard = Some(SharedInflight {
        id_key,
        body_hash,
        tx: tx.clone(),
    });
    InflightSlot::Lead(tx)
}

async fn wait_inflight(
    mut rx: tokio::sync::watch::Receiver<Option<VoiceHttpResponse>>,
) -> Option<VoiceHttpResponse> {
    loop {
        if let Some(response) = rx.borrow().clone() {
            return Some(response);
        }
        if rx.changed().await.is_err() {
            return None;
        }
    }
}

fn finish_inflight(
    conn: &VoiceConnection,
    waiter: Option<tokio::sync::watch::Sender<Option<VoiceHttpResponse>>>,
    response: VoiceHttpResponse,
) {
    if let Some(tx) = waiter {
        let _ = tx.send(Some(response));
    }
    *conn.inflight.lock().unwrap() = None;
}


