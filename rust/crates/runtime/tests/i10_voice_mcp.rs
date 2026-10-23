//! P1-02 / P1-03 voice MCP adapter and public ingress tests (ephemeral loopback port).

use runtime::{
    McpArtifactReply, McpFacade, McpHost, McpListener, McpListenerConfig, McpRequest, PortFuture,
    StubVoiceExecutor, VOICE_SUPPORTED_VERSIONS, VOICE_TOOL_NAMES, VoiceConnection, VoiceMcp,
    VoiceToolExecutor, path_secret_matches,
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener as StdTcpListener,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::AtomicBool,
    },
    time::Duration,
};

const TOKEN: &str = "tXw1sO3n6b2WqQm9J0gKf8yVhZcR4dLpA7eNuTiYkMs";
const TUNNEL_HOST: &str = "voice-test.example.trycloudflare.com";

struct CannedHost;

impl McpHost for CannedHost {
    fn submit<'a>(&'a self, envelope: Vec<u8>) -> PortFuture<'a, Result<Vec<u8>, domain::DomainError>> {
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
    ) -> PortFuture<'a, Result<McpArtifactReply, domain::DomainError>> {
        Box::pin(async {
            Err(domain::DomainError::new(
                contract::ErrorCode::IoError,
                "unused",
            ))
        })
    }
}

struct CountingExecutor {
    calls: Arc<Mutex<Vec<String>>>,
    delay: Duration,
}

impl VoiceToolExecutor for CountingExecutor {
    fn call<'a>(
        &'a self,
        name: &'a str,
        _arguments: Value,
        request_id: String,
    ) -> PortFuture<'a, Result<Value, domain::DomainError>> {
        let delay = self.delay;
        let calls = Arc::clone(&self.calls);
        let name = name.to_owned();
        Box::pin(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            calls.lock().unwrap().push(request_id);
            Ok(json!({"ok": true, "tool": name}))
        })
    }
}

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(name);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"));
    let mut value: Value = serde_json::from_str(&raw).unwrap();
    if let Some(object) = value.as_object_mut() {
        object.remove("_comment");
    }
    value
}

fn serve(
    executor: Arc<dyn VoiceToolExecutor>,
    kill: Arc<std::sync::atomic::AtomicBool>,
) -> (u16, McpListener) {
    let listener = StdTcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let facade = McpFacade::new(CannedHost, port, "0.1.0".to_owned()).unwrap();
    let served = McpListener::serve_with_config(
        listener,
        TOKEN.to_owned(),
        facade,
        McpListenerConfig {
            tunnel_hostname: Some(TUNNEL_HOST.to_owned()),
            kill_flag: kill,
            voice_executor: executor,
        },
    )
    .unwrap();
    (port, served)
}

fn http(
    port: u16,
    host: &str,
    path: &str,
    extra_headers: &[(&str, &str)],
    body: &Value,
) -> (u16, Vec<(String, String)>, Value, String) {
    let body_bytes = serde_json::to_vec(body).unwrap();
    let mut head = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n",
        body_bytes.len()
    );
    for (name, value) in extra_headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(&body_bytes).unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    let (header_block, body_text) = raw.split_once("\r\n\r\n").unwrap();
    let status: u16 = header_block
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = header_block
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(": "))
        .map(|(name, value)| (name.to_owned(), value.trim().to_owned()))
        .collect();
    let json = if body_text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(body_text).unwrap_or(Value::Null)
    };
    (status, headers, json, raw)
}

fn modern_meta() -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {"name": "chatgpt-synthetic", "version": "0.0-synthetic"},
    })
}

#[test]
fn path_secret_matches_is_length_checked() {
    assert!(path_secret_matches(TOKEN, TOKEN));
    assert!(!path_secret_matches("short", TOKEN));
    assert!(!path_secret_matches(TOKEN, "other-token-of-equal-len_______________xx"));
}

#[test]
fn legacy_initialize_list_and_stub_call() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (port, served) = serve(
        Arc::new(CountingExecutor {
            calls: Arc::clone(&calls),
            delay: Duration::ZERO,
        }),
        Default::default(),
    );
    let init = fixture("synthetic_p1_00_legacy_initialize.json");
    let path = format!("/mcp/{TOKEN}");
    let host = format!("127.0.0.1:{port}");
    let (status, headers, body, _) = http(port, &host, &path, &[], &init);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["result"]["protocolVersion"], "2025-11-25");
    assert_ne!(body["result"]["protocolVersion"], "2026-07-28");
    let session = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("mcp-session-id"))
        .map(|(_, value)| value.clone())
        .expect("session");

    let initialized = json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}});
    let (status, _, _, raw) = http(
        port,
        &host,
        &path,
        &[("Mcp-Session-Id", session.as_str())],
        &initialized,
    );
    assert_eq!(status, 202, "{raw}");

    let list = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}});
    let (status, _, body, _) = http(
        port,
        &host,
        &path,
        &[("Mcp-Session-Id", session.as_str())],
        &list,
    );
    assert_eq!(status, 200);
    let names: Vec<&str> = body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, VOICE_TOOL_NAMES);

    let call = json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
        "name": "screen", "arguments": {}
    }});
    let (status, _, body, _) = http(
        port,
        &host,
        &path,
        &[("Mcp-Session-Id", session.as_str())],
        &call,
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["result"]["isError"], false);
    assert_eq!(body["result"]["structuredContent"]["tool"], "screen");
    assert_eq!(calls.lock().unwrap().len(), 1);
    served.stop();
}

#[test]
fn modern_initialize_is_method_not_found() {
    let (port, served) = serve(Arc::new(StubVoiceExecutor), Default::default());
    let host = format!("127.0.0.1:{port}");
    let path = format!("/mcp/{TOKEN}");
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2026-07-28", "_meta": modern_meta()}
    });
    let extra: Vec<(&str, &str)> = vec![
        ("MCP-Protocol-Version", "2026-07-28"),
        ("Mcp-Method", "initialize"),
    ];
    let (status, _, json_body, _) = http(port, &host, &path, &extra, &body);
    assert_eq!(status, 404);
    assert_eq!(json_body["error"]["code"], -32601);
    assert!(json_body["result"].is_null());
    served.stop();
}

#[test]
fn modern_discover_and_list_require_headers() {
    let (port, served) = serve(Arc::new(StubVoiceExecutor), Default::default());
    let host = format!("127.0.0.1:{port}");
    let path = format!("/mcp/{TOKEN}");
    let discover = fixture("synthetic_p1_00_modern_discover.json");
    let extra = [
        ("MCP-Protocol-Version", "2026-07-28"),
        ("Mcp-Method", "server/discover"),
    ];
    let (status, _, body, _) = http(port, &host, &path, &extra, &discover);
    assert_eq!(status, 200, "{body}");
    let result = &body["result"];
    assert_eq!(result["resultType"], "complete");
    assert_eq!(result["ttlMs"], 0);
    assert_eq!(result["cacheScope"], "private");
    assert!(result.get("tools").is_none());
    let versions: Vec<&str> = result["supportedVersions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(versions, VOICE_SUPPORTED_VERSIONS);
    assert_eq!(
        result["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "DroidBridge"
    );

    let list = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {"_meta": modern_meta()}});
    let extra = [
        ("MCP-Protocol-Version", "2026-07-28"),
        ("Mcp-Method", "tools/list"),
    ];
    let (status, _, body, _) = http(port, &host, &path, &extra, &list);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["result"]["resultType"], "complete");
    assert_eq!(
        body["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "DroidBridge"
    );
    let names: Vec<&str> = body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, VOICE_TOOL_NAMES);

    let missing_method = [
        ("MCP-Protocol-Version", "2026-07-28"),
    ];
    let (status, _, body, _) = http(port, &host, &path, &missing_method, &discover);
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"]["code"], -32020);

    let no_meta = json!({"jsonrpc": "2.0", "id": 3, "method": "server/discover", "params": {}});
    let (status, _, _body, _) = http(port, &host, &path, &extra[..1], &no_meta);
    assert_ne!(status, 200);
    served.stop();
}

#[test]
fn secret_path_and_tunnel_bearer_and_origin() {
    let (port, served) = serve(Arc::new(StubVoiceExecutor), Default::default());
    let loopback = format!("127.0.0.1:{port}");
    let init = fixture("synthetic_p1_00_legacy_initialize.json");
    let (status, _, _, _) = http(port, &loopback, &format!("/mcp/{TOKEN}"), &[], &init);
    assert_eq!(status, 200);

    let (status, _, _, raw) = http(port, &loopback, "/mcp/wrong-secret-token-xxxxxxxxxxxxxzzzzz", &[], &init);
    assert!(raw.starts_with("HTTP/1.1 404"), "{raw}");
    assert_eq!(status, 404);

    let (status, _, _, _) = http(port, &loopback, "/mcp/", &[], &init);
    assert_eq!(status, 404);

    let (status, _, body, _) = http(
        port,
        TUNNEL_HOST,
        "/mcp",
        &[("Authorization", &format!("Bearer {TOKEN}"))],
        &init,
    );
    assert_eq!(status, 200, "{body}");

    let (status, _, _, _) = http(
        port,
        TUNNEL_HOST,
        "/mcp",
        &[("Authorization", "Bearer not-the-token-at-all-xxxxxxxxxxxx")],
        &init,
    );
    assert_eq!(status, 401);

    let (status, _, _, _) = http(port, "evil.example", &format!("/mcp/{TOKEN}"), &[], &init);
    assert_eq!(status, 403);

    let (status, _, _, _) = http(
        port,
        &loopback,
        &format!("/mcp/{TOKEN}"),
        &[("Origin", "https://chatgpt.com")],
        &init,
    );
    assert_eq!(status, 200);

    let (status, _, _, _) = http(
        port,
        &loopback,
        &format!("/mcp/{TOKEN}"),
        &[("Origin", "https://evil.example")],
        &init,
    );
    assert_eq!(status, 403);

    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let req = format!(
        "GET /mcp/{TOKEN} HTTP/1.1\r\nHost: {loopback}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    assert!(raw.starts_with("HTTP/1.1 405"), "{raw}");

    served.stop();
}

#[test]
fn rate_limit_and_kill_flag() {
    let kill = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (port, served) = serve(Arc::new(StubVoiceExecutor), Arc::clone(&kill));
    let host = format!("127.0.0.1:{port}");
    let path = format!("/mcp/{TOKEN}");
    let init = fixture("synthetic_p1_00_legacy_initialize.json");
    let mut saw_429 = false;
    for _ in 0..12 {
        let (status, _, _, _) = http(port, &host, &path, &[], &init);
        if status == 429 {
            saw_429 = true;
            break;
        }
    }
    assert!(saw_429);
    served.stop();

    let kill = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (port, served) = serve(
        Arc::new(CountingExecutor {
            calls: Arc::clone(&calls),
            delay: Duration::ZERO,
        }),
        kill,
    );
    let host = format!("127.0.0.1:{port}");
    let path = format!("/mcp/{TOKEN}");
    let (status, headers, body, _) = http(port, &host, &path, &[], &init);
    assert_eq!(status, 200, "{body}");
    let session = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("mcp-session-id"))
        .unwrap()
        .1
        .clone();
    let call = json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {
        "name": "tap", "arguments": {}
    }});
    let (status, _, body, _) = http(
        port,
        &host,
        &path,
        &[("Mcp-Session-Id", session.as_str())],
        &call,
    );
    assert_eq!(status, 403, "{body}");
    assert!(calls.lock().unwrap().is_empty());
    served.stop();
}

#[test]
fn retry_identity_does_not_use_dedup_index() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let voice = VoiceMcp::new(
            "0.1.0".to_owned(),
            Arc::new(CountingExecutor {
                calls: Arc::clone(&calls),
                delay: Duration::from_millis(80),
            }),
            Default::default(),
        );
        let init = fixture("synthetic_p1_00_legacy_initialize.json");
        let session_a = {
            let response = voice
                .handle(
                    &McpRequest {
                        method: "POST".into(),
                        headers: vec![("content-type".into(), "application/json".into())],
                        body: serde_json::to_vec(&init).unwrap(),
                    },
                    &VoiceConnection::default(),
                )
                .await;
            response
                .headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("mcp-session-id"))
                .unwrap()
                .1
                .clone()
        };
        let mut init_b = init.clone();
        init_b["id"] = json!(99);
        let session_b = {
            let response = voice
                .handle(
                    &McpRequest {
                        method: "POST".into(),
                        headers: vec![("content-type".into(), "application/json".into())],
                        body: serde_json::to_vec(&init_b).unwrap(),
                    },
                    &VoiceConnection::default(),
                )
                .await;
            response
                .headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("mcp-session-id"))
                .unwrap()
                .1
                .clone()
        };

        let call_body = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {
            "name": "screen", "arguments": {"x": 1}
        }});
        let bytes = serde_json::to_vec(&call_body).unwrap();
        let req = |session: &str, body: Vec<u8>| McpRequest {
            method: "POST".into(),
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("mcp-session-id".into(), session.to_owned()),
            ],
            body,
        };

        let a = voice.handle(&req(&session_a, bytes.clone()), &VoiceConnection::default()).await;
        let b = voice.handle(&req(&session_b, bytes.clone()), &VoiceConnection::default()).await;
        assert_eq!(a.status, 200);
        assert_eq!(b.status, 200);
        assert_eq!(calls.lock().unwrap().len(), 2);

        let again = voice.handle(&req(&session_a, bytes.clone()), &VoiceConnection::default()).await;
        assert_eq!(again.status, 200);
        assert_eq!(calls.lock().unwrap().len(), 2);

        let mut other = call_body.clone();
        other["params"]["arguments"] = json!({"x": 2});
        let different = voice
            .handle(
                &req(&session_a, serde_json::to_vec(&other).unwrap()),
                &VoiceConnection::default(),
            )
            .await;
        let text = String::from_utf8(different.body.unwrap()).unwrap();
        assert!(!text.contains("request_id was retained with different request content"));
        assert_eq!(calls.lock().unwrap().len(), 3);

        let modern = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {
            "name": "screen",
            "arguments": {"x": 1},
            "_meta": modern_meta(),
        }});
        let modern_bytes = serde_json::to_vec(&modern).unwrap();
        let modern_req = McpRequest {
            method: "POST".into(),
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("mcp-protocol-version".into(), "2026-07-28".into()),
                ("mcp-method".into(), "tools/call".into()),
                ("mcp-name".into(), "screen".into()),
            ],
            body: modern_bytes.clone(),
        };
        let first = voice.handle(&modern_req, &VoiceConnection::default()).await;
        let second = voice.handle(&modern_req, &VoiceConnection::default()).await;
        assert_eq!(first.status, 200);
        assert_eq!(second.status, 200);
        assert_eq!(calls.lock().unwrap().len(), 5);

        let conn = VoiceConnection::default();
        let left = voice.handle(&modern_req, &conn);
        let right = voice.handle(&modern_req, &conn);
        let (l, r) = tokio::join!(left, right);
        assert_eq!(l.status, 200);
        assert_eq!(r.status, 200);
        let after_join = calls.lock().unwrap().len();
        assert_eq!(after_join, 6, "same-connection in-flight duplicate submits once");
    });
}

#[test]
fn parallel_mutations_screen_busy() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let voice = VoiceMcp::new(
            "0.1.0".to_owned(),
            Arc::new(CountingExecutor {
                calls: Arc::clone(&calls),
                delay: Duration::from_millis(100),
            }),
            Default::default(),
        );
        let init = fixture("synthetic_p1_00_legacy_initialize.json");
        let session = voice
            .handle(
                &McpRequest {
                    method: "POST".into(),
                    headers: vec![("content-type".into(), "application/json".into())],
                    body: serde_json::to_vec(&init).unwrap(),
                },
                &VoiceConnection::default(),
            )
            .await
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("mcp-session-id"))
            .unwrap()
            .1
            .clone();
        let call = |id| {
            json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {
                "name": "tap", "arguments": {}
            }})
        };
        let req = |id| McpRequest {
            method: "POST".into(),
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("mcp-session-id".into(), session.clone()),
            ],
            body: serde_json::to_vec(&call(id)).unwrap(),
        };
        let req_a = req(1);
        let req_b = req(2);
        let conn_a = VoiceConnection::default();
        let conn_b = VoiceConnection::default();
        let (a, b) = tokio::join!(voice.handle(&req_a, &conn_a), voice.handle(&req_b, &conn_b),);
        let texts = [
            String::from_utf8(a.body.clone().unwrap()).unwrap(),
            String::from_utf8(b.body.clone().unwrap()).unwrap(),
        ];
        assert!(
            texts.iter().any(|text| text.contains("screen_busy")),
            "{texts:?}"
        );
        assert_eq!(calls.lock().unwrap().len(), 1);
    });
}

#[test]
fn unsupported_version_lists_four() {
    let (port, served) = serve(Arc::new(StubVoiceExecutor), Default::default());
    let host = format!("127.0.0.1:{port}");
    let path = format!("/mcp/{TOKEN}");
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2024-11-05"}
    });
    let extra = [("MCP-Protocol-Version", "2024-11-05")];
    let (status, _, json_body, _) = http(port, &host, &path, &extra, &body);
    assert_eq!(status, 400);
    assert_eq!(json_body["error"]["code"], -32022);
    let supported: Vec<&str> = json_body["error"]["data"]["supported"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(supported, VOICE_SUPPORTED_VERSIONS);
    served.stop();
}

#[test]
fn mother_tool_loopback_still_works() {
    let (port, served) = serve(Arc::new(StubVoiceExecutor), Default::default());
    let host = format!("127.0.0.1:{port}");
    let meta = json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.droidbridge/requestId": "99200000-0000-4000-8000-000000000009",
    });
    let call = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "task_control", "arguments": {"action": "list", "input": {}}, "_meta": meta,
    }});
    let token_header = format!("Bearer {TOKEN}");
    let extra = [
        ("Authorization", token_header.as_str()),
        ("MCP-Protocol-Version", "2026-07-28"),
        ("Mcp-Method", "tools/call"),
        ("Mcp-Name", "task_control"),
    ];
    let (status, _, body, raw) = http(port, &host, "/mcp", &extra, &call);
    assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
    assert_eq!(status, 200);
    assert_eq!(body["result"]["structuredContent"], json!({"tasks": []}));
    served.stop();
}
