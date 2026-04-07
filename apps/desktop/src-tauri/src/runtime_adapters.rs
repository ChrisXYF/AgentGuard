use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use reqwest::blocking::Client;
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use walkdir::WalkDir;

use crate::runtime_adapter_common as common;

#[derive(Clone)]
struct SessionIndexEntry {
    id: String,
    updated_at: String,
    thread_name: Option<String>,
}

#[derive(Clone)]
struct SessionSyncCursor {
    index_updated_at: Option<String>,
    file_mtime_ns: i128,
    last_synced_line: usize,
}

#[derive(Clone)]
struct CodexToolCallState {
    name: String,
    arguments: Value,
    started_at: String,
}

#[derive(Clone)]
struct GeminiSessionEntry {
    session_id: String,
    path: PathBuf,
    updated_at: String,
    workspace_path: String,
}

#[derive(Clone)]
struct ClaudeSessionEntry {
    session_id: String,
    path: PathBuf,
    updated_at: String,
    workspace_path: String,
}

#[derive(Clone)]
struct OpenClawSessionEntry {
    session_id: String,
    session_file: PathBuf,
    updated_at: String,
    workspace_path: String,
}

#[derive(Clone)]
struct ChatEntry {
    session_id: String,
    path: PathBuf,
    updated_at: String,
}

pub fn sync_codex_otlp_once(
    client: &Client,
    codex_home: &Path,
    state_file: &Path,
    logs_endpoint: &str,
    traces_endpoint: &str,
) -> Result<(), String> {
    let mut state = common::load_json_object(state_file);
    let entries = read_codex_session_index(codex_home);
    let entry_map = entries
        .iter()
        .cloned()
        .map(|entry| (entry.id.clone(), entry))
        .collect::<HashMap<_, _>>();
    let session_files = build_codex_session_file_map(&codex_home.join("sessions"));

    let mut changed = Vec::new();
    for (session_id, session_file) in session_files {
        let Some(entry) = entry_map.get(&session_id) else {
            continue;
        };
        let Some(file_mtime_ns) = common::file_modified_ns(&session_file) else {
            continue;
        };
        let cursor =
            normalize_codex_cursor(state.get(&session_id), &session_file, &entry.updated_at);
        let changed_cursor = match cursor.as_ref() {
            Some(cursor) => {
                cursor.index_updated_at.as_deref() != Some(entry.updated_at.as_str())
                    || cursor.file_mtime_ns != file_mtime_ns
            }
            None => true,
        };
        if changed_cursor {
            changed.push((entry.clone(), session_file, cursor, file_mtime_ns));
        }
    }

    changed.sort_by(|left, right| {
        let left_key = left
            .0
            .updated_at
            .as_str()
            .max(&mtime_ns_to_iso(left.3))
            .to_string();
        let right_key = right
            .0
            .updated_at
            .as_str()
            .max(&mtime_ns_to_iso(right.3))
            .to_string();
        right_key.cmp(&left_key)
    });
    changed.truncate(20);

    if changed.is_empty() {
        eprintln!("no changed codex sessions");
        return Ok(());
    }

    for (entry, session_file, cursor, file_mtime_ns) in changed {
        let resume_after_line = cursor.map(|cursor| cursor.last_synced_line).unwrap_or(0);
        let (logs_payload, traces_payload, total_lines) =
            parse_codex_session(&session_file, &entry, resume_after_line)?;
        let has_logs = payload_has_logs(&logs_payload);
        let has_traces = payload_has_spans(&traces_payload);
        if has_logs {
            common::post_json(client, logs_endpoint, &logs_payload)?;
        }
        if has_traces {
            common::post_json(client, traces_endpoint, &traces_payload)?;
        }
        state.insert(
            entry.id.clone(),
            serialize_codex_cursor(SessionSyncCursor {
                index_updated_at: Some(entry.updated_at.clone()),
                file_mtime_ns,
                last_synced_line: total_lines,
            }),
        );
        if has_logs || has_traces {
            eprintln!("synced {}", entry.id);
        }
    }

    common::save_json_pretty(state_file, &state)
}

pub fn sync_codex_guard_once(
    client: &Client,
    codex_home: &Path,
    state_file: &Path,
    guard_base_url: &str,
    experimental_soft_stop: bool,
) -> Result<(), String> {
    let raw_state = common::load_json_object(state_file);
    let mut sessions_state = raw_state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut metrics = normalize_guard_metrics(
        raw_state
            .get("metrics")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    );

    let mut entries = read_codex_session_index(codex_home);
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    reset_guard_last_run_metrics(&mut metrics, experimental_soft_stop);

    let session_files = build_codex_session_file_map(&codex_home.join("sessions"));
    let changed = entries
        .into_iter()
        .filter(|entry| should_sync_guard_entry(entry, sessions_state.get(&entry.id)))
        .take(20)
        .collect::<Vec<_>>();

    if changed.is_empty() {
        persist_guard_state(state_file, &sessions_state, &metrics)?;
        eprintln!("no changed codex guard sessions");
        return Ok(());
    }

    for entry in changed {
        let Some(session_file) = session_files.get(&entry.id).cloned() else {
            continue;
        };
        process_codex_guard_session(
            client,
            &session_file,
            &entry,
            &mut sessions_state,
            state_file,
            guard_base_url,
            &mut metrics,
            experimental_soft_stop,
        )?;
        eprintln!("guard-synced {}", entry.id);
    }

    metrics.insert(
        "last_run_at".to_string(),
        json!(common::current_timestamp()),
    );
    persist_guard_state(state_file, &sessions_state, &metrics)
}

pub fn sync_gemini_otlp_once(
    client: &Client,
    gemini_home: &Path,
    state_file: &Path,
    logs_endpoint: &str,
    traces_endpoint: &str,
) -> Result<(), String> {
    let mut state = common::load_json_object(state_file);
    let mut entries = read_gemini_session_entries(gemini_home);
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

    let mut changed = Vec::new();
    for entry in entries {
        let saved = state.get(&entry.session_id).and_then(Value::as_object);
        if saved
            .and_then(|saved| saved.get("updated_at"))
            .and_then(Value::as_str)
            == Some(entry.updated_at.as_str())
        {
            continue;
        }
        changed.push(entry);
        if changed.len() >= 20 {
            break;
        }
    }

    if changed.is_empty() {
        eprintln!("no changed gemini sessions");
        return Ok(());
    }

    for entry in changed {
        let raw = common::read_json_file(&entry.path);
        let Some(messages) = raw.get("messages").and_then(Value::as_array) else {
            continue;
        };
        let saved = state.get(&entry.session_id).and_then(Value::as_object);
        let mut start_index = saved
            .and_then(|saved| saved.get("message_count"))
            .and_then(common::value_to_usize)
            .unwrap_or(0);
        if start_index > messages.len() {
            start_index = 0;
        }

        if let Some((logs_payload, traces_payload)) =
            parse_gemini_session(&entry, &raw, start_index)
        {
            if payload_has_logs(&logs_payload) {
                common::post_json(client, logs_endpoint, &logs_payload)?;
            }
            if payload_has_spans(&traces_payload) {
                common::post_json(client, traces_endpoint, &traces_payload)?;
            }
            eprintln!("synced {}", entry.session_id);
        }

        state.insert(
            entry.session_id.clone(),
            json!({
                "message_count": messages.len(),
                "updated_at": entry.updated_at,
                "path": entry.path,
            }),
        );
    }

    common::save_json_pretty(state_file, &state)
}

pub fn sync_claude_otlp_once(
    client: &Client,
    state_file: &Path,
    logs_endpoint: &str,
    traces_endpoint: &str,
) -> Result<(), String> {
    let mut state = common::load_json_object(state_file);
    let mut entries = read_claude_session_entries();
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

    let mut changed = Vec::new();
    for entry in entries {
        let saved = state.get(&entry.session_id).and_then(Value::as_object);
        if saved
            .and_then(|saved| saved.get("updated_at"))
            .and_then(Value::as_str)
            == Some(entry.updated_at.as_str())
        {
            continue;
        }
        changed.push(entry);
        if changed.len() >= 20 {
            break;
        }
    }

    if changed.is_empty() {
        eprintln!("no changed claude sessions");
        return Ok(());
    }

    for entry in changed {
        let lines = read_lines(&entry.path)?;
        let saved = state.get(&entry.session_id).and_then(Value::as_object);
        let mut start_index = saved
            .and_then(|saved| saved.get("line_count"))
            .and_then(common::value_to_usize)
            .unwrap_or(0);
        if start_index > lines.len() {
            start_index = 0;
        }

        if let Some((logs_payload, traces_payload)) =
            parse_claude_session(&entry, &lines, start_index)
        {
            if payload_has_logs(&logs_payload) {
                common::post_json(client, logs_endpoint, &logs_payload)?;
            }
            if payload_has_spans(&traces_payload) {
                common::post_json(client, traces_endpoint, &traces_payload)?;
            }
            eprintln!("synced {}", entry.session_id);
        }

        state.insert(
            entry.session_id.clone(),
            json!({
                "line_count": lines.len(),
                "updated_at": entry.updated_at,
                "path": entry.path,
            }),
        );
    }

    common::save_json_pretty(state_file, &state)
}

pub fn sync_qwen_otlp_once(
    client: &Client,
    qwen_home: &Path,
    state_file: &Path,
    db_path: &Path,
    logs_endpoint: &str,
    traces_endpoint: &str,
) -> Result<(), String> {
    let mut state = common::load_json_object(state_file);
    let mut entries = read_qwen_chat_entries(qwen_home);
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let existing_sessions = read_existing_qwen_sessions(db_path);

    let mut changed = Vec::new();
    for entry in entries {
        let saved = state.get(&entry.session_id).and_then(Value::as_object);
        if saved
            .and_then(|saved| saved.get("updated_at"))
            .and_then(Value::as_str)
            == Some(entry.updated_at.as_str())
        {
            continue;
        }
        changed.push(entry);
        if changed.len() >= 20 {
            break;
        }
    }

    if changed.is_empty() {
        eprintln!("no changed qwen sessions");
        return Ok(());
    }

    for entry in changed {
        let lines = read_lines(&entry.path)?;
        let line_count = lines.len();
        let db_updated_at = existing_sessions.get(&format!("qwen-{}", entry.session_id));
        let saved = state.get(&entry.session_id).and_then(Value::as_object);

        if saved.is_none() && db_updated_at.is_some() {
            state.insert(
                entry.session_id.clone(),
                json!({ "line_count": line_count, "updated_at": entry.updated_at }),
            );
            continue;
        }

        let mut start_index = saved
            .and_then(|saved| saved.get("line_count"))
            .and_then(common::value_to_usize)
            .unwrap_or(0);
        if start_index > line_count {
            start_index = 0;
        }

        if let Some((logs_payload, traces_payload)) =
            parse_qwen_chat(&lines, &entry.session_id, start_index)
        {
            if payload_has_logs(&logs_payload) {
                common::post_json(client, logs_endpoint, &logs_payload)?;
            }
            if payload_has_spans(&traces_payload) {
                common::post_json(client, traces_endpoint, &traces_payload)?;
            }
            eprintln!("synced {}", entry.session_id);
        }

        state.insert(
            entry.session_id.clone(),
            json!({ "line_count": line_count, "updated_at": entry.updated_at }),
        );
    }

    common::save_json_pretty(state_file, &state)
}

pub fn sync_opencode_otlp_once(
    client: &Client,
    data_root: &Path,
    state_file: &Path,
    logs_endpoint: &str,
) -> Result<(), String> {
    let mut state = common::load_json_object(state_file);
    let mut message_files = find_opencode_message_files(data_root);
    message_files.sort_by(|left, right| {
        common::file_modified_ns(right)
            .unwrap_or_default()
            .cmp(&common::file_modified_ns(left).unwrap_or_default())
    });

    let changed = message_files
        .into_iter()
        .filter(|path| {
            let current = common::file_modified_ns(path).unwrap_or_default();
            state
                .get(&path.to_string_lossy().to_string())
                .and_then(common::value_to_i64)
                .map(|saved| saved as i128 != current)
                .unwrap_or(true)
        })
        .take(120)
        .collect::<Vec<_>>();

    if changed.is_empty() {
        eprintln!("no changed opencode messages");
        return Ok(());
    }

    for path in changed {
        let payload = parse_opencode_message_file(&path);
        if let Some(mtime_ns) = common::file_modified_ns(&path) {
            state.insert(path.to_string_lossy().to_string(), json!(mtime_ns));
        }
        let Some(payload) = payload else {
            continue;
        };
        common::post_json(client, logs_endpoint, &payload)?;
        let label = format!(
            "{}:{}",
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|value| value.to_str())
                .unwrap_or("unknown"),
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown")
        );
        eprintln!("synced {label}");
    }

    common::save_json_pretty(state_file, &state)
}

pub fn sync_openclaw_otlp_once(
    client: &Client,
    state_file: &Path,
    logs_endpoint: &str,
    traces_endpoint: &str,
) -> Result<(), String> {
    let mut state = common::load_json_object(state_file);
    let mut entries = read_openclaw_session_entries();
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

    let mut changed = Vec::new();
    for entry in entries {
        let saved = state.get(&entry.session_id).and_then(Value::as_object);
        if saved
            .and_then(|saved| saved.get("updated_at"))
            .and_then(Value::as_str)
            == Some(entry.updated_at.as_str())
        {
            continue;
        }
        changed.push(entry);
        if changed.len() >= 20 {
            break;
        }
    }

    if changed.is_empty() {
        eprintln!("no changed openclaw sessions");
        return Ok(());
    }

    for entry in changed {
        let lines = read_lines(&entry.session_file)?;
        let saved = state.get(&entry.session_id).and_then(Value::as_object);
        let mut start_index = saved
            .and_then(|saved| saved.get("line_count"))
            .and_then(common::value_to_usize)
            .unwrap_or(0);
        if start_index > lines.len() {
            start_index = 0;
        }

        if let Some((logs_payload, traces_payload)) =
            parse_openclaw_session(&entry, &lines, start_index)
        {
            if payload_has_logs(&logs_payload) {
                common::post_json(client, logs_endpoint, &logs_payload)?;
            }
            if payload_has_spans(&traces_payload) {
                common::post_json(client, traces_endpoint, &traces_payload)?;
            }
            eprintln!("synced {}", entry.session_id);
        }

        state.insert(
            entry.session_id.clone(),
            json!({
                "line_count": lines.len(),
                "updated_at": entry.updated_at,
                "path": entry.session_file,
            }),
        );
    }

    common::save_json_pretty(state_file, &state)
}

fn read_codex_session_index(codex_home: &Path) -> Vec<SessionIndexEntry> {
    let index_path = codex_home.join("session_index.jsonl");
    let Ok(lines) = read_lines(&index_path) else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    for line in lines {
        if let Some(record) = parse_json_line(&line).and_then(|value| value.as_object().cloned()) {
            let Some(id) = record.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(updated_at) = record.get("updated_at").and_then(Value::as_str) else {
                continue;
            };
            entries.push(SessionIndexEntry {
                id: id.to_string(),
                updated_at: common::coerce_iso_timestamp_str(Some(updated_at), None),
                thread_name: record
                    .get("thread_name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
    }
    entries
}

fn build_codex_session_file_map(root: &Path) -> HashMap<String, PathBuf> {
    if !root.exists() {
        return HashMap::new();
    }

    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let path = entry.into_path();
            let file_name = path.file_name()?.to_str()?;
            let session_id = extract_session_id(file_name)?;
            Some((session_id, path))
        })
        .collect()
}

fn extract_session_id(name: &str) -> Option<String> {
    let candidate = name.strip_suffix(".jsonl")?;
    if candidate.len() < 36 {
        return None;
    }

    for start in 0..=candidate.len() - 36 {
        let segment = &candidate[start..start + 36];
        if looks_like_uuid(segment) {
            return Some(segment.to_string());
        }
    }

    None
}

fn looks_like_uuid(candidate: &str) -> bool {
    if candidate.len() != 36 {
        return false;
    }

    for (index, ch) in candidate.chars().enumerate() {
        match index {
            8 | 13 | 18 | 23 if ch == '-' => {}
            8 | 13 | 18 | 23 => return false,
            _ if ch.is_ascii_hexdigit() => {}
            _ => return false,
        }
    }

    true
}

fn normalize_codex_cursor(
    raw: Option<&Value>,
    session_file: &Path,
    index_updated_at: &str,
) -> Option<SessionSyncCursor> {
    match raw {
        Some(Value::Object(map)) => Some(SessionSyncCursor {
            index_updated_at: map
                .get("index_updated_at")
                .and_then(Value::as_str)
                .map(str::to_string),
            file_mtime_ns: map
                .get("file_mtime_ns")
                .and_then(common::value_to_i64)
                .map(i128::from)
                .unwrap_or_default(),
            last_synced_line: map
                .get("last_synced_line")
                .and_then(common::value_to_usize)
                .unwrap_or(0),
        }),
        Some(Value::String(legacy_updated_at)) => Some(SessionSyncCursor {
            index_updated_at: Some(index_updated_at.to_string()),
            file_mtime_ns: 0,
            last_synced_line: infer_legacy_last_synced_line(session_file, legacy_updated_at),
        }),
        _ => None,
    }
}

fn serialize_codex_cursor(cursor: SessionSyncCursor) -> Value {
    json!({
        "index_updated_at": cursor.index_updated_at,
        "file_mtime_ns": cursor.file_mtime_ns,
        "last_synced_line": cursor.last_synced_line,
    })
}

fn infer_legacy_last_synced_line(session_file: &Path, legacy_updated_at: &str) -> usize {
    let Ok(lines) = read_lines(session_file) else {
        return 0;
    };

    let mut count = 0usize;
    for line in lines {
        if line.trim().is_empty() {
            count += 1;
            continue;
        }
        let Some(record) = parse_json_line(&line).and_then(|value| value.as_object().cloned())
        else {
            count += 1;
            continue;
        };
        let payload = record.get("payload").and_then(Value::as_object);
        let timestamp = record.get("timestamp").and_then(Value::as_str).or_else(|| {
            payload
                .and_then(|payload| payload.get("timestamp"))
                .and_then(Value::as_str)
        });
        count += 1;
        if timestamp.is_none() || timestamp > Some(legacy_updated_at) {
            return count.saturating_sub(1);
        }
    }

    count
}

fn parse_codex_session(
    session_file: &Path,
    entry: &SessionIndexEntry,
    resume_after_line: usize,
) -> Result<(Value, Value, usize), String> {
    let lines = read_lines(session_file)?;
    let session_id = format!("codex-{}", entry.id);
    let mut cwd = "~/.codex".to_string();
    let mut model = "unknown".to_string();
    let mut tool_calls: HashMap<String, CodexToolCallState> = HashMap::new();
    let mut pending_reasoning_at: Option<String> = None;
    let mut logs = Vec::new();
    let mut spans = Vec::new();
    let mut line_count = 0usize;

    for line in lines {
        line_count += 1;
        if line.trim().is_empty() {
            continue;
        }
        let Some(record) = parse_json_line(&line).and_then(|value| value.as_object().cloned())
        else {
            continue;
        };
        let record_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = record
            .get("payload")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let timestamp = common::coerce_iso_timestamp_value(
            record.get("timestamp").or_else(|| payload.get("timestamp")),
            Some(&entry.updated_at),
        );

        if record_type == "session_meta" {
            if let Some(path) = payload.get("cwd").and_then(Value::as_str) {
                cwd = path.to_string();
            }
            continue;
        }

        if record_type == "turn_context" {
            if let Some(next_model) = payload.get("model").and_then(Value::as_str) {
                model = next_model.to_string();
            }
            continue;
        }

        if record_type == "event_msg" {
            let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            if payload_type == "user_message" && line_count > resume_after_line {
                logs.push(common::log_record(
                    &timestamp,
                    "INFO",
                    payload.get("message").and_then(Value::as_str).unwrap_or(""),
                    vec![
                        common::field("session_id", &session_id),
                        common::field("message.role", "user"),
                    ],
                ));
            } else if payload_type == "agent_message" && line_count > resume_after_line {
                logs.push(common::log_record(
                    &timestamp,
                    "INFO",
                    payload.get("message").and_then(Value::as_str).unwrap_or(""),
                    vec![
                        common::field("session_id", &session_id),
                        common::field("message.role", "assistant"),
                    ],
                ));
            } else if payload_type == "token_count" {
                let usage = payload
                    .get("info")
                    .and_then(Value::as_object)
                    .and_then(|info| info.get("last_token_usage"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let input_tokens = usage
                    .get("input_tokens")
                    .and_then(common::value_to_i64)
                    .unwrap_or(0);
                let output_tokens = usage
                    .get("output_tokens")
                    .and_then(common::value_to_i64)
                    .unwrap_or(0);
                let cached_input_tokens = usage
                    .get("cached_input_tokens")
                    .and_then(common::value_to_i64)
                    .unwrap_or(0);
                if input_tokens != 0 || output_tokens != 0 || cached_input_tokens != 0 {
                    if line_count > resume_after_line {
                        let latency_ms = common::compute_duration_ms(
                            pending_reasoning_at.as_deref(),
                            &timestamp,
                        );
                        let cost_usd = estimate_codex_cost(
                            &model,
                            input_tokens,
                            cached_input_tokens,
                            output_tokens,
                        );
                        logs.push(common::log_record(
                            &timestamp,
                            "INFO",
                            "Codex model response",
                            vec![
                                common::field("session_id", &session_id),
                                common::field("model", &model),
                                common::field("input_token_count", input_tokens),
                                common::field("output_token_count", output_tokens),
                                common::field("cached_input_tokens", cached_input_tokens),
                                common::field("cost_usd", cost_usd),
                                common::field("duration_ms", latency_ms),
                            ],
                        ));
                        if let Some(started_at) = pending_reasoning_at.as_deref() {
                            spans.push(common::span_record(
                                &session_id,
                                "model.inference",
                                started_at,
                                &timestamp,
                                vec![
                                    common::field("session_id", &session_id),
                                    common::field("model", &model),
                                    common::field("gen_ai.usage.input_tokens", input_tokens),
                                    common::field("gen_ai.usage.output_tokens", output_tokens),
                                    common::field("cost_usd", cost_usd),
                                ],
                                0,
                            ));
                        }
                    }
                    pending_reasoning_at = None;
                }
            }
            continue;
        }

        if record_type == "response_item" {
            let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            if payload_type == "reasoning" {
                pending_reasoning_at = Some(timestamp.clone());
                if line_count > resume_after_line {
                    logs.push(common::log_record(
                        &timestamp,
                        "INFO",
                        "Codex reasoning step",
                        vec![
                            common::field("session_id", &session_id),
                            common::field("message.role", "reasoning"),
                            common::field("model", &model),
                        ],
                    ));
                }
            } else if payload_type == "function_call" {
                let call_id = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                tool_calls.insert(
                    call_id,
                    CodexToolCallState {
                        name: payload
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string(),
                        arguments: payload.get("arguments").cloned().unwrap_or(Value::Null),
                        started_at: timestamp.clone(),
                    },
                );
            } else if payload_type == "function_call_output" {
                let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or("");
                let call = tool_calls.get(call_id);
                let output_value = payload.get("output").cloned().unwrap_or(Value::Null);
                let output_text = match &output_value {
                    Value::String(raw) => serde_json::from_str::<Value>(raw)
                        .ok()
                        .map(|decoded| common::safe_json_dumps(&decoded))
                        .unwrap_or_else(|| raw.clone()),
                    _ => common::safe_json_dumps(&output_value),
                };
                let output_json = if let Value::String(raw) = &output_value {
                    serde_json::from_str::<Value>(raw).ok()
                } else {
                    Some(output_value.clone())
                };
                let metadata = output_json
                    .as_ref()
                    .and_then(Value::as_object)
                    .and_then(|value| value.get("metadata"))
                    .and_then(Value::as_object);
                let duration_ms = metadata_duration_ms(metadata).unwrap_or_else(|| {
                    common::compute_duration_ms(
                        call.map(|call| call.started_at.as_str()),
                        &timestamp,
                    )
                });
                let exit_code = metadata
                    .and_then(|metadata| metadata.get("exit_code"))
                    .and_then(common::value_to_i64);
                let success = exit_code.is_none() || exit_code == Some(0);
                if line_count > resume_after_line {
                    let tool_name = call.map(|call| call.name.as_str()).unwrap_or("tool");
                    logs.push(common::log_record(
                        &timestamp,
                        if success { "INFO" } else { "WARN" },
                        "Codex tool completed",
                        vec![
                            common::field("session_id", &session_id),
                            common::field("tool_name", tool_name),
                            common::field("status", if success { "completed" } else { "failed" }),
                            common::field("duration_ms", duration_ms),
                            common::field("success", success),
                            common::field("exit_code", exit_code),
                            common::field("output", output_text),
                        ],
                    ));
                    spans.push(common::span_record(
                        &session_id,
                        &format!("tool.{tool_name}"),
                        call.map(|call| call.started_at.as_str())
                            .unwrap_or(timestamp.as_str()),
                        &timestamp,
                        vec![
                            common::field("session_id", &session_id),
                            common::field("tool_name", tool_name),
                            common::field("status", if success { "completed" } else { "failed" }),
                        ],
                        if success { 0 } else { 2 },
                    ));
                }
            }
        }
    }

    Ok((
        common::build_logs_payload("codex-cli", &cwd, "codex_runtime", logs),
        common::build_traces_payload("codex-cli", &cwd, "codex_runtime", spans),
        line_count,
    ))
}

fn metadata_duration_ms(metadata: Option<&Map<String, Value>>) -> Option<i64> {
    let duration_seconds = metadata
        .and_then(|metadata| metadata.get("duration_seconds"))
        .and_then(common::value_to_f64)?;
    Some((duration_seconds * 1000.0).round() as i64)
}

fn estimate_codex_cost(
    model: &str,
    input_tokens: i64,
    cached_input_tokens: i64,
    output_tokens: i64,
) -> f64 {
    let (input_rate, cached_rate, output_rate) = if model == "gpt-5.1-codex-mini" {
        (0.3, 0.03, 1.2)
    } else {
        (1.5, 0.15, 6.0)
    };
    let non_cached = (input_tokens - cached_input_tokens).max(0) as f64;
    (non_cached / 1_000_000.0) * input_rate
        + ((cached_input_tokens.max(0) as f64) / 1_000_000.0) * cached_rate
        + ((output_tokens.max(0) as f64) / 1_000_000.0) * output_rate
}

fn normalize_guard_metrics(raw: Map<String, Value>) -> Map<String, Value> {
    let mut metrics = default_guard_metrics();
    for (key, value) in raw {
        if metrics.contains_key(&key) {
            metrics.insert(key, value);
        }
    }
    metrics
}

fn default_guard_metrics() -> Map<String, Value> {
    Map::from_iter([
        ("processed_events_total".to_string(), json!(0)),
        ("processed_events_last_run".to_string(), json!(0)),
        ("blocked_events_total".to_string(), json!(0)),
        ("blocked_events_last_run".to_string(), json!(0)),
        ("prompt_events_total".to_string(), json!(0)),
        ("prompt_events_last_run".to_string(), json!(0)),
        ("tool_call_events_total".to_string(), json!(0)),
        ("tool_call_events_last_run".to_string(), json!(0)),
        ("output_events_total".to_string(), json!(0)),
        ("output_events_last_run".to_string(), json!(0)),
        ("soft_stop_enabled".to_string(), json!(false)),
        ("soft_stop_attempts_total".to_string(), json!(0)),
        ("soft_stop_attempts_last_run".to_string(), json!(0)),
        ("soft_stop_success_total".to_string(), json!(0)),
        ("soft_stop_success_last_run".to_string(), json!(0)),
        ("last_run_at".to_string(), Value::Null),
        ("last_blocked_event_at".to_string(), Value::Null),
        ("last_soft_stop_at".to_string(), Value::Null),
        ("last_soft_stop_result".to_string(), Value::Null),
    ])
}

fn reset_guard_last_run_metrics(metrics: &mut Map<String, Value>, experimental_soft_stop: bool) {
    for key in [
        "processed_events_last_run",
        "blocked_events_last_run",
        "prompt_events_last_run",
        "tool_call_events_last_run",
        "output_events_last_run",
        "soft_stop_attempts_last_run",
        "soft_stop_success_last_run",
    ] {
        metrics.insert(key.to_string(), json!(0));
    }
    metrics.insert(
        "soft_stop_enabled".to_string(),
        json!(experimental_soft_stop),
    );
    metrics.insert(
        "last_run_at".to_string(),
        json!(common::current_timestamp()),
    );
}

fn should_sync_guard_entry(entry: &SessionIndexEntry, saved: Option<&Value>) -> bool {
    saved
        .and_then(Value::as_object)
        .and_then(|saved| saved.get("updated_at"))
        .and_then(Value::as_str)
        != Some(entry.updated_at.as_str())
}

fn process_codex_guard_session(
    client: &Client,
    session_file: &Path,
    entry: &SessionIndexEntry,
    sessions_state: &mut Map<String, Value>,
    state_file: &Path,
    guard_base_url: &str,
    metrics: &mut Map<String, Value>,
    experimental_soft_stop: bool,
) -> Result<(), String> {
    let previous = sessions_state.get(&entry.id).and_then(Value::as_object);
    let mut line_cursor = previous
        .and_then(|saved| saved.get("line_cursor"))
        .and_then(common::value_to_usize)
        .unwrap_or(0);

    let lines = read_lines(session_file)?;
    if line_cursor > lines.len() {
        line_cursor = 0;
    }

    let session_id = format!("codex-{}", entry.id);
    let mut workspace_path = "~/.codex".to_string();
    let mut model = "unknown".to_string();
    let mut tool_calls: HashMap<String, CodexToolCallState> = HashMap::new();

    checkpoint_guard_session(
        sessions_state,
        state_file,
        entry,
        session_file,
        line_cursor,
        &workspace_path,
        metrics,
    )?;

    for (index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            checkpoint_guard_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                &workspace_path,
                metrics,
            )?;
            continue;
        }

        let Some(record) = parse_json_line(line).and_then(|value| value.as_object().cloned())
        else {
            checkpoint_guard_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                &workspace_path,
                metrics,
            )?;
            continue;
        };

        let record_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = record
            .get("payload")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let timestamp = common::coerce_iso_timestamp_value(
            record.get("timestamp").or_else(|| payload.get("timestamp")),
            Some(&entry.updated_at),
        );

        if record_type == "session_meta" {
            if let Some(path) = payload.get("cwd").and_then(Value::as_str) {
                workspace_path = path.to_string();
            }
            checkpoint_guard_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                &workspace_path,
                metrics,
            )?;
            continue;
        }

        if record_type == "turn_context" {
            if let Some(next_model) = payload.get("model").and_then(Value::as_str) {
                model = next_model.to_string();
            }
            checkpoint_guard_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                &workspace_path,
                metrics,
            )?;
            continue;
        }

        if record_type == "response_item" {
            let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            if payload_type == "function_call" {
                let call_id = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let tool_name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let parsed_arguments = parse_tool_arguments(payload.get("arguments"));
                tool_calls.insert(
                    call_id,
                    CodexToolCallState {
                        name: tool_name.clone(),
                        arguments: parsed_arguments.clone(),
                        started_at: timestamp.clone(),
                    },
                );
                if index >= line_cursor {
                    let decision = post_guard_tool_call(
                        client,
                        guard_base_url,
                        &session_id,
                        entry.thread_name.as_deref(),
                        &workspace_path,
                        &timestamp,
                        &tool_name,
                        &parsed_arguments,
                        &model,
                    )?;
                    register_guard_result(metrics, "tool_call", &decision, &timestamp);
                    if is_blocked_decision(&decision) && experimental_soft_stop {
                        let command_text = command_candidate_from_params(&parsed_arguments);
                        let (success, result_label) =
                            attempt_soft_stop(&tool_name, &workspace_path, command_text.as_deref());
                        increment_metric(metrics, "soft_stop_attempts_total");
                        increment_metric(metrics, "soft_stop_attempts_last_run");
                        metrics.insert("last_soft_stop_at".to_string(), json!(timestamp));
                        metrics.insert("last_soft_stop_result".to_string(), json!(result_label));
                        if success {
                            increment_metric(metrics, "soft_stop_success_total");
                            increment_metric(metrics, "soft_stop_success_last_run");
                        }
                    }
                }
            } else if payload_type == "function_call_output" && index >= line_cursor {
                let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or("");
                let call = tool_calls.get(call_id);
                let output_text = extract_tool_output_text(payload.get("output"));
                if !output_text.is_empty() {
                    let decision = post_guard_output(
                        client,
                        guard_base_url,
                        &session_id,
                        entry.thread_name.as_deref(),
                        &workspace_path,
                        &timestamp,
                        &output_text,
                        "tool_output",
                    )?;
                    register_guard_result(metrics, "output", &decision, &timestamp);
                }
                if let Some(call) = call {
                    let _ = &call.arguments;
                }
            }

            checkpoint_guard_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                &workspace_path,
                metrics,
            )?;
            continue;
        }

        if record_type == "event_msg" {
            let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            if payload_type == "user_message" && index >= line_cursor {
                let text = payload
                    .get("message")
                    .map(common::flatten_text)
                    .unwrap_or_default();
                if !text.is_empty() {
                    let decision = post_guard_prompt(
                        client,
                        guard_base_url,
                        &session_id,
                        entry.thread_name.as_deref(),
                        &workspace_path,
                        &timestamp,
                        &text,
                    )?;
                    register_guard_result(metrics, "prompt", &decision, &timestamp);
                }
            } else if payload_type == "agent_message" && index >= line_cursor {
                let text = payload
                    .get("message")
                    .map(common::flatten_text)
                    .unwrap_or_default();
                if !text.is_empty() {
                    let decision = post_guard_output(
                        client,
                        guard_base_url,
                        &session_id,
                        entry.thread_name.as_deref(),
                        &workspace_path,
                        &timestamp,
                        &text,
                        "assistant_message",
                    )?;
                    register_guard_result(metrics, "output", &decision, &timestamp);
                }
            }

            checkpoint_guard_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                &workspace_path,
                metrics,
            )?;
            continue;
        }

        checkpoint_guard_session(
            sessions_state,
            state_file,
            entry,
            session_file,
            index + 1,
            &workspace_path,
            metrics,
        )?;
    }

    Ok(())
}

fn persist_guard_state(
    state_file: &Path,
    sessions_state: &Map<String, Value>,
    metrics: &Map<String, Value>,
) -> Result<(), String> {
    common::save_json_pretty(
        state_file,
        &json!({
            "sessions": sessions_state,
            "metrics": metrics,
        }),
    )
}

fn checkpoint_guard_session(
    sessions_state: &mut Map<String, Value>,
    state_file: &Path,
    entry: &SessionIndexEntry,
    session_file: &Path,
    line_cursor: usize,
    workspace_path: &str,
    metrics: &Map<String, Value>,
) -> Result<(), String> {
    sessions_state.insert(
        entry.id.clone(),
        json!({
            "updated_at": entry.updated_at,
            "line_cursor": line_cursor,
            "workspace_path": workspace_path,
            "thread_name": entry.thread_name,
            "session_file": session_file,
        }),
    );
    persist_guard_state(state_file, sessions_state, metrics)
}

fn parse_tool_arguments(arguments: Option<&Value>) -> Value {
    match arguments {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::Array(items)) => Value::Array(items.clone()),
        Some(Value::String(raw)) => {
            let stripped = raw.trim();
            if stripped.is_empty() {
                json!({})
            } else if let Ok(parsed) = serde_json::from_str::<Value>(stripped) {
                match parsed {
                    Value::Object(_) | Value::Array(_) => parsed,
                    other => json!({ "raw_value": other }),
                }
            } else {
                json!({ "raw_arguments": raw })
            }
        }
        Some(other) => json!({ "raw_arguments": common::safe_json_dumps(other) }),
        None => json!({}),
    }
}

fn extract_tool_output_text(output: Option<&Value>) -> String {
    let decoded = match output {
        Some(Value::String(raw)) => {
            let stripped = raw.trim();
            if stripped.is_empty() {
                return String::new();
            }
            serde_json::from_str::<Value>(stripped).unwrap_or_else(|_| Value::String(raw.clone()))
        }
        Some(other) => other.clone(),
        None => Value::Null,
    };

    let text = common::flatten_text(&decoded);
    if !text.is_empty() {
        return text;
    }
    common::safe_json_dumps(&decoded)
}

fn register_guard_result(
    metrics: &mut Map<String, Value>,
    event_kind: &str,
    response: &Value,
    timestamp: &str,
) {
    increment_metric(metrics, "processed_events_total");
    increment_metric(metrics, "processed_events_last_run");

    match event_kind {
        "prompt" => {
            increment_metric(metrics, "prompt_events_total");
            increment_metric(metrics, "prompt_events_last_run");
        }
        "tool_call" => {
            increment_metric(metrics, "tool_call_events_total");
            increment_metric(metrics, "tool_call_events_last_run");
        }
        "output" => {
            increment_metric(metrics, "output_events_total");
            increment_metric(metrics, "output_events_last_run");
        }
        _ => {}
    }

    if is_blocked_decision(response) {
        increment_metric(metrics, "blocked_events_total");
        increment_metric(metrics, "blocked_events_last_run");
        metrics.insert("last_blocked_event_at".to_string(), json!(timestamp));
    }
}

fn is_blocked_decision(response: &Value) -> bool {
    response
        .get("decision")
        .and_then(Value::as_object)
        .and_then(|decision| decision.get("blocked"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn post_guard_prompt(
    client: &Client,
    guard_base_url: &str,
    session_id: &str,
    thread_name: Option<&str>,
    workspace_path: &str,
    timestamp: &str,
    text: &str,
) -> Result<Value, String> {
    common::post_json_read_json(
        client,
        &format!("{guard_base_url}/v1/runtime/prompt"),
        &json!({
            "session_id": session_id,
            "source": "codex",
            "workspace_path": workspace_path,
            "timestamp": timestamp,
            "requester_id": thread_name,
            "channel": "user_message",
            "verified_owner": false,
            "prompt": text,
        }),
    )
}

fn post_guard_tool_call(
    client: &Client,
    guard_base_url: &str,
    session_id: &str,
    thread_name: Option<&str>,
    workspace_path: &str,
    timestamp: &str,
    tool_name: &str,
    params: &Value,
    model: &str,
) -> Result<Value, String> {
    let params_payload = match params {
        Value::Object(map) => {
            let mut merged = map.clone();
            merged.insert("model".to_string(), json!(model));
            Value::Object(merged)
        }
        other => json!({
            "model": model,
            "arguments": other,
        }),
    };
    common::post_json_read_json(
        client,
        &format!("{guard_base_url}/v1/runtime/tool-call"),
        &json!({
            "session_id": session_id,
            "source": "codex",
            "workspace_path": workspace_path,
            "timestamp": timestamp,
            "requester_id": thread_name,
            "channel": "function_call",
            "verified_owner": false,
            "tool_name": tool_name,
            "params": params_payload,
        }),
    )
}

fn post_guard_output(
    client: &Client,
    guard_base_url: &str,
    session_id: &str,
    thread_name: Option<&str>,
    workspace_path: &str,
    timestamp: &str,
    text: &str,
    channel: &str,
) -> Result<Value, String> {
    common::post_json_read_json(
        client,
        &format!("{guard_base_url}/v1/runtime/output"),
        &json!({
            "session_id": session_id,
            "source": "codex",
            "workspace_path": workspace_path,
            "timestamp": timestamp,
            "requester_id": thread_name,
            "channel": channel,
            "verified_owner": false,
            "output": text,
        }),
    )
}

fn command_candidate_from_params(params: &Value) -> Option<String> {
    match params {
        Value::Object(map) => {
            for key in ["command", "cmd", "raw_arguments"] {
                if let Some(value) = map.get(key).and_then(Value::as_str) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
            map.get("arguments")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        }
        Value::String(value) => {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        _ => None,
    }
}

fn attempt_soft_stop(
    tool_name: &str,
    workspace_path: &str,
    command_text: Option<&str>,
) -> (bool, String) {
    if !matches!(tool_name, "exec" | "exec_command" | "shell_command") {
        return (false, "unsupported_tool".to_string());
    }
    let Some(command_text) = command_text
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (false, "missing_command".to_string());
    };

    let process_ids = matching_process_ids(command_text, workspace_path);
    if process_ids.is_empty() {
        return (false, "no_matching_process".to_string());
    }

    let mut stopped = Vec::new();
    for pid in process_ids {
        let status = Command::new("kill")
            .arg("-INT")
            .arg(pid.to_string())
            .status();
        if matches!(status, Ok(status) if status.success()) {
            stopped.push(pid);
        }
    }

    if stopped.is_empty() {
        return (false, "signal_failed".to_string());
    }

    (
        true,
        format!(
            "signaled:{}",
            stopped
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
    )
}

fn matching_process_ids(command_text: &str, workspace_path: &str) -> Vec<i32> {
    let normalized = command_text.trim();
    if normalized.is_empty() {
        return Vec::new();
    }

    let Ok(output) = Command::new("ps")
        .arg("-Ao")
        .arg("pid=,ppid=,command=")
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let full_snippet = normalized
        .chars()
        .take(96)
        .collect::<String>()
        .to_lowercase();
    let required_tokens = normalized
        .split_whitespace()
        .filter(|token| token.len() >= 3 && !token.starts_with('-'))
        .take(2)
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let workspace_lower = workspace_path.to_lowercase();
    let current_pid = std::process::id() as i32;
    let mut matched = Vec::new();

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let stripped = line.trim();
        if stripped.is_empty() {
            continue;
        }
        let mut parts = stripped.splitn(3, char::is_whitespace);
        let Some(pid_str) = parts.next() else {
            continue;
        };
        let _ = parts.next();
        let Some(command) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_str.trim().parse::<i32>() else {
            continue;
        };
        if pid == current_pid {
            continue;
        }

        let lower_command = command.to_lowercase();
        if lower_command.contains("codex_guard_adapter.py")
            || lower_command.contains("ps -ao pid=,ppid=,command=")
            || lower_command.contains("codex app-server")
            || lower_command.contains("codex helper")
        {
            continue;
        }

        if !full_snippet.is_empty() && lower_command.contains(&full_snippet) {
            matched.push(pid);
            continue;
        }

        if !workspace_lower.is_empty()
            && lower_command.contains(&workspace_lower)
            && !required_tokens.is_empty()
            && required_tokens
                .iter()
                .any(|token| lower_command.contains(token))
        {
            matched.push(pid);
            continue;
        }

        if !required_tokens.is_empty()
            && required_tokens
                .iter()
                .all(|token| lower_command.contains(token))
        {
            matched.push(pid);
        }
    }

    matched
}

fn increment_metric(metrics: &mut Map<String, Value>, key: &str) {
    let next = metrics.get(key).and_then(common::value_to_i64).unwrap_or(0) + 1;
    metrics.insert(key.to_string(), json!(next));
}

fn read_gemini_session_entries(gemini_home: &Path) -> Vec<GeminiSessionEntry> {
    let tmp_root = gemini_home.join("tmp");
    if !tmp_root.exists() {
        return Vec::new();
    }

    let project_paths = read_gemini_project_paths(gemini_home);
    let mut entries = Vec::new();
    for entry in WalkDir::new(&tmp_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.starts_with("session-") || !file_name.ends_with(".json") {
            continue;
        }
        let raw = common::read_json_file(path);
        let Some(raw_object) = raw.as_object() else {
            continue;
        };
        let Some(session_id) = raw_object.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let updated_at = common::coerce_iso_timestamp_value(
            raw_object
                .get("lastUpdated")
                .or_else(|| raw_object.get("startTime")),
            None,
        );
        let project_key = path
            .parent()
            .and_then(Path::parent)
            .and_then(|path| path.file_name())
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        entries.push(GeminiSessionEntry {
            session_id: session_id.to_string(),
            path: path.to_path_buf(),
            updated_at,
            workspace_path: resolve_gemini_workspace_path(
                gemini_home,
                &project_key,
                &project_paths,
            ),
        });
    }
    entries
}

fn read_gemini_project_paths(gemini_home: &Path) -> HashMap<String, String> {
    let raw = common::read_json_file(&gemini_home.join("projects.json"));
    let Some(projects) = raw
        .as_object()
        .and_then(|raw| raw.get("projects"))
        .and_then(Value::as_object)
    else {
        return HashMap::new();
    };

    let mut resolved = HashMap::new();
    for (workspace_path, key) in projects {
        if let Some(key) = key.as_str() {
            resolved.insert(key.to_string(), workspace_path.to_string());
        }
    }
    resolved
}

fn resolve_gemini_workspace_path(
    gemini_home: &Path,
    project_key: &str,
    project_paths: &HashMap<String, String>,
) -> String {
    if let Some(path) = project_paths.get(project_key) {
        return path.clone();
    }

    let project_root_path = gemini_home
        .join("history")
        .join(project_key)
        .join(".project_root");
    if let Ok(value) = fs::read_to_string(&project_root_path) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    gemini_home
        .join("tmp")
        .join(project_key)
        .to_string_lossy()
        .to_string()
}

fn parse_gemini_session(
    entry: &GeminiSessionEntry,
    raw: &Value,
    start_index: usize,
) -> Option<(Value, Value)> {
    let session_id = format!("gemini-{}", entry.session_id);
    let messages = raw.get("messages")?.as_array()?;
    let mut logs = Vec::new();
    let mut spans = Vec::new();
    let mut last_user_at =
        common::coerce_iso_timestamp_value(raw.get("startTime"), Some(&entry.updated_at));

    for (index, message) in messages.iter().enumerate() {
        if index < start_index {
            if message
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value.eq_ignore_ascii_case("user"))
                .unwrap_or(false)
            {
                last_user_at = common::coerce_iso_timestamp_value(
                    message.get("timestamp"),
                    Some(&last_user_at),
                );
            }
            continue;
        }

        let Some(message_object) = message.as_object() else {
            continue;
        };
        let message_type = message_object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let timestamp = common::coerce_iso_timestamp_value(
            message_object.get("timestamp"),
            Some(&entry.updated_at),
        );

        if message_type == "user" {
            let prompt = message_object
                .get("content")
                .map(common::flatten_text)
                .unwrap_or_default();
            logs.push(common::log_record(
                &timestamp,
                "INFO",
                if prompt.is_empty() {
                    "Gemini user prompt"
                } else {
                    prompt.as_str()
                },
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "user_prompt"),
                    common::field("prompt", &prompt),
                    common::field("prompt_length", prompt.len()),
                ],
            ));
            last_user_at = timestamp;
            continue;
        }

        if message_type == "gemini" {
            let model = message_object
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("gemini");
            let tokens = message_object
                .get("tokens")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let body = message_object
                .get("content")
                .map(common::flatten_text)
                .unwrap_or_default();
            let latency_ms = common::compute_duration_ms(Some(&last_user_at), &timestamp);
            let input_tokens = tokens
                .get("input")
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            let output_tokens = tokens
                .get("output")
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            let cached_tokens = tokens
                .get("cached")
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            let thought_tokens = tokens
                .get("thoughts")
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            let tool_tokens = tokens
                .get("tool")
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            if !body.is_empty()
                || input_tokens != 0
                || output_tokens != 0
                || cached_tokens != 0
                || thought_tokens != 0
                || tool_tokens != 0
            {
                let response_body = if body.is_empty() {
                    format!("Gemini response from {model}")
                } else {
                    body.clone()
                };
                logs.push(common::log_record(
                    &timestamp,
                    "INFO",
                    &response_body,
                    vec![
                        common::field("session_id", &session_id),
                        common::field("event.name", "gemini_cli.api_response"),
                        common::field("model", model),
                        common::field("input_token_count", input_tokens),
                        common::field("output_token_count", output_tokens),
                        common::field("cached_content_token_count", cached_tokens),
                        common::field("thoughts_token_count", thought_tokens),
                        common::field("tool_token_count", tool_tokens),
                        common::field("duration_ms", latency_ms),
                    ],
                ));
                if latency_ms > 0 {
                    spans.push(common::span_record(
                        &session_id,
                        "model.inference",
                        &last_user_at,
                        &timestamp,
                        vec![
                            common::field("session_id", &session_id),
                            common::field("model", model),
                            common::field("gen_ai.usage.input_tokens", input_tokens),
                            common::field("gen_ai.usage.output_tokens", output_tokens),
                        ],
                        0,
                    ));
                }
            }

            if let Some(tool_calls) = message_object.get("toolCalls").and_then(Value::as_array) {
                for tool_call in tool_calls {
                    let Some(tool_call) = tool_call.as_object() else {
                        continue;
                    };
                    let tool_time = common::coerce_iso_timestamp_value(
                        tool_call.get("timestamp"),
                        Some(&timestamp),
                    );
                    let tool_name = tool_call
                        .get("name")
                        .and_then(Value::as_str)
                        .or_else(|| tool_call.get("displayName").and_then(Value::as_str))
                        .unwrap_or("tool");
                    let result_display = tool_call
                        .get("resultDisplay")
                        .map(common::flatten_text)
                        .filter(|text| !text.is_empty())
                        .or_else(|| tool_call.get("result").map(common::flatten_text))
                        .unwrap_or_default();
                    let status = tool_call
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed")
                        .to_lowercase();
                    let tool_body = if result_display.is_empty() {
                        format!("Gemini tool call: {tool_name}")
                    } else {
                        result_display.clone()
                    };
                    logs.push(common::log_record(
                        &tool_time,
                        if matches!(status.as_str(), "error" | "failed" | "cancelled") {
                            "WARN"
                        } else {
                            "INFO"
                        },
                        &tool_body,
                        vec![
                            common::field("session_id", &session_id),
                            common::field("event.name", "gemini_cli.tool_call"),
                            common::field("tool_name", tool_name),
                            common::field("function_name", tool_name),
                            common::field("function_args", tool_call.get("args").cloned()),
                            common::field("status", &status),
                            common::field(
                                "success",
                                !matches!(status.as_str(), "error" | "failed" | "cancelled"),
                            ),
                            common::field(
                                "duration_ms",
                                common::compute_duration_ms(Some(&last_user_at), &tool_time),
                            ),
                        ],
                    ));
                }
            }
            continue;
        }

        if message_type == "error" {
            let body = message_object
                .get("content")
                .map(common::flatten_text)
                .unwrap_or_default();
            logs.push(common::log_record(
                &timestamp,
                "WARN",
                if body.is_empty() {
                    "Gemini runtime error"
                } else {
                    body.as_str()
                },
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "runtime_error"),
                ],
            ));
            continue;
        }

        if message_type == "info" {
            let body = message_object
                .get("content")
                .map(common::flatten_text)
                .unwrap_or_default();
            logs.push(common::log_record(
                &timestamp,
                "INFO",
                if body.is_empty() {
                    "Gemini runtime info"
                } else {
                    body.as_str()
                },
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "runtime_log"),
                ],
            ));
        }
    }

    if logs.is_empty() && spans.is_empty() {
        return None;
    }

    Some((
        common::build_logs_payload("gemini-cli", &entry.workspace_path, "gemini_cli", logs),
        common::build_traces_payload("gemini-cli", &entry.workspace_path, "gemini_cli", spans),
    ))
}

fn read_claude_session_entries() -> Vec<ClaudeSessionEntry> {
    let mut entries = Vec::new();
    for root in claude_candidate_roots() {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(updated_at) = common::file_modified_iso(path) else {
                continue;
            };
            let Some(session_id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            entries.push(ClaudeSessionEntry {
                session_id: session_id.to_string(),
                path: path.to_path_buf(),
                updated_at,
                workspace_path: infer_claude_workspace_path(&root, path),
            });
        }
    }
    entries
}

fn parse_claude_session(
    entry: &ClaudeSessionEntry,
    lines: &[String],
    start_index: usize,
) -> Option<(Value, Value)> {
    let session_id = format!("claude-{}", entry.session_id);
    let mut logs = Vec::new();
    let mut spans = Vec::new();
    let mut last_user_at: Option<String> = None;

    for (index, line) in lines.iter().enumerate() {
        if index < start_index || line.trim().is_empty() {
            continue;
        }
        let Some(record) = parse_json_line(line).and_then(|value| value.as_object().cloned())
        else {
            continue;
        };
        let record_type = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let timestamp =
            common::coerce_iso_timestamp_value(record.get("timestamp"), Some(&entry.updated_at));
        let message = record
            .get("message")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        if record_type == "user" {
            let prompt = message
                .get("content")
                .map(common::flatten_text)
                .filter(|text| !text.is_empty())
                .or_else(|| message.get("text").map(common::flatten_text))
                .filter(|text| !text.is_empty())
                .or_else(|| record.get("text").map(common::flatten_text))
                .unwrap_or_default();
            logs.push(common::log_record(
                &timestamp,
                "INFO",
                if prompt.is_empty() {
                    "Claude user prompt"
                } else {
                    prompt.as_str()
                },
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "user_prompt"),
                    common::field("prompt", &prompt),
                    common::field("prompt_length", prompt.len()),
                ],
            ));
            last_user_at = Some(timestamp);
            continue;
        }

        if record_type == "assistant" {
            let usage = message
                .get("usage")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let model = message
                .get("model")
                .and_then(Value::as_str)
                .or_else(|| record.get("model").and_then(Value::as_str))
                .unwrap_or("unknown");
            let body = message
                .get("content")
                .map(common::flatten_text)
                .filter(|text| !text.is_empty())
                .or_else(|| message.get("text").map(common::flatten_text))
                .filter(|text| !text.is_empty())
                .or_else(|| record.get("content").map(common::flatten_text))
                .unwrap_or_default();
            let input_tokens = usage
                .get("input_tokens")
                .or_else(|| usage.get("inputTokens"))
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            let output_tokens = usage
                .get("output_tokens")
                .or_else(|| usage.get("outputTokens"))
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            let cached_tokens = usage
                .get("cache_read_input_tokens")
                .or_else(|| usage.get("cacheReadInputTokens"))
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            let latency_ms = last_user_at
                .as_deref()
                .map(|started_at| common::compute_duration_ms(Some(started_at), &timestamp))
                .unwrap_or(0);
            let response_body = if body.is_empty() {
                format!("Claude response from {model}")
            } else {
                body.clone()
            };
            logs.push(common::log_record(
                &timestamp,
                "INFO",
                &response_body,
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "claude.api_response"),
                    common::field("model", model),
                    common::field("input_token_count", input_tokens),
                    common::field("output_token_count", output_tokens),
                    common::field("cached_input_tokens", cached_tokens),
                    common::field("duration_ms", latency_ms),
                ],
            ));
            if latency_ms > 0 {
                spans.push(common::span_record(
                    &session_id,
                    "model.inference",
                    last_user_at.as_deref().unwrap_or(timestamp.as_str()),
                    &timestamp,
                    vec![
                        common::field("session_id", &session_id),
                        common::field("model", model),
                        common::field("gen_ai.usage.input_tokens", input_tokens),
                        common::field("gen_ai.usage.output_tokens", output_tokens),
                    ],
                    0,
                ));
            }
            continue;
        }

        if matches!(record_type.as_str(), "tool" | "tool_use" | "tool_result") {
            let message_name = message
                .get("name")
                .map(common::flatten_text)
                .unwrap_or_default();
            let tool_name = record
                .get("tool_name")
                .and_then(Value::as_str)
                .or_else(|| record.get("name").and_then(Value::as_str))
                .or_else(|| (!message_name.is_empty()).then_some(message_name.as_str()))
                .unwrap_or("tool")
                .to_string();
            let body = record
                .get("content")
                .map(common::flatten_text)
                .filter(|text| !text.is_empty())
                .or_else(|| message.get("content").map(common::flatten_text))
                .unwrap_or_else(|| format!("Claude tool call: {tool_name}"));
            logs.push(common::log_record(
                &timestamp,
                "INFO",
                &body,
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "claude.tool_call"),
                    common::field("tool_name", &tool_name),
                    common::field(
                        "status",
                        record
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("completed")
                            .to_lowercase(),
                    ),
                ],
            ));
        }
    }

    if logs.is_empty() && spans.is_empty() {
        return None;
    }

    Some((
        common::build_logs_payload("claude-code", &entry.workspace_path, "claude_runtime", logs),
        common::build_traces_payload(
            "claude-code",
            &entry.workspace_path,
            "claude_runtime",
            spans,
        ),
    ))
}

fn read_openclaw_session_entries() -> Vec<OpenClawSessionEntry> {
    let mut entries = Vec::new();
    let mut seen_files = HashSet::new();

    for root in openclaw_candidate_roots() {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() || entry.file_name() != "sessions.json" {
                continue;
            }
            let raw = common::read_json_file(entry.path());
            let Some(index) = raw.as_object() else {
                continue;
            };
            for value in index.values() {
                let Some(value) = value.as_object() else {
                    continue;
                };
                let Some(session_id) = value.get("sessionId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(session_file_value) = value.get("sessionFile").and_then(Value::as_str)
                else {
                    continue;
                };

                let mut session_file = PathBuf::from(session_file_value);
                if !session_file.exists() {
                    if let Some(file_name) = Path::new(session_file_value).file_name() {
                        session_file = entry
                            .path()
                            .parent()
                            .unwrap_or(root.as_path())
                            .join(file_name);
                    }
                    if !session_file.exists() {
                        continue;
                    }
                }
                let normalized = session_file.to_string_lossy().to_string();
                if !seen_files.insert(normalized) {
                    continue;
                }
                let Some(updated_at) = common::file_modified_iso(&session_file) else {
                    continue;
                };
                entries.push(OpenClawSessionEntry {
                    session_id: session_id.to_string(),
                    session_file: session_file.clone(),
                    updated_at,
                    workspace_path: infer_openclaw_workspace_path(root.as_path(), &session_file),
                });
            }
        }
    }

    entries
}

fn parse_openclaw_session(
    entry: &OpenClawSessionEntry,
    lines: &[String],
    start_index: usize,
) -> Option<(Value, Value)> {
    let session_id = format!("openclaw-{}", entry.session_id);
    let mut logs = Vec::new();
    let mut spans = Vec::new();
    let mut current_model = "unknown".to_string();
    let mut current_provider = "unknown".to_string();
    let mut last_user_at: Option<String> = None;

    for (index, line) in lines.iter().enumerate() {
        if index < start_index || line.trim().is_empty() {
            continue;
        }
        let Some(record) = parse_json_line(line).and_then(|value| value.as_object().cloned())
        else {
            continue;
        };
        let record_type = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if record_type == "model_change" {
            if let Some(provider) = record.get("provider").and_then(Value::as_str) {
                current_provider = provider.to_string();
            }
            if let Some(model) = record
                .get("modelId")
                .and_then(Value::as_str)
                .or_else(|| record.get("model").and_then(Value::as_str))
            {
                current_model = model.to_string();
            }
            continue;
        }

        if record_type == "message" {
            let message = record
                .get("message")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .or_else(|| record.get("role").and_then(Value::as_str))
                .unwrap_or("")
                .to_lowercase();
            let timestamp = common::coerce_iso_timestamp_value(
                message.get("timestamp").or_else(|| record.get("timestamp")),
                Some(&entry.updated_at),
            );
            if role == "user" {
                let prompt = message
                    .get("content")
                    .map(common::flatten_text)
                    .filter(|text| !text.is_empty())
                    .or_else(|| message.get("parts").map(common::flatten_text))
                    .filter(|text| !text.is_empty())
                    .or_else(|| message.get("text").map(common::flatten_text))
                    .unwrap_or_default();
                logs.push(common::log_record(
                    &timestamp,
                    "INFO",
                    if prompt.is_empty() {
                        "OpenClaw user prompt"
                    } else {
                        prompt.as_str()
                    },
                    vec![
                        common::field("session_id", &session_id),
                        common::field("event.name", "user_prompt"),
                        common::field("prompt", &prompt),
                        common::field("prompt_length", prompt.len()),
                    ],
                ));
                last_user_at = Some(timestamp);
                continue;
            }

            if role == "assistant" {
                let usage = message
                    .get("usage")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let model = message
                    .get("modelId")
                    .and_then(Value::as_str)
                    .or_else(|| record.get("modelId").and_then(Value::as_str))
                    .unwrap_or(current_model.as_str());
                let provider = message
                    .get("provider")
                    .and_then(Value::as_str)
                    .or_else(|| record.get("provider").and_then(Value::as_str))
                    .unwrap_or(current_provider.as_str());
                let body = message
                    .get("content")
                    .map(common::flatten_text)
                    .filter(|text| !text.is_empty())
                    .or_else(|| message.get("parts").map(common::flatten_text))
                    .filter(|text| !text.is_empty())
                    .or_else(|| message.get("text").map(common::flatten_text))
                    .unwrap_or_default();
                let latency_ms = last_user_at
                    .as_deref()
                    .map(|started_at| common::compute_duration_ms(Some(started_at), &timestamp))
                    .unwrap_or(0);
                let input_tokens = usage
                    .get("input")
                    .or_else(|| usage.get("inputTokens"))
                    .and_then(common::value_to_i64)
                    .unwrap_or(0);
                let output_tokens = usage
                    .get("output")
                    .or_else(|| usage.get("outputTokens"))
                    .and_then(common::value_to_i64)
                    .unwrap_or(0);
                let cached_tokens = usage
                    .get("cacheRead")
                    .and_then(common::value_to_i64)
                    .or_else(|| {
                        usage
                            .get("cache")
                            .and_then(Value::as_object)
                            .and_then(|cache| cache.get("read"))
                            .and_then(common::value_to_i64)
                    })
                    .unwrap_or(0);
                let cost_total = usage
                    .get("cost")
                    .and_then(|cost| {
                        if let Some(object) = cost.as_object() {
                            object.get("total")
                        } else {
                            Some(cost)
                        }
                    })
                    .and_then(common::value_to_f64)
                    .unwrap_or(0.0);
                let response_body = if body.is_empty() {
                    format!("OpenClaw response from {provider}/{model}")
                } else {
                    body.clone()
                };
                logs.push(common::log_record(
                    &timestamp,
                    "INFO",
                    &response_body,
                    vec![
                        common::field("session_id", &session_id),
                        common::field("event.name", "openclaw.api_response"),
                        common::field("provider", provider),
                        common::field("model", model),
                        common::field("input_token_count", input_tokens),
                        common::field("output_token_count", output_tokens),
                        common::field("cached_input_tokens", cached_tokens),
                        common::field("cost_usd", cost_total),
                        common::field("duration_ms", latency_ms),
                    ],
                ));
                if latency_ms > 0 {
                    spans.push(common::span_record(
                        &session_id,
                        "model.inference",
                        last_user_at.as_deref().unwrap_or(timestamp.as_str()),
                        &timestamp,
                        vec![
                            common::field("session_id", &session_id),
                            common::field("model", model),
                            common::field("gen_ai.usage.input_tokens", input_tokens),
                            common::field("gen_ai.usage.output_tokens", output_tokens),
                            common::field("cost_usd", cost_total),
                        ],
                        0,
                    ));
                }
                continue;
            }
        }

        if matches!(record_type.as_str(), "tool" | "tool_call" | "tool_result") {
            let timestamp = common::coerce_iso_timestamp_value(
                record.get("timestamp"),
                Some(&entry.updated_at),
            );
            let tool_name = record
                .get("toolName")
                .and_then(Value::as_str)
                .or_else(|| record.get("tool_name").and_then(Value::as_str))
                .or_else(|| record.get("name").and_then(Value::as_str))
                .unwrap_or("tool");
            let status = record
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed")
                .to_lowercase();
            let body = record
                .get("result")
                .map(common::flatten_text)
                .filter(|text| !text.is_empty())
                .or_else(|| record.get("content").map(common::flatten_text))
                .unwrap_or_else(|| format!("OpenClaw tool call: {tool_name}"));
            logs.push(common::log_record(
                &timestamp,
                if matches!(status.as_str(), "error" | "failed" | "cancelled") {
                    "WARN"
                } else {
                    "INFO"
                },
                &body,
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "openclaw.tool_call"),
                    common::field("tool_name", tool_name),
                    common::field("status", &status),
                ],
            ));
        }
    }

    if logs.is_empty() && spans.is_empty() {
        return None;
    }

    Some((
        common::build_logs_payload("openclaw", &entry.workspace_path, "openclaw_runtime", logs),
        common::build_traces_payload("openclaw", &entry.workspace_path, "openclaw_runtime", spans),
    ))
}

fn read_qwen_chat_entries(qwen_home: &Path) -> Vec<ChatEntry> {
    let chats_root = qwen_home.join("projects");
    if !chats_root.exists() {
        return Vec::new();
    }

    let mut entries = Vec::new();
    for entry in WalkDir::new(&chats_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(updated_at) = detect_qwen_last_timestamp(path) else {
            continue;
        };
        let Some(session_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        entries.push(ChatEntry {
            session_id: session_id.to_string(),
            path: path.to_path_buf(),
            updated_at,
        });
    }
    entries
}

fn read_existing_qwen_sessions(db_path: &Path) -> HashMap<String, String> {
    if !db_path.exists() {
        return HashMap::new();
    }

    let Ok(connection) = Connection::open(db_path) else {
        return HashMap::new();
    };
    let Ok(mut statement) = connection.prepare(
        "
        SELECT id, COALESCE(source_updated_at, ended_at, started_at)
        FROM runtime_sessions
        WHERE source = 'qwen'
        ",
    ) else {
        return HashMap::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return HashMap::new();
    };

    let mut sessions = HashMap::new();
    for row in rows.flatten() {
        sessions.insert(row.0, row.1);
    }
    sessions
}

fn detect_qwen_last_timestamp(path: &Path) -> Option<String> {
    let lines = read_lines(path).ok()?;
    let mut last_timestamp = None;
    for line in lines {
        let Some(record) = parse_json_line(&line).and_then(|value| value.as_object().cloned())
        else {
            continue;
        };
        if let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) {
            last_timestamp = Some(common::coerce_iso_timestamp_str(Some(timestamp), None));
        }
    }
    last_timestamp
}

fn parse_qwen_chat(
    lines: &[String],
    raw_session_id: &str,
    start_index: usize,
) -> Option<(Value, Value)> {
    let session_id = format!("qwen-{raw_session_id}");
    let mut cwd = "~/.qwen".to_string();
    let mut logs = Vec::new();
    let mut spans = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Some(record) = parse_json_line(line).and_then(|value| value.as_object().cloned())
        else {
            continue;
        };
        let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) else {
            continue;
        };
        let timestamp = common::coerce_iso_timestamp_str(Some(timestamp), None);

        if let Some(next_cwd) = record.get("cwd").and_then(Value::as_str) {
            cwd = next_cwd.to_string();
        }
        if index < start_index {
            continue;
        }

        let record_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        if record_type == "user" {
            let prompt: String = record
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("parts"))
                .and_then(Value::as_array)
                .map(|parts| flatten_qwen_parts(parts))
                .unwrap_or_default();
            logs.push(common::log_record(
                &timestamp,
                "INFO",
                if prompt.is_empty() {
                    "Qwen user prompt"
                } else {
                    prompt.as_str()
                },
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "qwen-code.user_prompt"),
                    common::field("prompt", &prompt),
                    common::field("prompt_length", prompt.len()),
                ],
            ));
            continue;
        }

        if record_type == "system"
            && record
                .get("subtype")
                .and_then(Value::as_str)
                .map(|value| value == "ui_telemetry")
                .unwrap_or(false)
        {
            let ui_event = record
                .get("systemPayload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("uiEvent"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if ui_event.get("event.name").and_then(Value::as_str) != Some("qwen-code.api_response")
            {
                continue;
            }

            let event_time = common::coerce_iso_timestamp_value(
                ui_event.get("event.timestamp"),
                Some(&timestamp),
            );
            let model = ui_event
                .get("model")
                .and_then(Value::as_str)
                .or_else(|| record.get("model").and_then(Value::as_str))
                .unwrap_or("unknown");
            let duration_ms = ui_event
                .get("duration_ms")
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            let start_time = common::shift_iso_timestamp(&event_time, -duration_ms);
            let status_code = ui_event
                .get("status_code")
                .and_then(common::value_to_i64)
                .unwrap_or(0);
            let status_label = if status_code == 0 {
                "-".to_string()
            } else {
                status_code.to_string()
            };
            let body = format!("API response from {model}. Status: {status_label}.");
            logs.push(common::log_record(
                &event_time,
                if status_code < 400 { "INFO" } else { "WARN" },
                &body,
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "qwen-code.api_response"),
                    common::field("model", model),
                    common::field("duration_ms", duration_ms),
                    common::field("status_code", status_code),
                    common::field(
                        "input_token_count",
                        ui_event
                            .get("input_token_count")
                            .and_then(common::value_to_i64)
                            .unwrap_or(0),
                    ),
                    common::field(
                        "output_token_count",
                        ui_event
                            .get("output_token_count")
                            .and_then(common::value_to_i64)
                            .unwrap_or(0),
                    ),
                    common::field(
                        "cached_content_token_count",
                        ui_event
                            .get("cached_content_token_count")
                            .and_then(common::value_to_i64)
                            .unwrap_or(0),
                    ),
                    common::field(
                        "thoughts_token_count",
                        ui_event
                            .get("thoughts_token_count")
                            .and_then(common::value_to_i64)
                            .unwrap_or(0),
                    ),
                    common::field(
                        "tool_token_count",
                        ui_event
                            .get("tool_token_count")
                            .and_then(common::value_to_i64)
                            .unwrap_or(0),
                    ),
                    common::field(
                        "prompt_id",
                        ui_event
                            .get("prompt_id")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    ),
                    common::field(
                        "auth_type",
                        ui_event
                            .get("auth_type")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    ),
                ],
            ));
            spans.push(common::span_record(
                &session_id,
                "model.inference",
                &start_time,
                &event_time,
                vec![
                    common::field("session_id", &session_id),
                    common::field("model", model),
                    common::field(
                        "gen_ai.usage.input_tokens",
                        ui_event
                            .get("input_token_count")
                            .and_then(common::value_to_i64)
                            .unwrap_or(0),
                    ),
                    common::field(
                        "gen_ai.usage.output_tokens",
                        ui_event
                            .get("output_token_count")
                            .and_then(common::value_to_i64)
                            .unwrap_or(0),
                    ),
                ],
                0,
            ));
        }
    }

    if logs.is_empty() && spans.is_empty() {
        return None;
    }

    Some((
        common::build_logs_payload("qwen-code", &cwd, "qwen_runtime", logs),
        common::build_traces_payload("qwen-code", &cwd, "qwen_runtime", spans),
    ))
}

fn flatten_qwen_parts(parts: &[Value]) -> String {
    parts
        .iter()
        .filter_map(|part| part.as_object())
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn find_opencode_message_files(data_root: &Path) -> Vec<PathBuf> {
    if !data_root.exists() {
        return Vec::new();
    }

    WalkDir::new(data_root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .filter(|path| is_opencode_message_path(path))
        .collect()
}

fn parse_opencode_message_file(path: &Path) -> Option<Value> {
    let raw = common::read_json_file(path);
    let raw_object = raw.as_object()?;
    let session_id_raw = raw_object
        .get("sessionID")
        .and_then(Value::as_str)
        .or_else(|| raw_object.get("sessionId").and_then(Value::as_str))
        .or_else(|| {
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|value| value.to_str())
        })?;
    let role = raw_object
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let timestamp = common::coerce_iso_timestamp_value(
        raw_object
            .get("time")
            .and_then(Value::as_object)
            .and_then(|time| time.get("created"))
            .or_else(|| raw_object.get("timestamp"))
            .or_else(|| raw_object.get("createdAt")),
        None,
    );
    let workspace_path = infer_opencode_workspace_path(path, raw_object);
    let session_id = format!("opencode-{session_id_raw}");

    let mut logs = Vec::new();
    if role == "user" {
        let prompt = raw_object
            .get("content")
            .map(common::flatten_text)
            .filter(|text| !text.is_empty())
            .or_else(|| raw_object.get("message").map(common::flatten_text))
            .unwrap_or_default();
        logs.push(common::log_record(
            &timestamp,
            "INFO",
            if prompt.is_empty() {
                "OpenCode user prompt"
            } else {
                prompt.as_str()
            },
            vec![
                common::field("session_id", &session_id),
                common::field("event.name", "user_prompt"),
                common::field("prompt", &prompt),
                common::field("prompt_length", prompt.len()),
            ],
        ));
    } else if role == "assistant" {
        let tokens = raw_object
            .get("tokens")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let model = raw_object
            .get("modelID")
            .and_then(Value::as_str)
            .or_else(|| raw_object.get("model").and_then(Value::as_str))
            .unwrap_or("unknown");
        let provider = raw_object
            .get("providerID")
            .and_then(Value::as_str)
            .or_else(|| raw_object.get("provider").and_then(Value::as_str))
            .unwrap_or("unknown");
        let body = raw_object
            .get("content")
            .map(common::flatten_text)
            .filter(|text| !text.is_empty())
            .or_else(|| raw_object.get("message").map(common::flatten_text))
            .unwrap_or_default();
        let response_body = if body.is_empty() {
            format!("OpenCode response from {provider}/{model}")
        } else {
            body.clone()
        };
        logs.push(common::log_record(
            &timestamp,
            "INFO",
            &response_body,
            vec![
                common::field("session_id", &session_id),
                common::field("event.name", "opencode.api_response"),
                common::field("model", model),
                common::field("provider", provider),
                common::field(
                    "input_token_count",
                    tokens
                        .get("input")
                        .and_then(common::value_to_i64)
                        .unwrap_or(0),
                ),
                common::field(
                    "output_token_count",
                    tokens
                        .get("output")
                        .and_then(common::value_to_i64)
                        .unwrap_or(0),
                ),
                common::field(
                    "cached_input_tokens",
                    tokens
                        .get("cache")
                        .and_then(Value::as_object)
                        .and_then(|cache| cache.get("read"))
                        .and_then(common::value_to_i64)
                        .unwrap_or(0),
                ),
                common::field(
                    "cache_write_tokens",
                    tokens
                        .get("cache")
                        .and_then(Value::as_object)
                        .and_then(|cache| cache.get("write"))
                        .and_then(common::value_to_i64)
                        .unwrap_or(0),
                ),
                common::field(
                    "thoughts_token_count",
                    tokens
                        .get("reasoning")
                        .and_then(common::value_to_i64)
                        .unwrap_or(0),
                ),
                common::field("cost_usd", extract_opencode_cost(&tokens)),
            ],
        ));
    } else if let Some(tool_name) = raw_object
        .get("toolName")
        .and_then(Value::as_str)
        .or_else(|| raw_object.get("tool_name").and_then(Value::as_str))
        .or_else(|| raw_object.get("name").and_then(Value::as_str))
    {
        let result_body = raw_object
            .get("content")
            .map(common::flatten_text)
            .filter(|text| !text.is_empty())
            .or_else(|| raw_object.get("result").map(common::flatten_text))
            .filter(|text| !text.is_empty())
            .or_else(|| raw_object.get("message").map(common::flatten_text))
            .unwrap_or_else(|| format!("OpenCode tool call: {tool_name}"));
        let status = raw_object
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .to_lowercase();
        logs.push(common::log_record(
            &timestamp,
            if matches!(status.as_str(), "error" | "failed" | "cancelled") {
                "WARN"
            } else {
                "INFO"
            },
            &result_body,
            vec![
                common::field("session_id", &session_id),
                common::field("event.name", "opencode.tool_call"),
                common::field("tool_name", tool_name),
                common::field("status", &status),
                common::field("metadata", raw_object.get("metadata").cloned()),
            ],
        ));
    } else {
        let body = raw_object
            .get("content")
            .map(common::flatten_text)
            .filter(|text| !text.is_empty())
            .or_else(|| raw_object.get("message").map(common::flatten_text))
            .unwrap_or_default();
        if !body.is_empty() {
            logs.push(common::log_record(
                &timestamp,
                "INFO",
                &body,
                vec![
                    common::field("session_id", &session_id),
                    common::field("event.name", "runtime_log"),
                    common::field(
                        "role",
                        if role.is_empty() {
                            "unknown"
                        } else {
                            role.as_str()
                        },
                    ),
                ],
            ));
        }
    }

    if logs.is_empty() {
        return None;
    }

    Some(common::build_logs_payload(
        "opencode",
        &workspace_path,
        "opencode_runtime",
        logs,
    ))
}

fn infer_opencode_workspace_path(path: &Path, raw: &Map<String, Value>) -> String {
    for key in ["workspacePath", "projectPath", "cwd", "path"] {
        if let Some(value) = raw.get(key) {
            if let Some(text) = value.as_str() {
                if !text.is_empty() {
                    return text.to_string();
                }
            }
            if let Some(object) = value.as_object() {
                for nested_key in ["root", "cwd", "workspace"] {
                    if let Some(text) = object.get(nested_key).and_then(Value::as_str) {
                        if !text.is_empty() {
                            return text.to_string();
                        }
                    }
                }
            }
        }
    }

    let storage_dir = path
        .ancestors()
        .find(|ancestor| ancestor.file_name().and_then(|value| value.to_str()) == Some("storage"));
    if let Some(storage_dir) = storage_dir {
        if let Some(parent) = storage_dir.parent() {
            let parent_name = parent
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if !matches!(parent_name, "project" | "global" | "message") {
                return parent.to_string_lossy().to_string();
            }
        }
    }

    path.parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| path.parent().unwrap_or(path))
        .to_string_lossy()
        .to_string()
}

fn extract_opencode_cost(tokens: &Map<String, Value>) -> f64 {
    tokens
        .get("cost")
        .and_then(|cost| cost.as_object())
        .and_then(|cost| cost.get("total"))
        .and_then(common::value_to_f64)
        .unwrap_or(0.0)
}

fn payload_has_logs(payload: &Value) -> bool {
    payload
        .get("resourceLogs")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("scopeLogs"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("logRecords"))
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false)
}

fn payload_has_spans(payload: &Value) -> bool {
    payload
        .get("resourceSpans")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("scopeSpans"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("spans"))
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false)
}

fn is_opencode_message_path(path: &Path) -> bool {
    let mut ancestors = path.ancestors();
    while let Some(ancestor) = ancestors.next() {
        if ancestor.file_name().and_then(|value| value.to_str()) == Some("message") {
            return ancestor
                .parent()
                .and_then(|parent| parent.file_name())
                .and_then(|value| value.to_str())
                == Some("storage");
        }
    }
    false
}

fn infer_openclaw_workspace_path(root: &Path, session_file: &Path) -> String {
    for parent in session_file.ancestors() {
        if parent.file_name().and_then(|value| value.to_str()) == Some("sessions") {
            if let Some(workspace_root) = parent.parent() {
                return workspace_root.to_string_lossy().to_string();
            }
        }
    }
    root.to_string_lossy().to_string()
}

fn infer_claude_workspace_path(root: &Path, path: &Path) -> String {
    let Ok(relative_parent) = path.parent().unwrap_or(path).strip_prefix(root) else {
        return path.parent().unwrap_or(path).to_string_lossy().to_string();
    };

    let flattened = relative_parent
        .to_string_lossy()
        .trim_matches('/')
        .to_string();
    if flattened.is_empty() {
        return path.parent().unwrap_or(path).to_string_lossy().to_string();
    }
    if let Some(stripped) = flattened.strip_prefix('-') {
        return format!("/{}", stripped.replace('-', "/"));
    }
    path.parent().unwrap_or(path).to_string_lossy().to_string()
}

fn claude_candidate_roots() -> Vec<PathBuf> {
    let Some(home) = home_path() else {
        return Vec::new();
    };
    vec![
        home.join(".claude/projects"),
        home.join(".config/claude/projects"),
    ]
}

fn openclaw_candidate_roots() -> Vec<PathBuf> {
    let Some(home) = home_path() else {
        return Vec::new();
    };
    vec![
        home.join(".openclaw"),
        home.join(".clawdbot"),
        home.join(".moltbot"),
        home.join(".moldbot"),
    ]
}

fn home_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn mtime_ns_to_iso(value: i128) -> String {
    let seconds = value as f64 / 1_000_000_000.0;
    common::unix_seconds_to_iso(seconds)
}

fn parse_json_line(line: &str) -> Option<Value> {
    serde_json::from_str::<Value>(line).ok()
}

fn read_lines(path: &Path) -> Result<Vec<String>, String> {
    fs::read_to_string(path)
        .map(|content| content.lines().map(str::to_string).collect())
        .map_err(|error| format!("failed to read {}: {error}", path.display()))
}
