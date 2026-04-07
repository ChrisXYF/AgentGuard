use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_shell::{
    process::{Command as ShellCommand, CommandChild, CommandEvent, TerminatedPayload},
    ShellExt,
};

use crate::runtime_activity::{
    RuntimeEventRecord, RuntimeSecurityAlertRecord, RuntimeSessionRecord,
};

pub const DEFAULT_GUARD_HOST: &str = "127.0.0.1";
pub const DESKTOP_GUARD_PORT: u16 = 47358;
pub const DESKTOP_GUARD_DB_NAME: &str = "runtime-guard.sqlite3";
const DESKTOP_GUARD_SIDECAR_NAME: &str = "agentguard";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeGuardApiStatus {
    pub running: bool,
    pub bind_address: String,
    pub db_path: String,
    pub started_at: String,
    pub total_sessions: i64,
    pub total_alerts: i64,
    pub total_blocked: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeGuardDesktopStatus {
    pub reachable: bool,
    pub managed_by_desktop: bool,
    pub pending_action: Option<String>,
    pub base_url: String,
    pub bind_address: String,
    pub db_path: Option<String>,
    pub started_at: Option<String>,
    pub total_sessions: i64,
    pub total_alerts: i64,
    pub total_blocked: i64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeGuardInterventionRequest {
    pub source: String,
    pub session_id: String,
    pub workspace_path: String,
    pub details_json: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeGuardInterventionResult {
    pub supported: bool,
    pub attempted: bool,
    pub success: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeGuardExceptionRequest {
    pub scope: String,
    pub source: String,
    pub session_id: String,
    pub alert_type: String,
    pub resource: String,
    pub details_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeGuardExceptionRecord {
    pub id: i64,
    pub scope: String,
    pub source: String,
    pub session_id: Option<String>,
    pub policy_id: String,
    pub resource: Option<String>,
    pub tool_name: Option<String>,
    pub reason: String,
    pub created_at: String,
    pub remaining_matches: Option<i64>,
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("failed to build runtime guard client: {error}"))
}

pub fn base_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}")
}

pub fn bind_address(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

pub fn query_status(base_url: &str) -> Result<RuntimeGuardApiStatus, String> {
    http_client()?
        .get(format!("{base_url}/v1/status"))
        .send()
        .map_err(|error| format!("failed to query runtime guard status: {error}"))?
        .error_for_status()
        .map_err(|error| format!("runtime guard status request failed: {error}"))?
        .json::<RuntimeGuardApiStatus>()
        .map_err(|error| format!("failed to decode runtime guard status: {error}"))
}

pub fn stop(base_url: &str) -> Result<(), String> {
    http_client()?
        .post(format!("{base_url}/v1/shutdown"))
        .send()
        .map_err(|error| format!("failed to stop runtime guard: {error}"))?
        .error_for_status()
        .map_err(|error| format!("runtime guard shutdown request failed: {error}"))?;
    Ok(())
}

pub fn list_alerts(
    base_url: &str,
    limit: usize,
) -> Result<Vec<RuntimeSecurityAlertRecord>, String> {
    http_client()?
        .get(format!("{base_url}/v1/runtime/alerts?limit={limit}"))
        .send()
        .map_err(|error| format!("failed to fetch runtime guard alerts: {error}"))?
        .error_for_status()
        .map_err(|error| format!("runtime guard alerts request failed: {error}"))?
        .json::<Vec<RuntimeSecurityAlertRecord>>()
        .map_err(|error| format!("failed to decode runtime guard alerts: {error}"))
}

pub fn list_blocked(
    base_url: &str,
    limit: usize,
) -> Result<Vec<RuntimeSecurityAlertRecord>, String> {
    http_client()?
        .get(format!("{base_url}/v1/runtime/blocked?limit={limit}"))
        .send()
        .map_err(|error| format!("failed to fetch runtime guard blocked events: {error}"))?
        .error_for_status()
        .map_err(|error| format!("runtime guard blocked request failed: {error}"))?
        .json::<Vec<RuntimeSecurityAlertRecord>>()
        .map_err(|error| format!("failed to decode runtime guard blocked events: {error}"))
}

pub fn list_sessions(base_url: &str, limit: usize) -> Result<Vec<RuntimeSessionRecord>, String> {
    http_client()?
        .get(format!("{base_url}/v1/runtime/sessions?limit={limit}"))
        .send()
        .map_err(|error| format!("failed to fetch runtime guard sessions: {error}"))?
        .error_for_status()
        .map_err(|error| format!("runtime guard sessions request failed: {error}"))?
        .json::<Vec<RuntimeSessionRecord>>()
        .map_err(|error| format!("failed to decode runtime guard sessions: {error}"))
}

pub fn list_session_events(
    base_url: &str,
    session_id: &str,
) -> Result<Vec<RuntimeEventRecord>, String> {
    http_client()?
        .get(format!(
            "{base_url}/v1/runtime/sessions/{session_id}/events"
        ))
        .send()
        .map_err(|error| format!("failed to fetch runtime guard session events: {error}"))?
        .error_for_status()
        .map_err(|error| format!("runtime guard session events request failed: {error}"))?
        .json::<Vec<RuntimeEventRecord>>()
        .map_err(|error| format!("failed to decode runtime guard session events: {error}"))
}

pub fn create_exception(
    base_url: &str,
    request: &RuntimeGuardExceptionRequest,
) -> Result<RuntimeGuardExceptionRecord, String> {
    let tool_name = parse_alert_details(&request.details_json)
        .and_then(|details| details.get("extra").cloned())
        .and_then(|extra| extra.get("tool_name").cloned())
        .and_then(|value| value.as_str().map(str::trim).map(ToOwned::to_owned))
        .filter(|value| !value.is_empty());
    let session_id = if request.scope == "session_once" {
        Some(request.session_id.trim().to_string())
    } else {
        None
    };
    let reason = if request.scope == "session_once" {
        "Desktop one-time allow for the current session".to_string()
    } else {
        "Desktop persistent exception rule".to_string()
    };

    let body = serde_json::json!({
        "scope": request.scope,
        "source": request.source,
        "sessionId": session_id,
        "policyId": request.alert_type,
        "resource": if request.resource.trim().is_empty() { None::<String> } else { Some(request.resource.trim().to_string()) },
        "toolName": tool_name,
        "reason": reason,
    });

    http_client()?
        .post(format!("{base_url}/v1/runtime/exceptions"))
        .json(&body)
        .send()
        .map_err(|error| format!("failed to create runtime guard exception: {error}"))?
        .error_for_status()
        .map_err(|error| format!("runtime guard exception request failed: {error}"))?
        .json::<RuntimeGuardExceptionRecord>()
        .map_err(|error| format!("failed to decode runtime guard exception: {error}"))
}

pub fn build_status(
    base_url: &str,
    bind_address: &str,
    managed_by_desktop: bool,
    status: Result<RuntimeGuardApiStatus, String>,
    pending_action: Option<String>,
    error_override: Option<String>,
) -> RuntimeGuardDesktopStatus {
    match status {
        Ok(status) => RuntimeGuardDesktopStatus {
            reachable: true,
            managed_by_desktop,
            pending_action,
            base_url: base_url.to_string(),
            bind_address: status.bind_address,
            db_path: Some(status.db_path),
            started_at: Some(status.started_at),
            total_sessions: status.total_sessions,
            total_alerts: status.total_alerts,
            total_blocked: status.total_blocked,
            error: None,
        },
        Err(error) => RuntimeGuardDesktopStatus {
            reachable: false,
            managed_by_desktop,
            pending_action: pending_action.clone(),
            base_url: base_url.to_string(),
            bind_address: bind_address.to_string(),
            db_path: None,
            started_at: None,
            total_sessions: 0,
            total_alerts: 0,
            total_blocked: 0,
            error: if pending_action.is_some() {
                error_override
            } else {
                error_override.or(Some(error))
            },
        },
    }
}

pub fn spawn_process(
    app: &AppHandle,
    control: &Arc<Mutex<crate::RuntimeGuardProcessControl>>,
    cli_repo_root: Option<&Path>,
    host: &str,
    port: u16,
    database_path: &Path,
) -> Result<CommandChild, String> {
    match spawn_bundled_sidecar(app, control, host, port, database_path) {
        Ok(child) => Ok(child),
        Err(sidecar_error) => {
            if let Some(cli_repo_root) = cli_repo_root {
                let manifest_path = cli_repo_root.join("Cargo.toml");
                if manifest_path.exists() {
                    return spawn_local_cli(
                        app,
                        control,
                        cli_repo_root,
                        &manifest_path,
                        host,
                        port,
                        database_path,
                    )
                    .map_err(|fallback_error| {
                        format!(
                            "failed to start bundled desktop Guard sidecar ({sidecar_error}); development fallback via sibling `agentguard-cli` also failed: {fallback_error}"
                        )
                    });
                }
            }

            Err(format!(
                "failed to start bundled desktop Guard sidecar ({sidecar_error}); no local sibling `agentguard-cli` checkout was found for development fallback"
            ))
        }
    }
}

fn spawn_bundled_sidecar(
    app: &AppHandle,
    control: &Arc<Mutex<crate::RuntimeGuardProcessControl>>,
    host: &str,
    port: u16,
    database_path: &Path,
) -> Result<CommandChild, String> {
    let command = app
        .shell()
        .sidecar(DESKTOP_GUARD_SIDECAR_NAME)
        .map_err(|error| {
            format!(
                "failed to resolve bundled runtime guard sidecar `{DESKTOP_GUARD_SIDECAR_NAME}`: {error}"
            )
        })?
        .args(["serve", "--host", host, "--port"])
        .arg(port.to_string())
        .args(["--database"])
        .arg(database_path);

    spawn_managed_command(command, control, "bundled desktop Guard sidecar")
}

fn spawn_local_cli(
    app: &AppHandle,
    control: &Arc<Mutex<crate::RuntimeGuardProcessControl>>,
    cli_repo_root: &Path,
    manifest_path: &Path,
    host: &str,
    port: u16,
    database_path: &Path,
) -> Result<CommandChild, String> {
    let command = configure_shell_command(app.shell().command("cargo"))
        .current_dir(cli_repo_root)
        .args(["run", "--manifest-path"])
        .arg(manifest_path)
        .args(["--", "serve", "--host", host, "--port"])
        .arg(port.to_string())
        .args(["--database"])
        .arg(database_path);

    spawn_managed_command(
        command,
        control,
        "desktop development fallback from sibling `agentguard-cli`",
    )
}

fn configure_shell_command(command: ShellCommand) -> ShellCommand {
    if let Some(path) = crate::augmented_cli_path_value() {
        command.env("PATH", path)
    } else {
        command
    }
}

fn spawn_managed_command(
    command: ShellCommand,
    control: &Arc<Mutex<crate::RuntimeGuardProcessControl>>,
    source_label: &str,
) -> Result<CommandChild, String> {
    let (mut events, child) = command.spawn().map_err(|error| {
        format!("failed to start runtime guard process via {source_label}: {error}")
    })?;
    let pid = child.pid();
    let control_ref = Arc::clone(control);
    let source_label = source_label.to_string();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if let CommandEvent::Terminated(payload) = event {
                handle_termination_event(&control_ref, pid, &source_label, payload);
                break;
            }
        }
    });

    Ok(child)
}

fn handle_termination_event(
    control: &Arc<Mutex<crate::RuntimeGuardProcessControl>>,
    pid: u32,
    source_label: &str,
    payload: TerminatedPayload,
) {
    let mut state = match control.lock() {
        Ok(state) => state,
        Err(_) => return,
    };

    let Some(active_child) = state.child.as_ref() else {
        return;
    };
    if active_child.pid() != pid {
        return;
    }

    state.child = None;
    let detail = terminated_process_detail(source_label, &payload);
    if state.pending_action == Some(crate::RuntimeGuardPendingAction::Starting) {
        state.pending_action = None;
        state.last_error = Some(detail);
    } else if state.last_error.is_none() {
        state.last_error = Some(detail);
    }
}

fn terminated_process_detail(source_label: &str, payload: &TerminatedPayload) -> String {
    match (payload.code, payload.signal) {
        (Some(code), Some(signal)) => format!(
            "runtime guard managed by {source_label} exited before becoming ready (code: {code}, signal: {signal})"
        ),
        (Some(code), None) => format!(
            "runtime guard managed by {source_label} exited before becoming ready (code: {code})"
        ),
        (None, Some(signal)) => format!(
            "runtime guard managed by {source_label} exited before becoming ready (signal: {signal})"
        ),
        (None, None) => {
            format!("runtime guard managed by {source_label} exited before becoming ready")
        }
    }
}

pub fn cli_repo_root(workspace_root: &Path) -> Option<PathBuf> {
    let candidate = workspace_root.join("agentguard-cli");
    candidate.join("Cargo.toml").exists().then_some(candidate)
}

pub fn attempt_intervention(
    request: &RuntimeGuardInterventionRequest,
) -> RuntimeGuardInterventionResult {
    let session_hint = request.session_id.trim();
    if request.source != "codex" {
        return RuntimeGuardInterventionResult {
            supported: false,
            attempted: false,
            success: false,
            detail: "当前仅支持对 Codex 运行时会话做人工中断。".to_string(),
        };
    }

    let Some(details) = parse_alert_details(&request.details_json) else {
        return RuntimeGuardInterventionResult {
            supported: false,
            attempted: false,
            success: false,
            detail: "无法解析拦截事件详情，不能定位可中断的命令。".to_string(),
        };
    };

    let Some(extra) = details.get("extra") else {
        return RuntimeGuardInterventionResult {
            supported: false,
            attempted: false,
            success: false,
            detail: "该拦截事件不包含可中断的工具调用上下文。".to_string(),
        };
    };

    let Some(tool_name) = extra
        .get("tool_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return RuntimeGuardInterventionResult {
            supported: false,
            attempted: false,
            success: false,
            detail: "当前只支持对工具调用拦截事件执行人工中断。".to_string(),
        };
    };

    if !matches!(tool_name, "exec" | "exec_command" | "shell_command") {
        return RuntimeGuardInterventionResult {
            supported: false,
            attempted: false,
            success: false,
            detail: format!("工具 `{tool_name}` 当前还不支持人工中断。"),
        };
    }

    let command_text = command_candidate_from_params(extra.get("params"));
    let Some(command_text) = command_text else {
        return RuntimeGuardInterventionResult {
            supported: false,
            attempted: false,
            success: false,
            detail: "没有找到可用于匹配进程的命令文本，无法安全中断。".to_string(),
        };
    };

    match attempt_codex_soft_stop(tool_name, &request.workspace_path, &command_text) {
        Ok((success, detail)) => RuntimeGuardInterventionResult {
            supported: true,
            attempted: true,
            success,
            detail: if session_hint.is_empty() {
                detail
            } else {
                format!("会话 {}: {}", session_hint, detail)
            },
        },
        Err(detail) => RuntimeGuardInterventionResult {
            supported: true,
            attempted: true,
            success: false,
            detail: if session_hint.is_empty() {
                detail
            } else {
                format!("会话 {}: {}", session_hint, detail)
            },
        },
    }
}

fn parse_alert_details(details_json: &str) -> Option<Value> {
    serde_json::from_str::<Value>(details_json)
        .ok()
        .filter(|value| value.is_object())
}

fn command_candidate_from_params(params: Option<&Value>) -> Option<String> {
    let params = params?;
    if let Some(text) = params
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_string());
    }

    let object = params.as_object()?;
    for key in ["command", "cmd", "raw_arguments", "arguments"] {
        if let Some(value) = object
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }

    None
}

fn attempt_codex_soft_stop(
    tool_name: &str,
    workspace_path: &str,
    command_text: &str,
) -> Result<(bool, String), String> {
    if !matches!(tool_name, "exec" | "exec_command" | "shell_command") {
        return Ok((false, "当前仅支持 shell / exec 类工具中断。".to_string()));
    }

    let process_ids = matching_process_ids(command_text, workspace_path)?;
    if process_ids.is_empty() {
        return Ok((false, "没有找到仍在运行的危险进程。".to_string()));
    }

    let mut stopped = Vec::new();
    for pid in process_ids {
        let status = Command::new("kill")
            .arg("-INT")
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("failed to send SIGINT: {error}"))?;
        if status.success() {
            stopped.push(pid);
        }
    }

    if stopped.is_empty() {
        return Ok((false, "向匹配进程发送中断信号失败。".to_string()));
    }

    Ok((
        true,
        format!(
            "已向 {} 个匹配进程发送 SIGINT：{}",
            stopped.len(),
            stopped
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ))
}

fn matching_process_ids(command_text: &str, workspace_path: &str) -> Result<Vec<i32>, String> {
    let normalized = command_text.trim();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    let output = Command::new("ps")
        .arg("-Ao")
        .arg("pid=,ppid=,command=")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| format!("failed to inspect process table: {error}"))?;
    if !output.status.success() {
        return Err("failed to inspect process table.".to_string());
    }

    let full_snippet = normalized
        .chars()
        .take(96)
        .collect::<String>()
        .to_lowercase();
    let workspace = workspace_path.to_lowercase();
    let required_tokens = normalized
        .split_whitespace()
        .filter(|token| token.len() >= 3 && !token.starts_with('-'))
        .take(2)
        .map(|token| token.to_lowercase())
        .collect::<Vec<_>>();

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

        if !workspace.is_empty()
            && lower_command.contains(&workspace)
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

    Ok(matched)
}
