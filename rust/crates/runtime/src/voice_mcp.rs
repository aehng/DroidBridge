//! Streamable-HTTP MCP adapter for the ChatGPT voice connector (P1-02 / P1-03).
//! Mother-tool loopback `/mcp` stays on [`crate::McpFacade`].

use crate::{
    INVALID_REQUEST, MCP_BODY_LIMIT_BYTES, MCP_PROTOCOL_VERSION, META_PROTOCOL_VERSION,
    META_SERVER_INFO, METHOD_NOT_FOUND, McpHost, McpRequest, McpResponse, PARSE_ERROR, PortFuture,
    UNSUPPORTED_PROTOCOL_VERSION, VOICE_CALL_BUDGET, content_type_is_json, field_detail,
    header_values, invalid_params, is_protocol_date, rpc_error, rpc_result, set_voice_jpeg_encode,
    single_header, validate_metadata_headers, wait_voice_settle,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use domain::DomainError;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
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

/// Maps public voice tools onto one or two Runtime envelopes.
pub struct HostVoiceExecutor<H> {
    host: H,
    last_observe: Mutex<Option<Value>>,
}

impl<H: McpHost> HostVoiceExecutor<H> {
    pub fn new(host: H) -> Self {
        Self {
            host,
            last_observe: Mutex::new(None),
        }
    }

    async fn submit_payload(&self, request_id: &str, payload: Value) -> Result<Value, DomainError> {
        let envelope = json!({
            "protocol_version": 1,
            "request_id": request_id,
            "payload": payload,
        });
        let encoded = serde_json::to_vec(&envelope).map_err(|_| {
            DomainError::new(contract::ErrorCode::InternalError, "voice envelope encode failed")
        })?;
        let response = self.host.submit(encoded).await?;
        let value: Value = serde_json::from_slice(&response).map_err(|_| {
            DomainError::new(contract::ErrorCode::InternalError, "voice envelope decode failed")
        })?;
        match value.get("outcome").and_then(Value::as_str) {
            Some("success") => value
                .get("result")
                .cloned()
                .ok_or_else(|| DomainError::new(contract::ErrorCode::InternalError, "missing result")),
            Some("error") => {
                let error = value.get("error").cloned().unwrap_or(json!({}));
                let code = error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("INTERNAL_ERROR");
                Err(DomainError::new(
                    parse_error_code(code),
                    static_host_reason(code, error.get("message").and_then(Value::as_str)),
                ))
            }
            _ => Err(DomainError::new(
                contract::ErrorCode::InternalError,
                "voice host reply had no outcome",
            )),
        }
    }

    async fn observe(&self, include_image: bool) -> Result<Value, DomainError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        if include_image {
            set_voice_jpeg_encode(true);
        }
        let result = self
            .submit_payload(
                &request_id,
                json!({
                    "tool": "visual",
                    "action": "observe",
                    "input": {
                        "include_image": include_image,
                        "include_nodes": true,
                        "max_nodes": 40
                    }
                }),
            )
            .await;
        if include_image {
            set_voice_jpeg_encode(false);
        }
        let result = result?;
        *self.last_observe.lock().unwrap() = Some(result.clone());
        Ok(result)
    }

    async fn project_screen(&self, include_image: bool) -> Result<Value, DomainError> {
        let raw = self.observe(include_image).await?;
        let mut projected = compact_voice_projection(&raw);
        if include_image {
            if let Some(block) = self.inline_observe_image(&raw).await? {
                projected["image"] = block;
            }
        }
        Ok(projected)
    }

    async fn inline_observe_image(&self, raw: &Value) -> Result<Option<Value>, DomainError> {
        let Some(uri) = raw.get("image_ref").and_then(Value::as_str) else {
            return Ok(None);
        };
        let reply = self
            .host
            .artifact_query(json!({
                "protocol_version": 1,
                "artifact_query": {"operation": "read", "uri": uri},
            }))
            .await?;
        let (Some("image"), Some(size), Some(mime), Some(descriptor)) = (
            reply.payload.get("kind").and_then(Value::as_str),
            reply.payload.get("size").and_then(Value::as_u64),
            reply.payload.get("mime").and_then(Value::as_str),
            reply.descriptor,
        ) else {
            return Ok(None);
        };
        if !matches!(mime, "image/jpeg" | "image/png" | "image/heic") || size == 0 {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        (&descriptor)
            .take(size.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| DomainError::new(contract::ErrorCode::IoError, "voice image read failed"))?;
        if bytes.len() as u64 != size {
            return Ok(None);
        }
        Ok(Some(json!({
            "type": "image",
            "mimeType": mime,
            "data": STANDARD.encode(bytes),
        })))
    }

    async fn interact_then_screen(
        &self,
        build_action: impl Fn(&Value) -> Result<Value, DomainError>,
    ) -> Result<Value, DomainError> {
        let cached = self.last_observe.lock().unwrap().clone();
        let observed = match cached {
            Some(value) => value,
            None => self.observe(false).await?,
        };
        let action = build_action(&observed)?;
        match self.submit_action_with_retry(action, &observed).await {
            Ok(()) => {
                wait_voice_settle().await;
                self.project_screen(false).await
            }
            Err(error) if is_second_stale(&error) => {
                let tree = compact_voice_projection(&self.observe(false).await.unwrap_or(json!({})));
                Ok(json!({
                    "stale": true,
                    "code": error.code,
                    "message": "Screen changed; choose a node from this tree.",
                    "screen": tree,
                }))
            }
            Err(error) => Err(error),
        }
    }

    async fn submit_action_with_retry(
        &self,
        action: Value,
        observed: &Value,
    ) -> Result<(), DomainError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        match self.submit_payload(&request_id, action.clone()).await {
            Ok(_) => Ok(()),
            Err(error) if is_stale(&error) => {
                let fresh = self.observe(false).await?;
                let retried = rebuild_action(&action, observed, &fresh).unwrap_or(action);
                let retry_id = uuid::Uuid::new_v4().to_string();
                match self.submit_payload(&retry_id, retried).await {
                    Ok(_) => Ok(()),
                    Err(error) if is_stale(&error) => Err(DomainError::new(
                        error.code,
                        "stale after retry",
                    )),
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    }
}

fn is_stale(error: &DomainError) -> bool {
    error.code == contract::ErrorCode::StaleReference
        || error.reason.contains("STALE_REFERENCE")
        || error.reason.contains("STALE_TARGET")
        || error.reason.contains("STALE_SCENE")
        || error.reason.contains("visual target changed")
        || error.reason.contains("visual scene changed")
        || error.reason.contains("visual reference expired")
}

fn is_second_stale(error: &DomainError) -> bool {
    error.reason == "stale after retry"
}

fn static_host_reason(code: &str, message: Option<&str>) -> &'static str {
    match (code, message) {
        (_, Some(reason)) if reason.contains("visual target changed") => "visual target changed",
        (_, Some(reason)) if reason.contains("visual scene changed") => "visual scene changed",
        (_, Some(reason)) if reason.contains("visual reference expired") => "visual reference expired",
        ("STALE_REFERENCE", _) => "STALE_REFERENCE",
        ("STALE_AUTHORITY", _) => "STALE_AUTHORITY",
        ("CAPABILITY_UNAVAILABLE", _) => "CAPABILITY_UNAVAILABLE",
        ("INVALID_ARGUMENT", _) => "INVALID_ARGUMENT",
        ("RESOURCE_LIMIT", _) => "RESOURCE_LIMIT",
        ("UNSUPPORTED", _) => "UNSUPPORTED",
        _ => "voice host error",
    }
}

fn rebuild_action(action: &Value, _old: &Value, fresh: &Value) -> Option<Value> {
    let mut next = action.clone();
    let input = next.get_mut("input")?.as_object_mut()?;
    if let Some(id) = fresh.get("observation_id").cloned() {
        if input.contains_key("observation_id") {
            input.insert("observation_id".to_owned(), id);
        }
    }
    Some(next)
}

fn parse_error_code(code: &str) -> contract::ErrorCode {
    match code {
        "STALE_REFERENCE" => contract::ErrorCode::StaleReference,
        "STALE_AUTHORITY" => contract::ErrorCode::StaleAuthority,
        "CAPABILITY_UNAVAILABLE" => contract::ErrorCode::CapabilityUnavailable,
        "INVALID_ARGUMENT" => contract::ErrorCode::InvalidArgument,
        "RESOURCE_LIMIT" => contract::ErrorCode::ResourceLimit,
        "UNSUPPORTED" => contract::ErrorCode::Unsupported,
        _ => contract::ErrorCode::InternalError,
    }
}

impl<H: McpHost> VoiceToolExecutor for HostVoiceExecutor<H> {
    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
        request_id: String,
    ) -> PortFuture<'a, Result<Value, DomainError>> {
        Box::pin(async move {
            let _ = request_id;
            let work = async {
                match name {
                    "screen" => self.project_screen(false).await,
                    "screenshot" => self.project_screen(true).await,
                    "tap" => {
                        self.interact_then_screen(|observed| tap_payload(arguments.clone(), observed))
                            .await
                    }
                    "long_press" => {
                        self.interact_then_screen(|observed| {
                            long_press_payload(arguments.clone(), observed)
                        })
                        .await
                    }
                    "swipe" => {
                        self.interact_then_screen(|observed| {
                            swipe_payload(arguments.clone(), observed)
                        })
                        .await
                    }
                    "type" => {
                        self.interact_then_screen(|observed| type_payload(arguments.clone(), observed))
                            .await
                    }
                    "open_app" => {
                        let package = arguments
                            .get("package")
                            .or_else(|| arguments.get("package_name"))
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                DomainError::new(
                                    contract::ErrorCode::InvalidArgument,
                                    "open_app requires package",
                                )
                            })?;
                        let id = uuid::Uuid::new_v4().to_string();
                        self.submit_payload(
                            &id,
                            json!({
                                "tool": "android",
                                "action": "launch",
                                "input": {"operation": "package", "package_name": package}
                            }),
                        )
                        .await?;
                        wait_voice_settle().await;
                        self.project_screen(false).await
                    }
                    "navigate" => {
                        let destination = arguments
                            .get("destination")
                            .or_else(|| arguments.get("action"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let key_code = match destination {
                            "back" | "Back" => 4,
                            "home" | "Home" => 3,
                            "recents" | "Recents" | "app_switch" => 187,
                            _ => {
                                return Err(DomainError::new(
                                    contract::ErrorCode::InvalidArgument,
                                    "navigate destination must be back, home, or recents",
                                ));
                            }
                        };
                        self.interact_then_screen(|observed| {
                            let observation_id = observed.get("observation_id").cloned();
                            Ok(json!({
                                "tool": "visual",
                                "action": "interact",
                                "input": {
                                    "operation": "key",
                                    "key_code": key_code,
                                    "observation_id": observation_id,
                                }
                            }))
                        })
                        .await
                    }
                    _ => Err(DomainError::new(
                        contract::ErrorCode::InvalidArgument,
                        "not an advertised tool",
                    )),
                }
            };
            match tokio::time::timeout(VOICE_CALL_BUDGET, work).await {
                Ok(result) => result,
                Err(_) => Err(DomainError::new(
                    contract::ErrorCode::Timeout,
                    "voice call exceeded 45s budget",
                )),
            }
        })
    }
}

fn tap_payload(arguments: Value, observed: &Value) -> Result<Value, DomainError> {
    point_payload("tap", arguments, observed)
}

fn long_press_payload(arguments: Value, observed: &Value) -> Result<Value, DomainError> {
    point_payload("long_press", arguments, observed)
}

fn point_payload(operation: &str, arguments: Value, observed: &Value) -> Result<Value, DomainError> {
    if let Some(node_ref) = arguments.get("node_ref").and_then(Value::as_str) {
        return Ok(json!({
            "tool": "visual",
            "action": "interact",
            "input": {"operation": operation, "target": "node", "node_ref": node_ref}
        }));
    }
    let text = arguments
        .get("text")
        .or_else(|| arguments.get("visible_text"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DomainError::new(
                contract::ErrorCode::InvalidArgument,
                "tap requires node_ref or text",
            )
        })?;
    let node_ref = find_node_ref(observed, text).ok_or_else(|| {
        DomainError::new(
            contract::ErrorCode::InvalidArgument,
            "no node matched that text",
        )
    })?;
    Ok(json!({
        "tool": "visual",
        "action": "interact",
        "input": {"operation": operation, "target": "node", "node_ref": node_ref}
    }))
}

fn swipe_payload(arguments: Value, observed: &Value) -> Result<Value, DomainError> {
    let observation_id = observed
        .get("observation_id")
        .cloned()
        .ok_or_else(|| DomainError::new(contract::ErrorCode::InvalidArgument, "no observation"))?;
    let display = observed.get("display").cloned().unwrap_or(json!({}));
    let width = display.get("width").and_then(Value::as_u64).unwrap_or(1080);
    let height = display.get("height").and_then(Value::as_u64).unwrap_or(2400);
    let (from_x, from_y, to_x, to_y) = if let (Some(fx), Some(fy), Some(tx), Some(ty)) = (
        arguments.get("from_x").and_then(Value::as_u64),
        arguments.get("from_y").and_then(Value::as_u64),
        arguments.get("to_x").and_then(Value::as_u64),
        arguments.get("to_y").and_then(Value::as_u64),
    ) {
        (fx, fy, tx, ty)
    } else {
        let direction = arguments
            .get("direction")
            .and_then(Value::as_str)
            .unwrap_or("up");
        let cx = width / 2;
        let cy = height / 2;
        match direction {
            "up" => (cx, cy + height / 4, cx, cy.saturating_sub(height / 4)),
            "down" => (cx, cy.saturating_sub(height / 4), cx, cy + height / 4),
            "left" => (cx + width / 4, cy, cx.saturating_sub(width / 4), cy),
            "right" => (cx.saturating_sub(width / 4), cy, cx + width / 4, cy),
            _ => {
                return Err(DomainError::new(
                    contract::ErrorCode::InvalidArgument,
                    "swipe direction must be up, down, left, or right",
                ));
            }
        }
    };
    Ok(json!({
        "tool": "visual",
        "action": "interact",
        "input": {
            "operation": "swipe",
            "observation_id": observation_id,
            "from_x": from_x,
            "from_y": from_y,
            "to_x": to_x,
            "to_y": to_y
        }
    }))
}

fn type_payload(arguments: Value, observed: &Value) -> Result<Value, DomainError> {
    let text = arguments
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| DomainError::new(contract::ErrorCode::InvalidArgument, "type requires text"))?;
    let mut input = json!({"operation": "text", "text": text});
    if let Some(node_ref) = arguments.get("node_ref").and_then(Value::as_str) {
        input["node_ref"] = json!(node_ref);
    } else if let Some(name) = arguments.get("field").and_then(Value::as_str) {
        if let Some(node_ref) = find_node_ref(observed, name) {
            input["node_ref"] = json!(node_ref);
        }
    } else if let Some(id) = observed.get("observation_id") {
        input["observation_id"] = id.clone();
    }
    Ok(json!({
        "tool": "visual",
        "action": "interact",
        "input": input
    }))
}

fn find_node_ref(observed: &Value, text: &str) -> Option<String> {
    let nodes = observed.get("nodes")?.as_array()?;
    let needle = text.trim();
    nodes.iter().find_map(|node| {
        let label = node
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| node.get("content_description").and_then(Value::as_str))
            .or_else(|| node.get("label").and_then(Value::as_str))?;
        (label == needle || label.contains(needle)).then(|| {
            node.get("node_ref")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        })
    })
    .filter(|value| !value.is_empty())
}

/// Compact projection for the voice model: actionable or labelled nodes, cap 40.
pub fn compact_voice_projection(observe: &Value) -> Value {
    let mut kept = Vec::new();
    if let Some(nodes) = observe.get("nodes").and_then(Value::as_array) {
        for node in nodes {
            if !keep_voice_node(node) {
                continue;
            }
            let mut compact = Map::new();
            if let Some(node_ref) = node.get("node_ref") {
                compact.insert("node_ref".to_owned(), node_ref.clone());
            }
            let label = node
                .get("text")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    node.get("content_description")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                });
            if let Some(label) = label {
                compact.insert("text".to_owned(), json!(label));
            }
            if let Some(resource_id) = node.get("resource_id") {
                compact.insert("resource_id".to_owned(), resource_id.clone());
            }
            if let Some(bounds) = node.get("bounds") {
                compact.insert("bounds".to_owned(), bounds.clone());
            }
            if let Some((flag, value)) = actionable_flag(node) {
                compact.insert(flag.to_owned(), json!(value));
            }
            kept.push(Value::Object(compact));
            if kept.len() == 40 {
                break;
            }
        }
    }
    let package = observe
        .get("foreground")
        .and_then(|foreground| foreground.get("package"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let summary = voice_summary(package, &kept);
    json!({
        "foreground_package": package,
        "summary": summary,
        "nodes": kept,
        "observation_id": observe.get("observation_id"),
        "display": observe.get("display"),
    })
}

fn keep_voice_node(node: &Value) -> bool {
    let flagged = ["clickable", "editable", "scrollable", "checkable"]
        .iter()
        .any(|key| node.get(*key) == Some(&json!(true)));
    let labelled = node
        .get("text")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
        || node
            .get("content_description")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty());
    flagged || labelled
}

fn actionable_flag(node: &Value) -> Option<(&'static str, bool)> {
    for key in ["clickable", "editable", "scrollable", "checkable"] {
        if node.get(key) == Some(&json!(true)) {
            return Some((key, true));
        }
    }
    None
}

fn voice_summary(package: &str, nodes: &[Value]) -> String {
    let app = package
        .rsplit('.')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("Screen");
    let app = {
        let mut chars = app.chars();
        match chars.next() {
            Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
            None => "Screen".to_owned(),
        }
    };
    let row = nodes.iter().find_map(|node| {
        node.get("text")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    });
    match row {
        Some(row) => format!("{app}, {row}"),
        None => app,
    }
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
                let mut content = vec![json!({"type": "text", "text": structured.to_string()})];
                if let Some(image) = structured.get("image").cloned() {
                    if image.get("type").and_then(Value::as_str) == Some("image") {
                        content.push(image);
                    }
                }
                rpc_result(
                    id,
                    json!({
                        "content": content,
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


