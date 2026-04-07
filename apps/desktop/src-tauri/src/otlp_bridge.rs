use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Map, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::runtime_activity::{
    self, RuntimeEventInput, RuntimeSessionInput, RuntimeTelemetryBatchInput,
};

pub fn ingest_otlp_logs(db_path: &Path, body: &str) -> Result<usize, String> {
    let payload: Value = serde_json::from_str(body).map_err(|error| error.to_string())?;
    let mut sessions = HashMap::<String, SessionAccumulator>::new();

    for resource_log in payload
        .get("resourceLogs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let resource_attrs = attr_map(resource_log.pointer("/resource/attributes"));
        let service_name = first_non_empty(&[
            resource_attrs.get("service.name"),
            resource_attrs.get("gen_ai.agent.name"),
            resource_attrs.get("agent.name"),
        ])
        .unwrap_or_else(|| "runtime-agent".to_string());
        let source = detect_source(
            resource_attrs.get("service.name"),
            resource_attrs.get("telemetry.sdk.name"),
            None,
        );
        let workspace_path = first_non_empty(&[
            resource_attrs.get("workspace.path"),
            resource_attrs.get("project.path"),
            resource_attrs.get("cwd"),
        ])
        .unwrap_or_else(|| "~".to_string());

        for scope_log in resource_log
            .get("scopeLogs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let scope_name = scope_log
                .pointer("/scope/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();

            for log_record in scope_log
                .get("logRecords")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let log_attrs = attr_map(log_record.get("attributes"));
                let session_id = detect_session_id(&log_attrs, None, &source);
                let event_time = timestamp_from_otel(
                    log_record
                        .get("timeUnixNano")
                        .or_else(|| log_record.get("observedTimeUnixNano")),
                )
                .unwrap_or_else(now_rfc3339);
                let severity = log_record
                    .get("severityText")
                    .and_then(Value::as_str)
                    .map(normalize_severity)
                    .unwrap_or_else(|| "info".to_string());
                let body_text = extract_body(log_record.get("body"));
                let event = map_log_record_to_event(
                    &session_id,
                    &event_time,
                    &severity,
                    &scope_name,
                    &service_name,
                    &body_text,
                    &log_attrs,
                );

                let entry =
                    sessions
                        .entry(session_id.clone())
                        .or_insert_with(|| SessionAccumulator {
                            session: RuntimeSessionInput {
                                id: session_id.clone(),
                                agent_name: humanize_agent_name(&source, &service_name),
                                source: source.clone(),
                                workspace_path: workspace_path.clone(),
                                started_at: event_time.clone(),
                                ended_at: Some(event_time.clone()),
                                status: "active".to_string(),
                                risk_level: "low".to_string(),
                                summary: format!(
                                    "{} telemetry session",
                                    humanize_agent_name(&source, &service_name)
                                ),
                                duration_ms: None,
                                source_updated_at: Some(event_time.clone()),
                            },
                            events: Vec::new(),
                        });
                apply_event_to_session(&mut entry.session, &event_time, &body_text);
                entry.events.push(event);
            }
        }
    }

    ingest_sessions(db_path, sessions)
}

pub fn ingest_otlp_traces(db_path: &Path, body: &str) -> Result<usize, String> {
    let payload: Value = serde_json::from_str(body).map_err(|error| error.to_string())?;
    let mut sessions = HashMap::<String, SessionAccumulator>::new();

    for resource_span in payload
        .get("resourceSpans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let resource_attrs = attr_map(resource_span.pointer("/resource/attributes"));
        let service_name = first_non_empty(&[
            resource_attrs.get("service.name"),
            resource_attrs.get("gen_ai.agent.name"),
            resource_attrs.get("agent.name"),
        ])
        .unwrap_or_else(|| "runtime-agent".to_string());
        let workspace_path = first_non_empty(&[
            resource_attrs.get("workspace.path"),
            resource_attrs.get("project.path"),
            resource_attrs.get("cwd"),
        ])
        .unwrap_or_else(|| "~".to_string());

        for scope_span in resource_span
            .get("scopeSpans")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let scope_name = scope_span
                .pointer("/scope/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let source = detect_source(
                resource_attrs.get("service.name"),
                resource_attrs.get("telemetry.sdk.name"),
                Some(scope_name.as_str()),
            );

            for span in scope_span
                .get("spans")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let span_attrs = attr_map(span.get("attributes"));
                let trace_id = span.get("traceId").and_then(Value::as_str);
                let session_id = detect_session_id(&span_attrs, trace_id, &source);
                let start_time =
                    timestamp_from_otel(span.get("startTimeUnixNano")).unwrap_or_else(now_rfc3339);
                let end_time = timestamp_from_otel(span.get("endTimeUnixNano"))
                    .unwrap_or_else(|| start_time.clone());
                let latency_ms = duration_ms_from_otel(
                    span.get("startTimeUnixNano"),
                    span.get("endTimeUnixNano"),
                )
                .unwrap_or(0);
                let span_name = span
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("trace span");
                let event = map_span_to_event(
                    &session_id,
                    &start_time,
                    &end_time,
                    latency_ms,
                    span_name,
                    &source,
                    &service_name,
                    &span_attrs,
                    span.get("status"),
                );
                let model_response_body = model_response_body_from_attrs(&span_attrs);
                let summary_hint = if model_response_body.is_empty() {
                    span_name.to_string()
                } else {
                    model_response_body
                };

                let entry =
                    sessions
                        .entry(session_id.clone())
                        .or_insert_with(|| SessionAccumulator {
                            session: RuntimeSessionInput {
                                id: session_id.clone(),
                                agent_name: humanize_agent_name(&source, &service_name),
                                source: source.clone(),
                                workspace_path: workspace_path.clone(),
                                started_at: start_time.clone(),
                                ended_at: Some(end_time.clone()),
                                status: "active".to_string(),
                                risk_level: "low".to_string(),
                                summary: format!(
                                    "{} trace session",
                                    humanize_agent_name(&source, &service_name)
                                ),
                                duration_ms: None,
                                source_updated_at: Some(end_time.clone()),
                            },
                            events: Vec::new(),
                        });
                apply_event_to_session(&mut entry.session, &end_time, &summary_hint);
                entry.events.push(event);
            }
        }
    }

    ingest_sessions(db_path, sessions)
}

pub fn ingest_otlp_metrics(_db_path: &Path, body: &str) -> Result<usize, String> {
    let _: Value = serde_json::from_str(body).map_err(|error| error.to_string())?;
    Ok(0)
}

pub fn ingest_otlp_http(db_path: &Path, body: &str) -> Result<usize, String> {
    let payload: Value = serde_json::from_str(body).map_err(|error| error.to_string())?;
    if payload.get("resourceLogs").is_some() {
        return ingest_otlp_logs(db_path, body);
    }
    if payload.get("resourceSpans").is_some() {
        return ingest_otlp_traces(db_path, body);
    }
    if payload.get("resourceMetrics").is_some() {
        return ingest_otlp_metrics(db_path, body);
    }
    Err("unsupported OTLP HTTP payload".to_string())
}

struct SessionAccumulator {
    session: RuntimeSessionInput,
    events: Vec<RuntimeEventInput>,
}

fn ingest_sessions(
    db_path: &Path,
    sessions: HashMap<String, SessionAccumulator>,
) -> Result<usize, String> {
    let mut ingested = 0usize;
    for (_, accumulator) in sessions {
        runtime_activity::ingest_batch(
            db_path,
            RuntimeTelemetryBatchInput {
                session: accumulator.session,
                events: accumulator.events,
            },
        )?;
        ingested += 1;
    }
    Ok(ingested)
}

fn apply_event_to_session(session: &mut RuntimeSessionInput, event_time: &str, summary_hint: &str) {
    if event_time < session.started_at.as_str() {
        session.started_at = event_time.to_string();
    }
    session.ended_at = Some(event_time.to_string());
    session.source_updated_at = Some(event_time.to_string());
    if session.summary.ends_with("telemetry session") || session.summary.ends_with("trace session")
    {
        let compact = summary_hint.trim();
        if !compact.is_empty() {
            session.summary = compact.chars().take(96).collect();
        }
    }
}

fn map_log_record_to_event(
    session_id: &str,
    event_time: &str,
    severity: &str,
    scope_name: &str,
    service_name: &str,
    body_text: &str,
    attrs: &Map<String, Value>,
) -> RuntimeEventInput {
    let event_name = first_non_empty(&[attrs.get("event.name")]).unwrap_or_default();
    let tool_name = first_non_empty(&[
        attrs.get("tool_name"),
        attrs.get("function_name"),
        attrs.get("gen_ai.tool.name"),
        attrs.get("tool.name"),
    ]);
    let model_name = first_non_empty(&[
        attrs.get("model"),
        attrs.get("gen_ai.response.model"),
        attrs.get("gen_ai.request.model"),
    ]);
    let input_tokens = first_i64(&[
        attrs.get("input_token_count"),
        attrs.get("gen_ai.usage.input_tokens"),
        attrs.get("llm.token_count.prompt"),
    ]);
    let output_tokens = first_i64(&[
        attrs.get("output_token_count"),
        attrs.get("gen_ai.usage.output_tokens"),
        attrs.get("llm.token_count.completion"),
    ]);
    let response_body = if body_text.is_empty() {
        model_response_body_from_attrs(attrs)
    } else {
        body_text.to_string()
    };
    let latency_ms = first_i64(&[attrs.get("duration_ms"), attrs.get("latency_ms")]).unwrap_or(0);
    let cached_tokens = first_i64(&[
        attrs.get("cache_read_tokens"),
        attrs.get("cached_content_token_count"),
    ])
    .unwrap_or(0);
    let thought_tokens = first_i64(&[attrs.get("thoughts_token_count")]).unwrap_or(0);
    let tool_tokens = first_i64(&[attrs.get("tool_token_count")]).unwrap_or(0);
    let message_role = first_non_empty(&[
        attrs.get("message.role"),
        attrs.get("role"),
        attrs.get("gen_ai.message.role"),
    ]);

    if event_name == "user_prompt"
        || event_name == "qwen-code.user_prompt"
        || event_name == "gemini_cli.user_prompt"
        || event_name == "claude.user_prompt"
        || event_name == "opencode.user_prompt"
        || event_name == "openclaw.user_prompt"
        || message_role.as_deref() == Some("user")
    {
        return RuntimeEventInput {
            session_id: session_id.to_string(),
            event_type: "user_message".to_string(),
            event_time: event_time.to_string(),
            severity: severity.to_string(),
            title: if body_text.is_empty() { "User prompt".to_string() } else { truncate(body_text, 72) },
            details_json: json!({
                "prompt": attrs.get("prompt").cloned().unwrap_or_else(|| Value::String(body_text.to_string())),
                "prompt_id": first_non_empty(&[attrs.get("prompt_id"), attrs.get("prompt.id")]).unwrap_or_default(),
                "prompt_length": first_i64(&[attrs.get("prompt_length")]).unwrap_or(0),
                "scope_name": scope_name,
                "service_name": service_name,
                "attributes": attrs,
            })
            .to_string(),
        };
    }

    if tool_name.is_some() {
        let tool_name = tool_name.unwrap_or_else(|| "tool".to_string());
        let status = first_non_empty(&[attrs.get("status")])
            .or_else(|| {
                first_bool(&[attrs.get("success")]).map(|ok| {
                    if ok {
                        "completed".to_string()
                    } else {
                        "failed".to_string()
                    }
                })
            })
            .unwrap_or_else(|| "completed".to_string());
        return RuntimeEventInput {
            session_id: session_id.to_string(),
            event_type: "tool_finished".to_string(),
            event_time: event_time.to_string(),
            severity: if status == "failed" { "warning".to_string() } else { severity.to_string() },
            title: format!("Tool call: {tool_name}"),
            details_json: json!({
                "tool_name": tool_name,
                "status": status,
                "latency_ms": latency_ms,
                "decision": first_non_empty(&[attrs.get("decision"), attrs.get("decision_type")]).unwrap_or_default(),
                "scope_name": scope_name,
                "service_name": service_name,
                "body": body_text,
                "attributes": attrs,
            })
            .to_string(),
        };
    }

    if input_tokens.is_some() || output_tokens.is_some() || model_name.is_some() {
        let model_name = model_name.unwrap_or_else(|| "unknown".to_string());
        return RuntimeEventInput {
            session_id: session_id.to_string(),
            event_type: "model_response".to_string(),
            event_time: event_time.to_string(),
            severity: severity.to_string(),
            title: format!("Model response: {model_name}"),
            details_json: json!({
                "provider": detect_provider(&model_name, service_name, scope_name),
                "model": model_name,
                "input_tokens": input_tokens.unwrap_or(0),
                "output_tokens": output_tokens.unwrap_or(0),
                "cached_input_tokens": cached_tokens,
                "thought_tokens": thought_tokens,
                "tool_tokens": tool_tokens,
                "estimated_cost_usd": first_f64(&[attrs.get("cost_usd"), attrs.get("estimated_cost_usd")]).unwrap_or(0.0),
                "latency_ms": latency_ms,
                "scope_name": scope_name,
                "body": response_body,
                "attributes": attrs,
            })
            .to_string(),
        };
    }

    if severity == "critical" || attrs.get("policy").is_some() || attrs.get("risk_level").is_some()
    {
        return RuntimeEventInput {
            session_id: session_id.to_string(),
            event_type: "security_alert".to_string(),
            event_time: event_time.to_string(),
            severity: severity.to_string(),
            title: if body_text.is_empty() {
                "Security event".to_string()
            } else {
                truncate(body_text, 72)
            },
            details_json: json!({
                "scope_name": scope_name,
                "service_name": service_name,
                "body": body_text,
                "attributes": attrs,
            })
            .to_string(),
        };
    }

    RuntimeEventInput {
        session_id: session_id.to_string(),
        event_type: "runtime_log".to_string(),
        event_time: event_time.to_string(),
        severity: severity.to_string(),
        title: if body_text.is_empty() {
            format!("Runtime log: {scope_name}")
        } else {
            truncate(body_text, 72)
        },
        details_json: json!({
            "scope_name": scope_name,
            "service_name": service_name,
            "body": body_text,
            "attributes": attrs,
        })
        .to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn map_span_to_event(
    session_id: &str,
    start_time: &str,
    end_time: &str,
    latency_ms: i64,
    span_name: &str,
    source: &str,
    service_name: &str,
    attrs: &Map<String, Value>,
    status: Option<&Value>,
) -> RuntimeEventInput {
    let tool_name = first_non_empty(&[
        attrs.get("tool_name"),
        attrs.get("gen_ai.tool.name"),
        attrs.get("tool.name"),
    ]);
    let model_name = first_non_empty(&[
        attrs.get("model"),
        attrs.get("gen_ai.response.model"),
        attrs.get("gen_ai.request.model"),
    ]);
    let response_body = model_response_body_from_attrs(attrs);
    let is_error = status
        .and_then(|value| value.get("code"))
        .and_then(Value::as_i64)
        .map(|code| code > 0)
        .unwrap_or(false);

    if let Some(tool_name) = tool_name {
        return RuntimeEventInput {
            session_id: session_id.to_string(),
            event_type: "tool_finished".to_string(),
            event_time: end_time.to_string(),
            severity: if is_error {
                "warning".to_string()
            } else {
                "info".to_string()
            },
            title: format!("Tool span: {tool_name}"),
            details_json: json!({
                "tool_name": tool_name,
                "status": if is_error { "failed" } else { "completed" },
                "latency_ms": latency_ms,
                "span_name": span_name,
                "source": source,
                "service_name": service_name,
                "span_started_at": start_time,
                "attributes": attrs,
            })
            .to_string(),
        };
    }

    if let Some(model_name) = model_name {
        return RuntimeEventInput {
            session_id: session_id.to_string(),
            event_type: "model_response".to_string(),
            event_time: end_time.to_string(),
            severity: if is_error { "warning".to_string() } else { "info".to_string() },
            title: format!("Model span: {model_name}"),
            details_json: json!({
                "provider": detect_provider(&model_name, service_name, span_name),
                "model": model_name,
                "input_tokens": first_i64(&[attrs.get("gen_ai.usage.input_tokens")]).unwrap_or(0),
                "output_tokens": first_i64(&[attrs.get("gen_ai.usage.output_tokens")]).unwrap_or(0),
                "estimated_cost_usd": first_f64(&[attrs.get("cost_usd"), attrs.get("estimated_cost_usd")]).unwrap_or(0.0),
                "latency_ms": latency_ms,
                "span_name": span_name,
                "source": source,
                "service_name": service_name,
                "span_started_at": start_time,
                "body": response_body,
                "attributes": attrs,
            })
            .to_string(),
        };
    }

    RuntimeEventInput {
        session_id: session_id.to_string(),
        event_type: "trace_span".to_string(),
        event_time: end_time.to_string(),
        severity: if is_error {
            "warning".to_string()
        } else {
            "info".to_string()
        },
        title: truncate(span_name, 72),
        details_json: json!({
            "latency_ms": latency_ms,
            "source": source,
            "service_name": service_name,
            "span_started_at": start_time,
            "attributes": attrs,
        })
        .to_string(),
    }
}

fn attr_map(attributes: Option<&Value>) -> Map<String, Value> {
    let mut map = Map::new();
    for attribute in attributes.and_then(Value::as_array).into_iter().flatten() {
        let Some(key) = attribute.get("key").and_then(Value::as_str) else {
            continue;
        };
        if let Some(value) = attribute_value(attribute.get("value")) {
            map.insert(key.to_string(), value);
        }
    }
    map
}

fn attribute_value(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    if let Some(string) = value.get("stringValue").and_then(Value::as_str) {
        return Some(Value::String(string.to_string()));
    }
    if let Some(int_value) = value.get("intValue") {
        if let Some(as_str) = int_value.as_str() {
            if let Ok(parsed) = as_str.parse::<i64>() {
                return Some(Value::Number(parsed.into()));
            }
        } else if let Some(parsed) = int_value.as_i64() {
            return Some(Value::Number(parsed.into()));
        }
    }
    if let Some(double_value) = value.get("doubleValue").and_then(Value::as_f64) {
        return serde_json::Number::from_f64(double_value).map(Value::Number);
    }
    if let Some(bool_value) = value.get("boolValue").and_then(Value::as_bool) {
        return Some(Value::Bool(bool_value));
    }
    if let Some(array) = value
        .get("arrayValue")
        .and_then(|item| item.get("values"))
        .and_then(Value::as_array)
    {
        return Some(Value::Array(
            array
                .iter()
                .filter_map(|entry| attribute_value(Some(entry)))
                .collect(),
        ));
    }
    if let Some(kv_list) = value
        .get("kvlistValue")
        .and_then(|item| item.get("values"))
        .and_then(Value::as_array)
    {
        let mut map = Map::new();
        for entry in kv_list {
            if let Some(key) = entry.get("key").and_then(Value::as_str) {
                if let Some(mapped) = attribute_value(entry.get("value")) {
                    map.insert(key.to_string(), mapped);
                }
            }
        }
        return Some(Value::Object(map));
    }
    None
}

fn detect_session_id(attrs: &Map<String, Value>, trace_id: Option<&str>, source: &str) -> String {
    let prefix = format!("{source}-");
    first_non_empty(&[
        attrs.get("session_id"),
        attrs.get("sessionId"),
        attrs.get("session.id"),
        attrs.get("run_id"),
        attrs.get("run.id"),
        attrs.get("trace_id"),
        attrs.get("thread_id"),
        attrs.get("conversation_id"),
    ])
    .or_else(|| trace_id.map(ToString::to_string))
    .map(|value| {
        if value.starts_with(&prefix) {
            value
        } else {
            format!("{source}-{value}")
        }
    })
    .unwrap_or_else(|| {
        format!(
            "{source}-{}",
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        )
    })
}

fn detect_source(
    service_name: Option<&Value>,
    sdk_name: Option<&Value>,
    scope_name: Option<&str>,
) -> String {
    let joined = [
        first_non_empty(&[service_name]).unwrap_or_default(),
        first_non_empty(&[sdk_name]).unwrap_or_default(),
        scope_name.unwrap_or_default().to_string(),
    ]
    .join(" ")
    .to_lowercase();
    if joined.contains("codex") {
        "codex".to_string()
    } else if joined.contains("claude") {
        "claude".to_string()
    } else if joined.contains("gemini") {
        "gemini".to_string()
    } else if joined.contains("qwen") {
        "qwen".to_string()
    } else if joined.contains("opencode") || joined.contains("open code") {
        "opencode".to_string()
    } else if joined.contains("openclaw")
        || joined.contains("clawdbot")
        || joined.contains("moltbot")
        || joined.contains("moldbot")
    {
        "openclaw".to_string()
    } else {
        "otlp".to_string()
    }
}

fn humanize_agent_name(source: &str, service_name: &str) -> String {
    match source {
        "codex" => "Codex".to_string(),
        "claude" => "Claude".to_string(),
        "gemini" => "Gemini CLI".to_string(),
        "qwen" => "Qwen Code".to_string(),
        "opencode" => "OpenCode".to_string(),
        "openclaw" => "OpenClaw".to_string(),
        _ => {
            if service_name.is_empty() {
                "Runtime Agent".to_string()
            } else {
                service_name.to_string()
            }
        }
    }
}

fn detect_provider(model: &str, service_name: &str, scope_name: &str) -> String {
    let joined = format!("{model} {service_name} {scope_name}").to_lowercase();
    if joined.contains("claude") {
        "anthropic".to_string()
    } else if joined.contains("gemini") || joined.contains("google") {
        "google".to_string()
    } else if joined.contains("qwen") || joined.contains("dashscope") {
        "qwen".to_string()
    } else if joined.contains("gpt") || joined.contains("codex") || joined.contains("openai") {
        "openai".to_string()
    } else {
        "unknown".to_string()
    }
}

fn timestamp_from_otel(value: Option<&Value>) -> Option<String> {
    let nanos = value.and_then(|item| {
        item.as_str()
            .and_then(|raw| raw.parse::<i128>().ok())
            .or_else(|| item.as_i64().map(|v| v as i128))
    })?;
    let datetime = OffsetDateTime::from_unix_timestamp_nanos(nanos).ok()?;
    datetime.format(&Rfc3339).ok()
}

fn duration_ms_from_otel(start: Option<&Value>, end: Option<&Value>) -> Option<i64> {
    let start = start.and_then(|item| {
        item.as_str()
            .and_then(|raw| raw.parse::<i128>().ok())
            .or_else(|| item.as_i64().map(|v| v as i128))
    })?;
    let end = end.and_then(|item| {
        item.as_str()
            .and_then(|raw| raw.parse::<i128>().ok())
            .or_else(|| item.as_i64().map(|v| v as i128))
    })?;
    Some((((end - start) / 1_000_000).max(0)).min(i64::MAX as i128) as i64)
}

fn extract_body(body: Option<&Value>) -> String {
    let Some(body) = body else {
        return String::new();
    };
    if let Some(string) = body.get("stringValue").and_then(Value::as_str) {
        return string.to_string();
    }
    if let Some(string) = body.as_str() {
        return string.to_string();
    }
    serde_json::to_string(body).unwrap_or_default()
}

fn model_response_body_from_attrs(attrs: &Map<String, Value>) -> String {
    first_non_empty(&[
        attrs.get("body"),
        attrs.get("response"),
        attrs.get("output"),
        attrs.get("gen_ai.response.text"),
    ])
    .or_else(|| parse_gen_ai_output_messages(attrs.get("gen_ai.output.messages")))
    .unwrap_or_default()
}

fn parse_gen_ai_output_messages(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let text = extract_message_text(&parsed, false)?;
    if text.trim().is_empty() {
        extract_message_text(&parsed, true)
    } else {
        Some(text)
    }
}

fn extract_message_text(value: &Value, include_thoughts: bool) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Array(items) => {
            let texts: Vec<String> = items
                .iter()
                .filter_map(|item| extract_message_text(item, include_thoughts))
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n\n"))
            }
        }
        Value::Object(map) => {
            if !include_thoughts && map.get("thought").and_then(Value::as_bool).unwrap_or(false) {
                return None;
            }
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
            if let Some(parts) = map.get("parts") {
                if let Some(text) = extract_message_text(parts, include_thoughts) {
                    return Some(text);
                }
            }
            if let Some(content) = map.get("content") {
                if let Some(text) = extract_message_text(content, include_thoughts) {
                    return Some(text);
                }
            }
            None
        }
        _ => None,
    }
}

fn first_non_empty(values: &[Option<&Value>]) -> Option<String> {
    values
        .iter()
        .flatten()
        .filter_map(|value| {
            value
                .as_str()
                .map(ToString::to_string)
                .or_else(|| value.as_i64().map(|value| value.to_string()))
                .or_else(|| value.as_u64().map(|value| value.to_string()))
        })
        .find(|value| !value.trim().is_empty())
}

fn first_i64(values: &[Option<&Value>]) -> Option<i64> {
    values.iter().flatten().find_map(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|raw| i64::try_from(raw).ok()))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
    })
}

fn first_f64(values: &[Option<&Value>]) -> Option<f64> {
    values.iter().flatten().find_map(|value| {
        value
            .as_f64()
            .or_else(|| value.as_i64().map(|raw| raw as f64))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<f64>().ok()))
    })
}

fn first_bool(values: &[Option<&Value>]) -> Option<bool> {
    values.iter().flatten().find_map(|value| value.as_bool())
}

fn normalize_severity(value: &str) -> String {
    match value.to_ascii_lowercase().as_str() {
        "fatal" | "error" => "critical".to_string(),
        "warn" | "warning" => "warning".to_string(),
        _ => "info".to_string(),
    }
}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
