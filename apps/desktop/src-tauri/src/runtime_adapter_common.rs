use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::{Duration, OffsetDateTime, PrimitiveDateTime};

const ISO_NAIVE_WITH_SUBSECOND: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]");
const ISO_NAIVE: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");
const ISO_SPACE_WITH_SUBSECOND: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day] [hour]:[minute]:[second].[subsecond]");
const ISO_SPACE: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");

pub fn new_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| format!("failed to build HTTP client: {error}"))
}

pub fn read_json_file(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

pub fn load_json_object(path: &Path) -> Map<String, Value> {
    read_json_file(path)
        .as_object()
        .cloned()
        .unwrap_or_default()
}

pub fn save_json_pretty<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create state dir {}: {error}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize state {}: {error}", path.display()))?;
    fs::write(path, raw)
        .map_err(|error| format!("failed to write state {}: {error}", path.display()))
}

pub fn post_json(client: &Client, endpoint: &str, payload: &Value) -> Result<(), String> {
    client
        .post(endpoint)
        .json(payload)
        .send()
        .and_then(|response| response.error_for_status())
        .map(|_| ())
        .map_err(|error| format!("request failed for {endpoint}: {error}"))
}

pub fn post_json_read_json(
    client: &Client,
    endpoint: &str,
    payload: &Value,
) -> Result<Value, String> {
    let response = client
        .post(endpoint)
        .json(payload)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("request failed for {endpoint}: {error}"))?;

    response
        .json::<Value>()
        .map_err(|error| format!("failed to decode JSON response from {endpoint}: {error}"))
}

pub fn current_timestamp() -> String {
    format_timestamp(OffsetDateTime::now_utc())
}

pub fn coerce_iso_timestamp_value(value: Option<&Value>, fallback: Option<&str>) -> String {
    if let Some(value) = value {
        match value {
            Value::String(raw) => {
                if let Some(parsed) = parse_timestamp(raw) {
                    return format_timestamp(parsed);
                }
            }
            Value::Number(number) => {
                if let Some(parsed) = number.as_f64().and_then(unix_like_to_datetime) {
                    return format_timestamp(parsed);
                }
            }
            _ => {}
        }
    }

    if let Some(fallback) = fallback {
        return coerce_iso_timestamp_str(Some(fallback), None);
    }

    current_timestamp()
}

pub fn coerce_iso_timestamp_str(value: Option<&str>, fallback: Option<&str>) -> String {
    if let Some(raw) = value {
        if let Some(parsed) = parse_timestamp(raw) {
            return format_timestamp(parsed);
        }
    }

    if let Some(fallback) = fallback {
        return coerce_iso_timestamp_str(Some(fallback), None);
    }

    current_timestamp()
}

pub fn unix_seconds_to_iso(value: f64) -> String {
    unix_like_to_datetime(value)
        .map(format_timestamp)
        .unwrap_or_else(current_timestamp)
}

pub fn file_modified_iso(path: &Path) -> Option<String> {
    let modified = path.metadata().ok()?.modified().ok()?;
    Some(system_time_to_iso(modified))
}

pub fn file_modified_ns(path: &Path) -> Option<i128> {
    let modified = path.metadata().ok()?.modified().ok()?;
    system_time_to_unix_nanos(modified)
}

pub fn system_time_to_iso(value: SystemTime) -> String {
    system_time_to_unix_nanos(value)
        .and_then(|nanos| OffsetDateTime::from_unix_timestamp_nanos(nanos).ok())
        .map(format_timestamp)
        .unwrap_or_else(current_timestamp)
}

pub fn iso_to_unix_nanos(value: &str) -> String {
    parse_timestamp(value)
        .map(|parsed| parsed.unix_timestamp_nanos().to_string())
        .unwrap_or_else(|| OffsetDateTime::now_utc().unix_timestamp_nanos().to_string())
}

pub fn shift_iso_timestamp(value: &str, delta_ms: i64) -> String {
    parse_timestamp(value)
        .map(|parsed| format_timestamp(parsed + Duration::milliseconds(delta_ms)))
        .unwrap_or_else(|| coerce_iso_timestamp_str(Some(value), None))
}

pub fn compute_duration_ms(start: Option<&str>, end: &str) -> i64 {
    let Some(start) = start.and_then(parse_timestamp) else {
        return 0;
    };
    let Some(end) = parse_timestamp(end) else {
        return 0;
    };
    let delta = end - start;
    i64::try_from(delta.whole_milliseconds().max(0)).unwrap_or(i64::MAX)
}

pub fn stable_hex(value: &str, length: usize) -> String {
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    let hex = format!("{:x}", digest.finalize());
    hex.chars().take(length).collect()
}

pub fn safe_json_dumps(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

pub fn flatten_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.trim().to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .map(flatten_text)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        Value::Object(map) => {
            for key in [
                "text",
                "content",
                "output",
                "resultDisplay",
                "description",
                "subject",
                "prompt",
                "body",
            ] {
                let nested = map.get(key).map(flatten_text).unwrap_or_default();
                if !nested.is_empty() {
                    return nested;
                }
            }
            safe_json_dumps(value)
        }
    }
}

pub fn field<T: Serialize>(key: &str, value: T) -> (String, Value) {
    (
        key.to_string(),
        serde_json::to_value(value).unwrap_or(Value::Null),
    )
}

pub fn log_record(
    timestamp: &str,
    severity: &str,
    body: &str,
    attrs: Vec<(String, Value)>,
) -> Value {
    json!({
        "timeUnixNano": iso_to_unix_nanos(timestamp),
        "severityText": severity,
        "body": { "stringValue": body },
        "attributes": build_attrs(attrs),
    })
}

pub fn span_record(
    session_id: &str,
    span_name: &str,
    start_time: &str,
    end_time: &str,
    attributes: Vec<(String, Value)>,
    status_code: i64,
) -> Value {
    json!({
        "traceId": stable_hex(&format!("{session_id}:trace"), 32),
        "spanId": stable_hex(
            &format!("{session_id}:{span_name}:{start_time}:{end_time}"),
            16
        ),
        "name": span_name,
        "startTimeUnixNano": iso_to_unix_nanos(start_time),
        "endTimeUnixNano": iso_to_unix_nanos(end_time),
        "attributes": build_attrs(attributes),
        "status": { "code": status_code },
    })
}

pub fn build_logs_payload(
    service_name: &str,
    workspace_path: &str,
    scope_name: &str,
    logs: Vec<Value>,
) -> Value {
    json!({
        "resourceLogs": [{
            "resource": {
                "attributes": build_attrs(vec![
                    field("service.name", service_name),
                    field("workspace.path", if workspace_path.is_empty() { "~" } else { workspace_path }),
                ])
            },
            "scopeLogs": [{
                "scope": { "name": scope_name },
                "logRecords": logs,
            }]
        }]
    })
}

pub fn build_traces_payload(
    service_name: &str,
    workspace_path: &str,
    scope_name: &str,
    spans: Vec<Value>,
) -> Value {
    json!({
        "resourceSpans": [{
            "resource": {
                "attributes": build_attrs(vec![
                    field("service.name", service_name),
                    field("workspace.path", if workspace_path.is_empty() { "~" } else { workspace_path }),
                ])
            },
            "scopeSpans": [{
                "scope": { "name": scope_name },
                "spans": spans,
            }]
        }]
    })
}

pub fn value_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_f64().map(|number| number as i64))
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
}

pub fn value_to_usize(value: &Value) -> Option<usize> {
    value_to_i64(value).and_then(|number| usize::try_from(number).ok())
}

pub fn value_to_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|number| number as f64))
        .or_else(|| value.as_u64().map(|number| number as f64))
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
}

fn build_attrs(attrs: Vec<(String, Value)>) -> Vec<Value> {
    attrs
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| json!({ "key": key, "value": wrap_value(&value) }))
        .collect()
}

fn wrap_value(value: &Value) -> Value {
    match value {
        Value::Bool(boolean) => json!({ "boolValue": boolean }),
        Value::Number(number) if number.is_i64() || number.is_u64() => {
            json!({ "intValue": number.to_string() })
        }
        Value::Number(number) => json!({ "doubleValue": number.as_f64().unwrap_or_default() }),
        Value::Array(items) => json!({
            "arrayValue": {
                "values": items.iter().map(wrap_value).collect::<Vec<_>>()
            }
        }),
        Value::Object(map) => json!({
            "kvlistValue": {
                "values": map
                    .iter()
                    .map(|(key, item)| json!({ "key": key, "value": wrap_value(item) }))
                    .collect::<Vec<_>>()
            }
        }),
        Value::Null => json!({ "stringValue": "" }),
        Value::String(text) => json!({ "stringValue": text }),
    }
}

fn parse_timestamp(value: &str) -> Option<OffsetDateTime> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }

    if let Ok(number) = raw.parse::<f64>() {
        if let Some(parsed) = unix_like_to_datetime(number) {
            return Some(parsed);
        }
    }

    if let Ok(parsed) = OffsetDateTime::parse(raw, &Rfc3339) {
        return Some(parsed.to_offset(time::UtcOffset::UTC));
    }

    for format in [
        ISO_NAIVE_WITH_SUBSECOND,
        ISO_NAIVE,
        ISO_SPACE_WITH_SUBSECOND,
        ISO_SPACE,
    ] {
        if let Ok(parsed) = PrimitiveDateTime::parse(raw, format) {
            return Some(parsed.assume_utc());
        }
    }

    None
}

fn unix_like_to_datetime(value: f64) -> Option<OffsetDateTime> {
    let seconds = if value.abs() > 1_000_000_000_000.0 {
        value / 1000.0
    } else {
        value
    };
    let nanos = (seconds * 1_000_000_000.0).round() as i128;
    OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()
}

fn system_time_to_unix_nanos(value: SystemTime) -> Option<i128> {
    let duration = value.duration_since(UNIX_EPOCH).ok()?;
    Some((duration.as_secs() as i128) * 1_000_000_000 + i128::from(duration.subsec_nanos()))
}

fn format_timestamp(value: OffsetDateTime) -> String {
    value
        .format(&Rfc3339)
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}
