//! The loopback MCP listener (S-MCP-001, S-STACK-011). Pinned Hyper frames HTTP/1.1 and the shared
//! facade owns every protocol decision; the host it is built with is the authoritative Runtime.

use crate::{
    MCP_BODY_LIMIT_BYTES, McpFacade, McpHost, McpRequest, VoiceConnection, VoiceHttpResponse,
    VoiceMcp, VoiceToolExecutor, bearer_matches, encode_voice_audit, path_secret_matches,
    public_request_name, redact_voice_arguments, VoiceAuditEvent,
    voice_mcp::{voice_host_allowed, voice_origin_allowed},
};
use bytes::Bytes;
use contract::ErrorCode;
use domain::DomainError;
use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response, StatusCode, body::Incoming, header, server::conn::http1, service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    convert::Infallible,
    net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener},
    sync::{
        Arc, Mutex, RwLock,
        atomic::AtomicBool,
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

/// Bounds the open connections. Any local App may connect before it proves the token, so without
/// this bound idle connections could exhaust the process's descriptors.
const MAX_CONNECTIONS: usize = 32;
/// A connection that has not sent a complete request head within this time is closed, including
/// one that sits idle between requests.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// A request body that has not fully arrived within this time is refused.
const BODY_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// The pause after a failed accept, which is transient (descriptor or memory pressure, or a peer
/// that went away) and must not end the listener.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Optional public-ingress settings. Mother-tool loopback callers can leave this defaulted.
pub struct McpListenerConfig {
    pub tunnel_hostname: Option<String>,
    pub kill_flag: Arc<AtomicBool>,
    pub voice_executor: Option<Arc<dyn VoiceToolExecutor>>,
    pub audit_sink: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

impl Default for McpListenerConfig {
    fn default() -> Self {
        Self {
            tunnel_hostname: None,
            kill_flag: Arc::new(AtomicBool::new(false)),
            voice_executor: None,
            audit_sink: None,
        }
    }
}

struct TokenBucket {
    tokens: f64,
    last: Instant,
    rate_per_sec: f64,
    burst: f64,
}

impl TokenBucket {
    fn new(rate_per_sec: f64, burst: f64) -> Self {
        Self {
            tokens: burst,
            last: Instant::now(),
            rate_per_sec,
            burst,
        }
    }

    fn try_take(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.rate_per_sec).min(self.burst);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

struct IngressLimits {
    authenticated: Mutex<TokenBucket>,
    auth_failures: Mutex<TokenBucket>,
}

impl IngressLimits {
    fn new() -> Self {
        Self {
            authenticated: Mutex::new(TokenBucket::new(1.0, 4.0)),
            auth_failures: Mutex::new(TokenBucket::new(1.0, 10.0)),
        }
    }
}

pub struct McpListener {
    runtime: tokio::runtime::Runtime,
    token: Arc<RwLock<String>>,
    tunnel_hostname: Arc<RwLock<Option<String>>>,
}

impl McpListener {
    /// Binds the IPv4 loopback endpoint and returns only once it accepts connections.
    pub fn start<H: McpHost + Clone + 'static>(
        port: u16,
        token: String,
        facade: McpFacade<H>,
    ) -> Result<Self, DomainError> {
        Self::start_with_config(port, token, facade, McpListenerConfig::default())
    }

    pub fn start_with_config<H: McpHost + Clone + 'static>(
        port: u16,
        token: String,
        facade: McpFacade<H>,
        config: McpListenerConfig,
    ) -> Result<Self, DomainError> {
        let listener = StdTcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
            .map_err(|_| listener_failed())?;
        Self::serve_with_config(listener, token, facade, config)
    }

    pub fn serve<H: McpHost + Clone + 'static>(
        listener: StdTcpListener,
        token: String,
        facade: McpFacade<H>,
    ) -> Result<Self, DomainError> {
        Self::serve_with_config(listener, token, facade, McpListenerConfig::default())
    }

    pub fn serve_with_config<H: McpHost + Clone + 'static>(
        listener: StdTcpListener,
        token: String,
        facade: McpFacade<H>,
        config: McpListenerConfig,
    ) -> Result<Self, DomainError> {
        listener
            .set_nonblocking(true)
            .map_err(|_| listener_failed())?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("droidbridge-mcp")
            .enable_all()
            .build()
            .map_err(|_| listener_failed())?;
        let listener = {
            let _entered = runtime.enter();
            tokio::net::TcpListener::from_std(listener).map_err(|_| listener_failed())?
        };
        let token = Arc::new(RwLock::new(token));
        let tunnel_hostname = Arc::new(RwLock::new(config.tunnel_hostname));
        let voice_executor = config.voice_executor.unwrap_or_else(|| {
            Arc::new(crate::HostVoiceExecutor::new(facade.clone_host()))
        });
        let voice = Arc::new(VoiceMcp::new(
            facade.product_version().to_owned(),
            voice_executor,
            Arc::clone(&config.kill_flag),
        ));
        let shared = Arc::new(ListenerShared {
            facade: Arc::new(facade),
            token: Arc::clone(&token),
            voice,
            tunnel_hostname: Arc::clone(&tunnel_hostname),
            limits: IngressLimits::new(),
            audit_sink: config.audit_sink,
        });
        runtime.spawn(accept_loop(listener, shared));
        Ok(Self {
            runtime,
            token,
            tunnel_hostname,
        })
    }

    pub fn set_token(&self, token: String) -> Result<(), DomainError> {
        *self.token.write().map_err(|_| {
            DomainError::new(ErrorCode::InternalError, "MCP token slot is unavailable")
        })? = token;
        Ok(())
    }

    pub fn set_tunnel_hostname(&self, hostname: Option<String>) -> Result<(), DomainError> {
        *self.tunnel_hostname.write().map_err(|_| {
            DomainError::new(ErrorCode::InternalError, "MCP hostname slot is unavailable")
        })? = hostname;
        Ok(())
    }

    pub fn state(&self) -> &'static str {
        "running"
    }

    /// Closes the listening socket and every open exchange; admitted Runtime work is unaffected.
    pub fn stop(self) {
        self.runtime.shutdown_timeout(Duration::from_secs(2));
    }
}

struct ListenerShared<H> {
    facade: Arc<McpFacade<H>>,
    token: Arc<RwLock<String>>,
    voice: Arc<VoiceMcp>,
    tunnel_hostname: Arc<RwLock<Option<String>>>,
    limits: IngressLimits,
    audit_sink: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

async fn accept_loop<H: McpHost + 'static>(
    listener: tokio::net::TcpListener,
    shared: Arc<ListenerShared<H>>,
) {
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        // A full set of connections leaves new ones waiting in the kernel backlog.
        let Ok(permit) = Arc::clone(&connections).acquire_owned().await else {
            return;
        };
        match listener.accept().await {
            Ok((stream, _)) => {
                let shared = Arc::clone(&shared);
                tokio::spawn(async move {
                    let _permit = permit;
                    let conn = Arc::new(VoiceConnection::default());
                    let service = service_fn(move |request| {
                        respond(request, Arc::clone(&shared), Arc::clone(&conn))
                    });
                    // A client disconnect aborts only its own exchange (S-MCP-001); an admitted
                    // Task stays Runtime-owned, so nothing is left to settle here.
                    let _ = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEADER_READ_TIMEOUT)
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
            Err(_) => tokio::time::sleep(ACCEPT_RETRY_DELAY).await,
        }
    }
}

enum Route {
    Facade,
    Voice,
    NotFound,
    Forbidden,
    Unauthorized,
}

async fn respond<H: McpHost>(
    request: Request<Incoming>,
    shared: Arc<ListenerShared<H>>,
    conn: Arc<VoiceConnection>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let started = Instant::now();
    let path = request.uri().path().to_owned();
    let http_method = request.method().clone();
    let method = http_method.as_str().to_owned();
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect();
    let mcp_request_head = McpRequest {
        method: method.clone(),
        headers: headers.clone(),
        body: Vec::new(),
    };
    let port = shared.facade.port();
    let accepted = shared
        .token
        .read()
        .map(|token| token.clone())
        .unwrap_or_default();
    let tunnel = shared
        .tunnel_hostname
        .read()
        .ok()
        .and_then(|guard| guard.clone());
    let tunnel = tunnel.as_deref();
    let public_voice_path = path.starts_with("/mcp/");

    let mcp_path = path == "/mcp" || path.starts_with("/mcp/");
    let cors_origin = cors_origin_for(&mcp_request_head);
    if http_method == hyper::Method::OPTIONS && mcp_path {
        let route = classify_preflight(&path, &mcp_request_head, port, tunnel, &accepted);
        if !matches!(route, Route::Voice) {
            return Ok(empty(match route {
                Route::NotFound => StatusCode::NOT_FOUND,
                _ => StatusCode::FORBIDDEN,
            }));
        }
        return Ok(with_cors(empty(StatusCode::NO_CONTENT), cors_origin.as_deref(), true));
    }
    if http_method != hyper::Method::POST {
        if mcp_path {
            if public_voice_path {
                emit_public_audit(
                    &shared,
                    &[],
                    "protocol_failure",
                    started,
                );
            }
            return Ok(empty(StatusCode::METHOD_NOT_ALLOWED));
        }
        return Ok(empty(StatusCode::NOT_FOUND));
    }

    let route = classify_route(&path, &mcp_request_head, port, tunnel, &accepted);

    match route {
        Route::NotFound => {
            if public_voice_path {
                emit_public_audit(&shared, &[], "auth_failure", started);
            }
            return Ok(empty(StatusCode::NOT_FOUND));
        }
        Route::Forbidden => {
            emit_public_audit(&shared, &[], "origin_forbidden", started);
            return Ok(empty(StatusCode::FORBIDDEN));
        }
        Route::Unauthorized => {
            if !take_auth_failure(&shared.limits) {
                emit_public_audit(&shared, &[], "rate_limit", started);
                return Ok(empty(StatusCode::TOO_MANY_REQUESTS));
            }
            emit_public_audit(&shared, &[], "auth_failure", started);
            return Ok(empty(StatusCode::UNAUTHORIZED));
        }
        Route::Facade | Route::Voice => {}
    }

    let body =
        match tokio::time::timeout(BODY_READ_TIMEOUT, bounded_body(request.into_body())).await {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                if matches!(route, Route::Voice) || public_voice_path {
                    emit_public_audit(&shared, &[], "parse_failure", started);
                }
                return Ok(empty(StatusCode::BAD_REQUEST));
            }
            Err(_) => return Ok(empty(StatusCode::REQUEST_TIMEOUT)),
        };
    let mcp_request = McpRequest {
        method,
        headers,
        body,
    };

    match route {
        Route::Facade => {
            let response = shared.facade.handle(mcp_request, &accepted).await;
            Ok(encode_facade(response))
        }
        Route::Voice => {
            if !take_authenticated(&shared.limits) {
                emit_public_audit(&shared, &mcp_request.body, "rate_limit", started);
                return Ok(rate_limited_voice(&mcp_request));
            }
            let response = shared.voice.handle(&mcp_request, conn.as_ref()).await;
            let outcome = voice_outcome(&mcp_request, &response);
            emit_public_audit(&shared, &mcp_request.body, outcome, started);
            Ok(with_cors(encode_voice(response), cors_origin.as_deref(), false))
        }
        _ => Ok(empty(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

fn emit_public_audit<H>(
    shared: &ListenerShared<H>,
    body: &[u8],
    outcome: &str,
    started: Instant,
) {
    let Some(sink) = &shared.audit_sink else {
        return;
    };
    let (method, tool, arguments) = public_request_name(body);
    let arguments = redact_voice_arguments(tool.as_deref(), &arguments);
    let event = VoiceAuditEvent {
        method,
        tool,
        arguments,
        outcome: outcome.to_owned(),
        latency_ms: started.elapsed().as_millis() as u64,
        foreground_package: None,
    };
    sink(encode_voice_audit(&event));
}

fn voice_outcome(request: &McpRequest, response: &VoiceHttpResponse) -> &'static str {
    if response.status == 429 {
        return "rate_limit";
    }
    if response.status == 403 {
        return "kill_switch";
    }
    if response.status == 401 {
        return "auth_failure";
    }
    let parsed = request
        .body
        .as_slice()
        .get(..)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok());
    if parsed.is_none() || response.status == 400 {
        return "parse_failure";
    }
    if response.status >= 400 {
        return "header_failure";
    }
    let rpc_error = response.body.as_ref().and_then(|body| {
        serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value.get("error").cloned())
    });
    if rpc_error.is_some() {
        return "header_failure";
    }
    "ok"
}

fn classify_route(
    path: &str,
    request: &McpRequest,
    port: u16,
    tunnel_hostname: Option<&str>,
    accepted: &str,
) -> Route {
    if path == "/mcp/" {
        return Route::NotFound;
    }
    if let Some(segment) = path.strip_prefix("/mcp/") {
        if segment.is_empty() || segment.contains('/') {
            return Route::NotFound;
        }
        if !path_secret_matches(segment, accepted) {
            return Route::NotFound;
        }
        if !voice_host_allowed(request, port, tunnel_hostname) {
            return Route::Forbidden;
        }
        if !voice_origin_allowed(request) {
            return Route::Forbidden;
        }
        return Route::Voice;
    }
    if path != "/mcp" {
        return Route::NotFound;
    }
    let host = crate::single_header(request, "host").unwrap_or("");
    let loopback = format!("127.0.0.1:{port}");
    let localhost = format!("localhost:{port}");
    if host.eq_ignore_ascii_case(&loopback) || host.eq_ignore_ascii_case(&localhost) {
        return Route::Facade;
    }
    if tunnel_hostname.is_some_and(|name| host.eq_ignore_ascii_case(name)) {
        if !voice_origin_allowed(request) {
            return Route::Forbidden;
        }
        if !bearer_matches(request, accepted) {
            return Route::Unauthorized;
        }
        return Route::Voice;
    }
    Route::Forbidden
}

pub(crate) const CORS_ALLOW_HEADERS: &str =
    "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id";
pub(crate) const CORS_ALLOW_METHODS: &str = "GET, POST, DELETE, OPTIONS";
pub(crate) const CORS_EXPOSE_HEADERS: &str = "Mcp-Session-Id, MCP-Protocol-Version";

fn cors_origin_for(request: &McpRequest) -> Option<String> {
    match crate::single_header(request, "origin") {
        Some(origin) if voice_origin_allowed(request) => Some(origin.to_owned()),
        _ => None,
    }
}

/// Preflights carry no bearer token, so tunnel `/mcp` preflight skips the bearer check.
fn classify_preflight(
    path: &str,
    request: &McpRequest,
    port: u16,
    tunnel_hostname: Option<&str>,
    accepted: &str,
) -> Route {
    match classify_route(path, request, port, tunnel_hostname, accepted) {
        Route::Unauthorized => Route::Voice,
        Route::Facade => Route::Voice,
        other => other,
    }
}

fn with_cors(
    mut response: Response<Full<Bytes>>,
    origin: Option<&str>,
    preflight: bool,
) -> Response<Full<Bytes>> {
    let Some(origin) = origin else {
        return response;
    };
    let headers = response.headers_mut();
    if let Ok(value) = header::HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(header::VARY, header::HeaderValue::from_static("Origin"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        header::HeaderValue::from_static(CORS_EXPOSE_HEADERS),
    );
    if preflight {
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            header::HeaderValue::from_static(CORS_ALLOW_METHODS),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            header::HeaderValue::from_static(CORS_ALLOW_HEADERS),
        );
        headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            header::HeaderValue::from_static("600"),
        );
    }
    response
}

fn take_authenticated(limits: &IngressLimits) -> bool {
    limits.authenticated.lock().unwrap().try_take()
}

fn take_auth_failure(limits: &IngressLimits) -> bool {
    limits.auth_failures.lock().unwrap().try_take()
}

fn rate_limited_voice(request: &McpRequest) -> Response<Full<Bytes>> {
    let parsed = serde_json::from_slice::<serde_json::Value>(&request.body).ok();
    let id = parsed
        .as_ref()
        .and_then(|value| value.get("id").cloned())
        .unwrap_or(serde_json::Value::Null);
    let is_call = parsed
        .as_ref()
        .and_then(|value| value.get("method").and_then(serde_json::Value::as_str))
        == Some("tools/call");
    if !is_call {
        return empty(StatusCode::TOO_MANY_REQUESTS);
    }
    let mut response = encode_voice(
        crate::rpc_result(
            id,
            serde_json::json!({
                "content": [{"type": "text", "text": "rate_limited"}],
                "structuredContent": {"code": "rate_limited", "retryable": true},
                "isError": true,
            }),
        )
        .into(),
    );
    *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
    response
}

fn encode_facade(response: crate::McpResponse) -> Response<Full<Bytes>> {
    let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    match response.body {
        Some(body) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from(body))),
        None => Response::builder()
            .status(status)
            .body(Full::new(Bytes::new())),
    }
    .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn encode_voice(response: VoiceHttpResponse) -> Response<Full<Bytes>> {
    let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder().status(status);
    if response.body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    for (name, value) in &response.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    match response.body {
        Some(body) => builder.body(Full::new(Bytes::from(body))),
        None => builder.body(Full::new(Bytes::new())),
    }
    .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Buffers at most one byte past the S-MCP-001 cap, which is enough for the facade to answer 413
/// in its admission order without holding an oversized body.
async fn bounded_body(mut body: Incoming) -> Result<Vec<u8>, hyper::Error> {
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        if let Ok(data) = frame?.into_data() {
            let room = MCP_BODY_LIMIT_BYTES + 1 - bytes.len();
            bytes.extend_from_slice(&data[..data.len().min(room)]);
            if bytes.len() > MCP_BODY_LIMIT_BYTES {
                break;
            }
        }
    }
    Ok(bytes)
}

fn empty(status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

fn listener_failed() -> DomainError {
    DomainError::new(ErrorCode::IoError, "MCP loopback listener failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{McpArtifactReply, PortFuture};
    use serde_json::{Value, json};
    use std::io::{Read, Write};

    const TOKEN: &str = "tXw1sO3n6b2WqQm9J0gKf8yVhZcR4dLpA7eNuTiYkMs";
    const ROTATED: &str = "Q2Vk5Yv0nLm8sX1rT4aZ7uB3cW6eH9jK2pF5gD8iM0o";

    #[derive(Clone)]
    struct CannedHost;

    impl McpHost for CannedHost {
        fn submit<'a>(&'a self, envelope: Vec<u8>) -> PortFuture<'a, Result<Vec<u8>, DomainError>> {
            Box::pin(async move {
                let request: Value = serde_json::from_slice(&envelope).unwrap();
                Ok(serde_json::to_vec(&json!({
                    "protocol_version": 1,
                    "request_id": request["request_id"],
                    "outcome": "success",
                    "result": {"tasks": []},
                }))
                .unwrap())
            })
        }

        fn artifact_query<'a>(
            &'a self,
            _query: Value,
        ) -> PortFuture<'a, Result<McpArtifactReply, DomainError>> {
            Box::pin(async { Err(listener_failed()) })
        }
    }

    fn exchange(port: u16, path: &str, token: &str, method: &str, body: &Value) -> String {
        let body = serde_json::to_vec(body).unwrap();
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
             Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n\
             MCP-Protocol-Version: 2026-07-28\r\nMcp-Method: {method}\r\n{name}\
             Content-Length: {length}\r\nConnection: close\r\n\r\n",
            name = if method == "tools/call" {
                "Mcp-Name: task_control\r\n"
            } else {
                ""
            },
            length = body.len(),
        );
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(&body).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn meta() -> Value {
        json!({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.droidbridge/requestId": "99200000-0000-4000-8000-000000000009",
        })
    }

    #[test]
    fn i10_g06_loopback_listener_frames_http_through_the_shared_facade() {
        let listener = StdTcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let facade = McpFacade::new(CannedHost, port, "0.1.0".to_owned()).unwrap();
        let served = McpListener::serve(listener, TOKEN.to_owned(), facade).unwrap();
        assert_eq!(served.state(), "running");

        let call = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "task_control", "arguments": {"action": "list", "input": {}}, "_meta": meta(),
        }});
        let answered = exchange(port, "/mcp", TOKEN, "tools/call", &call);
        assert!(answered.starts_with("HTTP/1.1 200 OK\r\n"), "{answered}");
        assert!(
            answered
                .to_ascii_lowercase()
                .contains("content-type: application/json\r\n"),
            "{answered}"
        );
        let body: Value = serde_json::from_str(answered.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["result"]["structuredContent"], json!({"tasks": []}));
        assert_eq!(body["result"]["isError"], false);

        // Rotation replaces the accepted token for the very next request.
        served.set_token(ROTATED.to_owned()).unwrap();
        let refused = exchange(port, "/mcp", TOKEN, "tools/call", &call);
        assert!(
            refused.starts_with("HTTP/1.1 401 Unauthorized\r\n"),
            "{refused}"
        );
        let rotated = exchange(port, "/mcp", ROTATED, "tools/call", &call);
        assert!(rotated.starts_with("HTTP/1.1 200 OK\r\n"), "{rotated}");

        let elsewhere = exchange(port, "/sse", ROTATED, "tools/call", &call);
        assert!(
            elsewhere.starts_with("HTTP/1.1 404 Not Found\r\n"),
            "{elsewhere}"
        );

        served.stop();
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn a_silent_connection_is_closed_by_the_header_timeout() {
        let listener = StdTcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let facade = McpFacade::new(CannedHost, port, "0.1.0".to_owned()).unwrap();
        let served = McpListener::serve(listener, TOKEN.to_owned(), facade).unwrap();

        let mut silent = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        silent
            .set_read_timeout(Some(HEADER_READ_TIMEOUT + Duration::from_secs(5)))
            .unwrap();
        let mut rest = Vec::new();
        // The server ends the exchange; a client-side read timeout would fail this read instead.
        silent.read_to_end(&mut rest).unwrap();

        served.stop();
    }
}

#[cfg(test)]
mod cors_tests {
    use super::*;

    #[test]
    fn preflight_cors_headers() {
        let r = with_cors(empty(StatusCode::NO_CONTENT), Some("https://chatgpt.com"), true);
        let h = r.headers();
        assert_eq!(h["access-control-allow-origin"], "https://chatgpt.com");
        assert_eq!(h["access-control-allow-methods"], CORS_ALLOW_METHODS);
        assert_eq!(h["access-control-allow-headers"], CORS_ALLOW_HEADERS);
        assert_eq!(h["access-control-expose-headers"], CORS_EXPOSE_HEADERS);
        let plain = with_cors(empty(StatusCode::OK), None, false);
        assert!(plain.headers().get("access-control-allow-origin").is_none());
    }

    #[test]
    fn tunnel_preflight_without_bearer_is_allowed() {
        let host = "abc.trycloudflare.com";
        let request = McpRequest {
            method: "OPTIONS".to_owned(),
            headers: vec![
                ("host".to_owned(), host.to_owned()),
                ("origin".to_owned(), "https://chatgpt.com".to_owned()),
            ],
            body: Vec::new(),
        };
        assert!(matches!(
            classify_preflight("/mcp", &request, 8765, Some(host), "secret"),
            Route::Voice
        ));
        assert_eq!(cors_origin_for(&request).as_deref(), Some("https://chatgpt.com"));
    }
}
