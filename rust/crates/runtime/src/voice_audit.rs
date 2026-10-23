//! One redacted audit row per public voice HTTP request (P1-09).

use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

const TYPED_PREFIX: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceAuditEvent {
    pub method: String,
    pub tool: Option<String>,
    pub arguments: Value,
    pub outcome: String,
    pub latency_ms: u64,
    pub foreground_package: Option<String>,
}

pub fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn redact_voice_arguments(tool: Option<&str>, arguments: &Value) -> Value {
    let mut value = strip_secrets(arguments);
    if is_password_target(&value) {
        return json!({"redacted": "password_field"});
    }
    if tool == Some("type") {
        if let Some(text) = value.get("text").and_then(Value::as_str).map(str::to_owned) {
            let prefix: String = text.chars().take(TYPED_PREFIX).collect();
            if let Some(object) = value.as_object_mut() {
                object.insert("text".to_owned(), json!(prefix));
            }
        }
    }
    value
}

fn strip_secrets(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, child) in map {
                if is_secret_key(key) {
                    continue;
                }
                out.insert(key.clone(), strip_secrets(child));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(strip_secrets).collect()),
        other => other.clone(),
    }
}

fn is_secret_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "authorization" | "bearer" | "token" | "secret" | "path_secret" | "api_key"
    )
}

fn is_password_target(arguments: &Value) -> bool {
    arguments
        .get("password")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || arguments
            .get("is_password")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || arguments
            .get("password_field")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

pub fn encode_voice_audit(event: &VoiceAuditEvent) -> String {
    let mut object = serde_json::Map::new();
    object.insert("time".to_owned(), json!(unix_millis()));
    object.insert(
        "name".to_owned(),
        json!(event.tool.clone().unwrap_or_else(|| event.method.clone())),
    );
    object.insert("arguments".to_owned(), event.arguments.clone());
    object.insert("latency_ms".to_owned(), json!(event.latency_ms));
    object.insert("outcome".to_owned(), json!(event.outcome));
    if let Some(package) = &event.foreground_package {
        object.insert("foreground_package".to_owned(), json!(package));
    }
    Value::Object(object).to_string()
}

pub fn public_request_name(body: &[u8]) -> (String, Option<String>, Value) {
    let parsed = serde_json::from_slice::<Value>(body).ok();
    let method = parsed
        .as_ref()
        .and_then(|value| value.get("method").and_then(Value::as_str))
        .unwrap_or("unknown")
        .to_owned();
    let params = parsed
        .as_ref()
        .and_then(|value| value.get("params"))
        .cloned()
        .unwrap_or(json!({}));
    let tool = params
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    (method, tool, arguments)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_drops_secrets_truncates_type_and_hides_password() {
        let typed = json!({"text": "hello world", "token": "secret-token"});
        let redacted = redact_voice_arguments(Some("type"), &typed);
        assert_eq!(redacted["text"], json!("hello wo"));
        assert!(redacted.get("token").is_none());

        let password = json!({"text": "hunter2", "password": true});
        assert_eq!(
            redact_voice_arguments(Some("type"), &password),
            json!({"redacted": "password_field"})
        );
        let line = encode_voice_audit(&VoiceAuditEvent {
            method: "tools/call".into(),
            tool: Some("tap".into()),
            arguments: json!({"node_ref": "obs/1"}),
            outcome: "ok".into(),
            latency_ms: 12,
            foreground_package: None,
        });
        assert!(line.contains("\"name\":\"tap\""));
        assert!(!line.contains("secret-token"));
        assert!(!line.contains("hunter2"));
    }
}
