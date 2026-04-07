use std::collections::hash_map::DefaultHasher;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use discovery_engine::{
    artifact::build_scan_artifact, normalize_included_extensions, DiscoveryEngine,
    DiscoverySnapshot, EngineConfig, ScanArtifact, ScanResponse,
};
use tauri::utils::config::Color;
use tauri::{command, Emitter, Manager, Theme, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tiny_http::{Header, Method, Response, Server, StatusCode};

mod desktop_shell;
mod local_mcp_discovery;
mod otlp_bridge;
mod repository_audit;
mod runtime_activity;
mod runtime_adapter_common;
mod runtime_adapters;
mod runtime_guard;
mod skill_library_sync;
mod skill_manager;

#[derive(Clone)]
struct DesktopRuntimeSessionMeta {
    id: String,
    started_at: String,
}

struct RuntimeAppState {
    database_path: PathBuf,
    session: Mutex<Option<DesktopRuntimeSessionMeta>>,
    bridge: RuntimeBridgeState,
    guard: RuntimeGuardProcessState,
    codex_guard_adapter: Arc<Mutex<CodexGuardAdapterStatus>>,
    codex_guard_soft_stop_enabled: Arc<AtomicBool>,
    scan_control: Arc<ScanControlState>,
    repository_scan: repository_audit::RepositoryScanState,
}

#[derive(Clone)]
struct RuntimeBridgeState {
    health_url: String,
    running: bool,
}

struct RuntimeGuardProcessState {
    host: String,
    port: u16,
    base_url: String,
    bind_address: String,
    database_path: PathBuf,
    cli_repo_root: Option<PathBuf>,
    control: Arc<Mutex<RuntimeGuardProcessControl>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeGuardPendingAction {
    Starting,
}

#[derive(Default)]
struct RuntimeGuardProcessControl {
    child: Option<CommandChild>,
    pending_action: Option<RuntimeGuardPendingAction>,
    last_error: Option<String>,
}

#[derive(Clone, Copy)]
struct RuntimeGuardProcessSnapshot {
    managed_by_desktop: bool,
    pending_action: Option<RuntimeGuardPendingAction>,
}

impl RuntimeGuardPendingAction {
    fn status_value(self) -> &'static str {
        match self {
            Self::Starting => "starting",
        }
    }
}

struct ScanControlState {
    running: AtomicBool,
    cancel_requested: AtomicBool,
}

#[derive(Clone, serde::Serialize)]
struct CodexGuardAdapterStatus {
    detected: bool,
    support_level: String,
    status: String,
    experimental_soft_stop_enabled: bool,
    codex_home: Option<String>,
    state_file: Option<String>,
    session_index_present: bool,
    guard_reachable: bool,
    processed_events_total: u64,
    processed_events_last_run: u64,
    blocked_events_total: u64,
    blocked_events_last_run: u64,
    prompt_events_total: u64,
    tool_call_events_total: u64,
    output_events_total: u64,
    soft_stop_attempts_total: u64,
    soft_stop_attempts_last_run: u64,
    soft_stop_success_total: u64,
    soft_stop_success_last_run: u64,
    last_checked_at: Option<String>,
    last_synced_at: Option<String>,
    last_blocked_event_at: Option<String>,
    last_soft_stop_at: Option<String>,
    last_soft_stop_result: Option<String>,
    last_error: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct RuntimeHostStatus {
    key: String,
    label: String,
    capability_level: String,
    status: String,
    detected: bool,
    last_activity_at: Option<String>,
    detail: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct CodexGuardMetricsState {
    processed_events_total: Option<u64>,
    processed_events_last_run: Option<u64>,
    blocked_events_total: Option<u64>,
    blocked_events_last_run: Option<u64>,
    prompt_events_total: Option<u64>,
    tool_call_events_total: Option<u64>,
    output_events_total: Option<u64>,
    soft_stop_enabled: Option<bool>,
    soft_stop_attempts_total: Option<u64>,
    soft_stop_attempts_last_run: Option<u64>,
    soft_stop_success_total: Option<u64>,
    soft_stop_success_last_run: Option<u64>,
    last_run_at: Option<String>,
    last_blocked_event_at: Option<String>,
    last_soft_stop_at: Option<String>,
    last_soft_stop_result: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct CodexGuardStateFile {
    metrics: Option<CodexGuardMetricsState>,
}

#[derive(Clone, serde::Serialize)]
struct RuntimeBridgeConfig {
    health_url: String,
    running: bool,
    otlp_logs_endpoint: String,
    otlp_traces_endpoint: String,
    otlp_metrics_endpoint: String,
}

#[derive(Clone, serde::Serialize)]
struct FullScanBundle {
    run_id: String,
    local_report: ScanResponse,
    full_artifact: ScanArtifact,
    skill_refs: Vec<skill_library_sync::SkillFingerprintRef>,
}

const EXCLUDED_TRANSIENT_SCAN_DIRS: &[&str] = &[".tmp"];

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanOptionsInput {
    recursive_scan: Option<bool>,
    included_extensions: Option<Vec<String>>,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

fn workspace_root() -> PathBuf {
    repo_root()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(repo_root)
}

fn repo_asset_path(relative: &str) -> PathBuf {
    repo_root().join(relative)
}

fn bundled_asset_path(app: &tauri::AppHandle, relative: &str) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|dir| dir.join(relative))
}

fn ensure_app_local_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve app local data dir: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create app local data dir: {error}"))?;
    Ok(dir)
}

fn resolve_runtime_database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let target_path = ensure_app_local_data_dir(app)?.join("threats.db");
    if target_path.exists() {
        return Ok(target_path);
    }

    // Preserve existing local data from older builds before falling back to an empty app-local DB.
    let legacy_sources = [
        bundled_asset_path(app, "data/threats.db"),
        Some(repo_asset_path("data/threats.db")),
    ];

    if let Some(source_path) = legacy_sources
        .into_iter()
        .flatten()
        .find(|path| path.exists())
    {
        fs::copy(&source_path, &target_path).map_err(|error| {
            format!(
                "failed to migrate runtime database from {} to {}: {error}",
                source_path.display(),
                target_path.display()
            )
        })?;
    }

    Ok(target_path)
}

fn resolve_runtime_guard_database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_app_local_data_dir(app)?.join(runtime_guard::DESKTOP_GUARD_DB_NAME))
}

fn apply_scan_options(config: &mut EngineConfig, scan_options: Option<&ScanOptionsInput>) {
    let Some(scan_options) = scan_options else {
        return;
    };

    if let Some(recursive_scan) = scan_options.recursive_scan {
        config.recursive_scan = recursive_scan;
    }
    if let Some(included_extensions) = scan_options.included_extensions.as_ref() {
        config.included_extensions = normalize_included_extensions(included_extensions);
    }
}

fn build_engine(
    db_path: &Path,
    scan_options: Option<&ScanOptionsInput>,
) -> Result<DiscoveryEngine, String> {
    let mut config = EngineConfig::with_defaults(db_path.to_path_buf());
    apply_scan_options(&mut config, scan_options);

    DiscoveryEngine::new(config).map_err(|error| error.to_string())
}

fn expand_home_path(path: &str) -> PathBuf {
    if path == "~" {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(path));
    }

    if let Some(stripped) = path.strip_prefix("~/") {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(stripped))
            .unwrap_or_else(|| PathBuf::from(path));
    }

    PathBuf::from(path)
}

fn build_engine_for_skill_roots(
    db_path: &Path,
    skill_roots: &[String],
    scan_options: Option<&ScanOptionsInput>,
) -> Result<DiscoveryEngine, String> {
    let mut config = EngineConfig::with_defaults(db_path.to_path_buf());
    if !skill_roots.is_empty() {
        config.skill_roots = skill_roots
            .iter()
            .map(|path| expand_home_path(path))
            .collect();
    }
    apply_scan_options(&mut config, scan_options);

    DiscoveryEngine::new(config).map_err(|error| error.to_string())
}

fn path_is_under_transient_scan_dir(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => value
            .to_str()
            .map(|segment| EXCLUDED_TRANSIENT_SCAN_DIRS.contains(&segment))
            .unwrap_or(false),
        _ => false,
    })
}

fn prune_transient_components_from_snapshot(mut snapshot: DiscoverySnapshot) -> DiscoverySnapshot {
    snapshot
        .components
        .retain(|component| !path_is_under_transient_scan_dir(Path::new(&component.path)));
    snapshot
}

fn count_report_findings(files: &[discovery_engine::FileReport]) -> usize {
    files.iter().map(|file| file.findings.len()).sum()
}

fn prune_transient_components_from_response(
    mut response: ScanResponse,
    snapshot: &DiscoverySnapshot,
) -> ScanResponse {
    response
        .results
        .retain(|report| !path_is_under_transient_scan_dir(Path::new(&report.path)));
    response
        .mcp_results
        .retain(|report| !path_is_under_transient_scan_dir(Path::new(&report.path)));
    response
        .agent_results
        .retain(|report| !path_is_under_transient_scan_dir(Path::new(&report.path)));

    let skill_findings = response
        .results
        .iter()
        .map(|report| count_report_findings(&report.files))
        .sum();
    let mcp_findings = response
        .mcp_results
        .iter()
        .map(|report| count_report_findings(&report.files))
        .sum();
    let agent_findings = response
        .agent_results
        .iter()
        .map(|report| count_report_findings(&report.files))
        .sum();

    response.summary.scanned_skills = response.results.len();
    response.summary.scanned_mcps = response.mcp_results.len();
    response.summary.scanned_agents = response.agent_results.len();
    response.summary.scanned_components = snapshot.components.len();
    response.summary.skill_findings = skill_findings;
    response.summary.mcp_findings = mcp_findings;
    response.summary.agent_findings = agent_findings;
    response.summary.findings = skill_findings + mcp_findings + agent_findings;
    response
}

const SCAN_CANCELLED_MESSAGE: &str = "SCAN_CANCELLED";

fn start_scan(control: &ScanControlState) -> Result<(), String> {
    if control.running.swap(true, Ordering::SeqCst) {
        return Err("Scan already in progress".to_string());
    }
    control.cancel_requested.store(false, Ordering::SeqCst);
    Ok(())
}

fn finish_scan(control: &ScanControlState) {
    control.cancel_requested.store(false, Ordering::SeqCst);
    control.running.store(false, Ordering::SeqCst);
}

fn current_timestamp() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| error.to_string())
}

fn should_surface_runtime_risk_alert(
    alert: &runtime_activity::RuntimeSecurityAlertRecord,
    cutoff: Option<OffsetDateTime>,
) -> bool {
    let Some(cutoff) = cutoff else {
        return true;
    };

    match OffsetDateTime::parse(alert.event_time.as_str(), &Rfc3339) {
        Ok(event_time) => event_time >= cutoff,
        Err(_) => true,
    }
}

fn default_codex_guard_adapter_status() -> CodexGuardAdapterStatus {
    CodexGuardAdapterStatus {
        detected: false,
        support_level: "soft_enforcement".to_string(),
        status: "unavailable".to_string(),
        experimental_soft_stop_enabled: false,
        codex_home: codex_home_path().map(|path| path.display().to_string()),
        state_file: None,
        session_index_present: false,
        guard_reachable: false,
        processed_events_total: 0,
        processed_events_last_run: 0,
        blocked_events_total: 0,
        blocked_events_last_run: 0,
        prompt_events_total: 0,
        tool_call_events_total: 0,
        output_events_total: 0,
        soft_stop_attempts_total: 0,
        soft_stop_attempts_last_run: 0,
        soft_stop_success_total: 0,
        soft_stop_success_last_run: 0,
        last_checked_at: None,
        last_synced_at: None,
        last_blocked_event_at: None,
        last_soft_stop_at: None,
        last_soft_stop_result: None,
        last_error: None,
    }
}

fn update_codex_guard_adapter_status(
    state: &Arc<Mutex<CodexGuardAdapterStatus>>,
    updater: impl FnOnce(&mut CodexGuardAdapterStatus),
) {
    if let Ok(mut status) = state.lock() {
        updater(&mut status);
    }
}

fn sync_codex_guard_adapter_metrics_from_state_file(
    state: &Arc<Mutex<CodexGuardAdapterStatus>>,
    state_file: &Path,
) {
    let parsed = fs::read_to_string(state_file)
        .ok()
        .and_then(|raw| serde_json::from_str::<CodexGuardStateFile>(&raw).ok());

    let Some(metrics) = parsed.and_then(|file| file.metrics) else {
        return;
    };

    update_codex_guard_adapter_status(state, |status| {
        if let Some(value) = metrics.processed_events_total {
            status.processed_events_total = value;
        }
        if let Some(value) = metrics.processed_events_last_run {
            status.processed_events_last_run = value;
        }
        if let Some(value) = metrics.blocked_events_total {
            status.blocked_events_total = value;
        }
        if let Some(value) = metrics.blocked_events_last_run {
            status.blocked_events_last_run = value;
        }
        if let Some(value) = metrics.prompt_events_total {
            status.prompt_events_total = value;
        }
        if let Some(value) = metrics.tool_call_events_total {
            status.tool_call_events_total = value;
        }
        if let Some(value) = metrics.output_events_total {
            status.output_events_total = value;
        }
        if let Some(value) = metrics.soft_stop_enabled {
            status.experimental_soft_stop_enabled = value;
        }
        if let Some(value) = metrics.soft_stop_attempts_total {
            status.soft_stop_attempts_total = value;
        }
        if let Some(value) = metrics.soft_stop_attempts_last_run {
            status.soft_stop_attempts_last_run = value;
        }
        if let Some(value) = metrics.soft_stop_success_total {
            status.soft_stop_success_total = value;
        }
        if let Some(value) = metrics.soft_stop_success_last_run {
            status.soft_stop_success_last_run = value;
        }
        if let Some(value) = metrics.last_run_at {
            status.last_synced_at = Some(value);
        }
        if let Some(value) = metrics.last_blocked_event_at {
            status.last_blocked_event_at = Some(value);
        }
        if let Some(value) = metrics.last_soft_stop_at {
            status.last_soft_stop_at = Some(value);
        }
        if let Some(value) = metrics.last_soft_stop_result {
            status.last_soft_stop_result = Some(value);
        }
    });
}

fn host_detected(path: Option<PathBuf>) -> bool {
    path.is_some_and(|path| path.exists())
}

fn observed_host_status(
    key: &str,
    label: &str,
    detected: bool,
    bridge_running: bool,
) -> RuntimeHostStatus {
    let status = if detected && bridge_running {
        "observed"
    } else if detected {
        "waiting_for_bridge"
    } else {
        "unavailable"
    };

    RuntimeHostStatus {
        key: key.to_string(),
        label: label.to_string(),
        capability_level: "observed".to_string(),
        status: status.to_string(),
        detected,
        last_activity_at: None,
        detail: if detected {
            Some("OTLP telemetry only".to_string())
        } else {
            None
        },
    }
}

fn runtime_bridge_port() -> u16 {
    46357
}

fn runtime_bridge_health_url() -> String {
    format!("http://127.0.0.1:{}/health", runtime_bridge_port())
}

fn runtime_bridge_otlp_logs_endpoint() -> String {
    format!("http://127.0.0.1:{}/v1/logs", runtime_bridge_port())
}

fn runtime_bridge_otlp_traces_endpoint() -> String {
    format!("http://127.0.0.1:{}/v1/traces", runtime_bridge_port())
}

fn runtime_bridge_otlp_metrics_endpoint() -> String {
    format!("http://127.0.0.1:{}/v1/metrics", runtime_bridge_port())
}

fn cleanup_runtime_activity_db(db_path: &Path) {
    match runtime_activity::cleanup_duplicate_codex_sessions(db_path) {
        Ok((deleted_sessions, deleted_events)) => {
            if deleted_sessions > 0 || deleted_events > 0 {
                eprintln!(
                    "cleaned duplicate codex runtime data: {deleted_sessions} sessions, {deleted_events} events"
                );
            }
        }
        Err(error) => {
            eprintln!("failed to clean runtime activity db: {error}");
        }
    }
}

fn home_path() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn tool_home_path(relative: &str) -> Option<PathBuf> {
    home_path().map(|home| home.join(relative))
}

fn codex_home_path() -> Option<PathBuf> {
    tool_home_path(".codex")
}

fn gemini_home_path() -> Option<PathBuf> {
    tool_home_path(".gemini")
}

fn qwen_home_path() -> Option<PathBuf> {
    tool_home_path(".qwen")
}

fn xdg_data_home_path() -> Option<PathBuf> {
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| home_path().map(|home| home.join(".local/share")))
}

fn opencode_data_path() -> Option<PathBuf> {
    env::var_os("OPENCODE_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| xdg_data_home_path().map(|path| path.join("opencode")))
}

fn push_unique_path(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !paths.iter().any(|existing| existing == &candidate) {
        paths.push(candidate);
    }
}

fn append_existing_cli_dir(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if candidate.is_dir() {
        push_unique_path(paths, candidate);
    }
}

fn augmented_cli_path_entries() -> Vec<PathBuf> {
    let mut paths = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();

    for candidate in [
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/Library/Frameworks/Python.framework/Versions/Current/bin"),
    ] {
        append_existing_cli_dir(&mut paths, candidate);
    }

    if let Some(home) = home_path() {
        for candidate in [
            home.join(".cargo/bin"),
            home.join(".local/bin"),
            home.join(".pyenv/shims"),
            home.join(".asdf/shims"),
            home.join("miniforge3/bin"),
            home.join("mambaforge/bin"),
            home.join("anaconda3/bin"),
            home.join("opt/anaconda3/bin"),
        ] {
            append_existing_cli_dir(&mut paths, candidate);
        }
    }

    paths
}

pub(crate) fn augmented_cli_path_value() -> Option<OsString> {
    env::join_paths(augmented_cli_path_entries()).ok()
}

pub(crate) fn configure_cli_command(command: &mut Command) {
    if let Some(path) = augmented_cli_path_value() {
        command.env("PATH", path);
    }
}

fn claude_projects_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home_path() {
        roots.push(home.join(".claude/projects"));
        roots.push(home.join(".config/claude/projects"));
    }
    roots
}

fn openclaw_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home_path() {
        roots.push(home.join(".openclaw"));
        roots.push(home.join(".clawdbot"));
        roots.push(home.join(".moltbot"));
        roots.push(home.join(".moldbot"));
    }
    roots
}

fn adapter_state_path(app: &tauri::AppHandle, state_name: &str) -> Result<PathBuf, String> {
    Ok(ensure_app_local_data_dir(app)?.join(state_name))
}

fn start_codex_session_sync(app: &tauri::AppHandle) {
    let Some(codex_home) = codex_home_path() else {
        return;
    };
    if !codex_home.join("session_index.jsonl").exists() {
        return;
    }

    let state_file = match adapter_state_path(app, "codex_otlp_state.json") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("failed to resolve codex adapter state file: {error}");
            return;
        }
    };
    let logs_endpoint = runtime_bridge_otlp_logs_endpoint();
    let traces_endpoint = runtime_bridge_otlp_traces_endpoint();

    thread::spawn(move || {
        let client = match runtime_adapter_common::new_http_client() {
            Ok(client) => client,
            Err(error) => {
                eprintln!("failed to initialize codex runtime sync client: {error}");
                return;
            }
        };
        loop {
            if let Err(error) = runtime_adapters::sync_codex_otlp_once(
                &client,
                &codex_home,
                &state_file,
                &logs_endpoint,
                &traces_endpoint,
            ) {
                eprintln!("codex runtime sync failed: {error}");
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn start_codex_guard_sync(
    app: &tauri::AppHandle,
    guard_base_url: &str,
    adapter_status: Arc<Mutex<CodexGuardAdapterStatus>>,
    soft_stop_enabled: Arc<AtomicBool>,
) {
    let Some(codex_home) = codex_home_path() else {
        update_codex_guard_adapter_status(&adapter_status, |status| {
            status.detected = false;
            status.status = "unavailable".to_string();
            status.last_error = Some("Codex home directory not found.".to_string());
            status.last_checked_at = current_timestamp().ok();
        });
        return;
    };

    let state_file = match adapter_state_path(app, "codex_guard_state.json") {
        Ok(path) => path,
        Err(error) => {
            update_codex_guard_adapter_status(&adapter_status, |status| {
                status.detected = true;
                status.codex_home = Some(codex_home.display().to_string());
                status.session_index_present = true;
                status.status = "error".to_string();
                status.last_error =
                    Some(format!("Failed to resolve codex guard state file: {error}"));
                status.last_checked_at = current_timestamp().ok();
            });
            eprintln!("failed to resolve codex guard state file: {error}");
            return;
        }
    };
    let guard_base_url = guard_base_url.to_string();
    update_codex_guard_adapter_status(&adapter_status, |status| {
        status.codex_home = Some(codex_home.display().to_string());
        status.state_file = Some(state_file.display().to_string());
        status.status = "idle".to_string();
        status.last_error = None;
        status.last_checked_at = current_timestamp().ok();
        status.experimental_soft_stop_enabled = soft_stop_enabled.load(Ordering::SeqCst);
    });

    thread::spawn(move || {
        let client = match runtime_adapter_common::new_http_client() {
            Ok(client) => client,
            Err(error) => {
                update_codex_guard_adapter_status(&adapter_status, |status| {
                    status.guard_reachable = false;
                    status.status = "error".to_string();
                    status.last_checked_at = current_timestamp().ok();
                    status.last_error =
                        Some(format!("Failed to initialize guard sync client: {error}"));
                });
                eprintln!("failed to initialize codex guard sync client: {error}");
                return;
            }
        };
        loop {
            let checked_at = current_timestamp().ok();
            let session_index_present = codex_home.join("session_index.jsonl").exists();
            if !session_index_present {
                update_codex_guard_adapter_status(&adapter_status, |status| {
                    status.detected = false;
                    status.session_index_present = false;
                    status.guard_reachable = false;
                    status.status = "unavailable".to_string();
                    status.last_checked_at = checked_at.clone();
                    status.last_error =
                        Some("session_index.jsonl not found under ~/.codex.".to_string());
                });
                thread::sleep(Duration::from_secs(5));
                continue;
            }

            update_codex_guard_adapter_status(&adapter_status, |status| {
                status.detected = true;
                status.session_index_present = true;
                status.experimental_soft_stop_enabled = soft_stop_enabled.load(Ordering::SeqCst);
            });

            if runtime_guard::query_status(&guard_base_url).is_ok() {
                update_codex_guard_adapter_status(&adapter_status, |status| {
                    status.guard_reachable = true;
                    status.status = "syncing".to_string();
                    status.last_checked_at = checked_at.clone();
                    status.last_error = None;
                });
                let experimental_soft_stop = soft_stop_enabled.load(Ordering::SeqCst);
                if let Err(error) = runtime_adapters::sync_codex_guard_once(
                    &client,
                    &codex_home,
                    &state_file,
                    &guard_base_url,
                    experimental_soft_stop,
                ) {
                    update_codex_guard_adapter_status(&adapter_status, |status| {
                        status.guard_reachable = true;
                        status.status = "error".to_string();
                        status.last_checked_at = checked_at.clone();
                        status.last_error = Some(error.clone());
                    });
                    eprintln!("codex guard sync failed: {error}");
                } else {
                    let synced_at = current_timestamp().ok();
                    sync_codex_guard_adapter_metrics_from_state_file(&adapter_status, &state_file);
                    update_codex_guard_adapter_status(&adapter_status, |status| {
                        status.guard_reachable = true;
                        status.status = "healthy".to_string();
                        status.last_checked_at = synced_at.clone();
                        status.last_synced_at = synced_at;
                        status.last_error = None;
                    });
                }
            } else {
                update_codex_guard_adapter_status(&adapter_status, |status| {
                    status.guard_reachable = false;
                    status.status = "waiting_for_guard".to_string();
                    status.last_checked_at = checked_at.clone();
                    status.last_error = None;
                });
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn start_runtime_guard_notification_loop(app: &tauri::AppHandle, guard_base_url: &str) {
    let app_handle = app.clone();
    let guard_base_url = guard_base_url.to_string();
    let notification_started_at = OffsetDateTime::now_utc();
    thread::spawn(move || {
        let mut last_notified_id: Option<i64> = None;
        loop {
            match runtime_guard::list_blocked(&guard_base_url, 12) {
                Ok(blocked) => {
                    let newest_id = blocked.first().map(|alert| alert.id).unwrap_or(0);
                    let shell_state = app_handle.state::<desktop_shell::DesktopShellState>();
                    match last_notified_id {
                        None => {
                            let _ = shell_state.bootstrap_risk_inbox(&app_handle, &blocked);
                            last_notified_id = Some(newest_id);
                        }
                        Some(previous) if newest_id < previous => {
                            last_notified_id = Some(newest_id);
                        }
                        Some(previous) if newest_id > previous => {
                            let mut fresh = blocked
                                .iter()
                                .filter(|alert| {
                                    alert.id > previous
                                        && should_surface_runtime_risk_alert(
                                            alert,
                                            Some(notification_started_at),
                                        )
                                })
                                .cloned()
                                .collect::<Vec<_>>();
                            fresh.sort_by_key(|alert| alert.id);
                            if !fresh.is_empty() {
                                let _ = shell_state.ingest_fresh_risk_alerts(&app_handle, &fresh);
                            }
                            last_notified_id = Some(newest_id);
                        }
                        _ => {}
                    }
                }
                Err(_) => {}
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::should_surface_runtime_risk_alert;
    use crate::runtime_activity::RuntimeSecurityAlertRecord;
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;

    fn sample_alert(event_time: &str) -> RuntimeSecurityAlertRecord {
        RuntimeSecurityAlertRecord {
            id: 1,
            session_id: "codex-test".to_string(),
            source: "codex".to_string(),
            workspace_path: "/tmp".to_string(),
            event_time: event_time.to_string(),
            severity: "critical".to_string(),
            title: "Output block".to_string(),
            alert_type: "output_leak_v1".to_string(),
            resource: "SKILL.md".to_string(),
            action: "block".to_string(),
            blocked: true,
            reason: "blocked".to_string(),
            details_json: "{}".to_string(),
        }
    }

    #[test]
    fn suppresses_backfilled_runtime_risk_alerts() {
        let cutoff = OffsetDateTime::parse("2026-04-04T03:00:00Z", &Rfc3339).unwrap();
        let alert = sample_alert("2026-03-27T08:01:13Z");
        assert!(!should_surface_runtime_risk_alert(&alert, Some(cutoff)));
    }

    #[test]
    fn keeps_runtime_risk_alerts_created_after_cutoff() {
        let cutoff = OffsetDateTime::parse("2026-04-04T03:00:00Z", &Rfc3339).unwrap();
        let alert = sample_alert("2026-04-04T03:00:05Z");
        assert!(should_surface_runtime_risk_alert(&alert, Some(cutoff)));
    }
}

fn start_gemini_session_sync(app: &tauri::AppHandle) {
    let Some(gemini_home) = gemini_home_path() else {
        return;
    };
    if !gemini_home.join("tmp").exists() {
        return;
    }

    let state_file = match adapter_state_path(app, "gemini_otlp_state.json") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("failed to resolve gemini adapter state file: {error}");
            return;
        }
    };
    let logs_endpoint = runtime_bridge_otlp_logs_endpoint();
    let traces_endpoint = runtime_bridge_otlp_traces_endpoint();

    thread::spawn(move || {
        let client = match runtime_adapter_common::new_http_client() {
            Ok(client) => client,
            Err(error) => {
                eprintln!("failed to initialize gemini runtime sync client: {error}");
                return;
            }
        };
        loop {
            if let Err(error) = runtime_adapters::sync_gemini_otlp_once(
                &client,
                &gemini_home,
                &state_file,
                &logs_endpoint,
                &traces_endpoint,
            ) {
                eprintln!("gemini runtime sync failed: {error}");
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn start_qwen_session_sync(app: &tauri::AppHandle, db_path: PathBuf) {
    let Some(qwen_home) = qwen_home_path() else {
        return;
    };
    if !qwen_home.join("projects").exists() {
        return;
    }

    let state_file = match adapter_state_path(app, "qwen_otlp_state.json") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("failed to resolve qwen adapter state file: {error}");
            return;
        }
    };
    let logs_endpoint = runtime_bridge_otlp_logs_endpoint();
    let traces_endpoint = runtime_bridge_otlp_traces_endpoint();

    thread::spawn(move || {
        let client = match runtime_adapter_common::new_http_client() {
            Ok(client) => client,
            Err(error) => {
                eprintln!("failed to initialize qwen runtime sync client: {error}");
                return;
            }
        };
        loop {
            if let Err(error) = runtime_adapters::sync_qwen_otlp_once(
                &client,
                &qwen_home,
                &state_file,
                &db_path,
                &logs_endpoint,
                &traces_endpoint,
            ) {
                eprintln!("qwen runtime sync failed: {error}");
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn start_claude_session_sync(app: &tauri::AppHandle) {
    if !claude_projects_roots().iter().any(|path| path.exists()) {
        return;
    }

    let state_file = match adapter_state_path(app, "claude_otlp_state.json") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("failed to resolve claude adapter state file: {error}");
            return;
        }
    };
    let logs_endpoint = runtime_bridge_otlp_logs_endpoint();
    let traces_endpoint = runtime_bridge_otlp_traces_endpoint();

    thread::spawn(move || {
        let client = match runtime_adapter_common::new_http_client() {
            Ok(client) => client,
            Err(error) => {
                eprintln!("failed to initialize claude runtime sync client: {error}");
                return;
            }
        };
        loop {
            if let Err(error) = runtime_adapters::sync_claude_otlp_once(
                &client,
                &state_file,
                &logs_endpoint,
                &traces_endpoint,
            ) {
                eprintln!("claude runtime sync failed: {error}");
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn start_opencode_session_sync(app: &tauri::AppHandle) {
    let Some(data_root) = opencode_data_path() else {
        return;
    };
    if !data_root.exists() {
        return;
    }

    let state_file = match adapter_state_path(app, "opencode_otlp_state.json") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("failed to resolve opencode adapter state file: {error}");
            return;
        }
    };
    let logs_endpoint = runtime_bridge_otlp_logs_endpoint();

    thread::spawn(move || {
        let client = match runtime_adapter_common::new_http_client() {
            Ok(client) => client,
            Err(error) => {
                eprintln!("failed to initialize opencode runtime sync client: {error}");
                return;
            }
        };
        loop {
            if let Err(error) = runtime_adapters::sync_opencode_otlp_once(
                &client,
                &data_root,
                &state_file,
                &logs_endpoint,
            ) {
                eprintln!("opencode runtime sync failed: {error}");
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn start_openclaw_session_sync(app: &tauri::AppHandle) {
    if !openclaw_roots().iter().any(|path| path.exists()) {
        return;
    }

    let state_file = match adapter_state_path(app, "openclaw_otlp_state.json") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("failed to resolve openclaw adapter state file: {error}");
            return;
        }
    };
    let logs_endpoint = runtime_bridge_otlp_logs_endpoint();
    let traces_endpoint = runtime_bridge_otlp_traces_endpoint();

    thread::spawn(move || {
        let client = match runtime_adapter_common::new_http_client() {
            Ok(client) => client,
            Err(error) => {
                eprintln!("failed to initialize openclaw runtime sync client: {error}");
                return;
            }
        };
        loop {
            if let Err(error) = runtime_adapters::sync_openclaw_otlp_once(
                &client,
                &state_file,
                &logs_endpoint,
                &traces_endpoint,
            ) {
                eprintln!("openclaw runtime sync failed: {error}");
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

fn load_json_file(path: &Path) -> serde_json::Value {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

fn ensure_json_object<'a>(
    value: &'a mut serde_json::Value,
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    if !value.is_object() {
        *value = serde_json::json!({});
    }
    value
        .as_object_mut()
        .expect("json value should be an object")
}

fn upsert_json_string(
    map: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &str,
) -> bool {
    if matches!(map.get(key), Some(serde_json::Value::String(existing)) if existing == value) {
        return false;
    }
    map.insert(
        key.to_string(),
        serde_json::Value::String(value.to_string()),
    );
    true
}

fn upsert_json_bool(
    map: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: bool,
) -> bool {
    if matches!(map.get(key), Some(serde_json::Value::Bool(existing)) if *existing == value) {
        return false;
    }
    map.insert(key.to_string(), serde_json::Value::Bool(value));
    true
}

fn write_json_if_changed(path: &Path, value: &serde_json::Value) -> Result<bool, String> {
    let formatted = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    if fs::read_to_string(path).ok().as_deref() == Some(formatted.as_str()) {
        return Ok(false);
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    fs::write(path, formatted)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(true)
}

fn ensure_claude_telemetry_settings() -> Result<bool, String> {
    let Some(home) = home_path() else {
        return Ok(false);
    };
    let settings_path = home.join(".claude/settings.json");
    let mut settings = load_json_file(&settings_path);
    let settings_object = ensure_json_object(&mut settings);
    let env_value = settings_object
        .entry("env".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let env_object = ensure_json_object(env_value);

    let mut changed = false;
    changed |= upsert_json_string(env_object, "CLAUDE_CODE_ENABLE_TELEMETRY", "1");
    changed |= upsert_json_string(env_object, "OTEL_LOGS_EXPORTER", "otlp");
    changed |= upsert_json_string(env_object, "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "http/json");
    changed |= upsert_json_string(
        env_object,
        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
        &runtime_bridge_otlp_logs_endpoint(),
    );
    changed |= upsert_json_string(env_object, "OTEL_LOG_TOOL_DETAILS", "1");

    if !changed {
        return Ok(false);
    }

    write_json_if_changed(&settings_path, &settings)
}

fn ensure_qwen_telemetry_settings() -> Result<bool, String> {
    let Some(home) = home_path() else {
        return Ok(false);
    };
    let settings_path = home.join(".qwen/settings.json");
    let mut settings = load_json_file(&settings_path);
    let settings_object = ensure_json_object(&mut settings);
    let telemetry_value = settings_object
        .entry("telemetry".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let telemetry_object = ensure_json_object(telemetry_value);

    let mut changed = false;
    changed |= upsert_json_bool(telemetry_object, "enabled", true);
    changed |= upsert_json_string(telemetry_object, "target", "local");
    changed |= upsert_json_string(
        telemetry_object,
        "otlpEndpoint",
        &format!("http://127.0.0.1:{}", runtime_bridge_port()),
    );
    changed |= upsert_json_string(telemetry_object, "otlpProtocol", "http");

    if !changed {
        return Ok(false);
    }

    write_json_if_changed(&settings_path, &settings)
}

fn ensure_gemini_telemetry_settings() -> Result<bool, String> {
    let Some(home) = home_path() else {
        return Ok(false);
    };
    let settings_path = home.join(".gemini/settings.json");
    let mut settings = load_json_file(&settings_path);
    let settings_object = ensure_json_object(&mut settings);
    let telemetry_value = settings_object
        .entry("telemetry".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let telemetry_object = ensure_json_object(telemetry_value);

    let mut changed = false;
    changed |= upsert_json_bool(telemetry_object, "enabled", true);
    changed |= upsert_json_string(telemetry_object, "target", "local");
    changed |= upsert_json_string(
        telemetry_object,
        "otlpEndpoint",
        &format!("http://127.0.0.1:{}", runtime_bridge_port()),
    );
    changed |= upsert_json_string(telemetry_object, "otlpProtocol", "http");
    changed |= upsert_json_bool(telemetry_object, "logPrompts", true);
    changed |= upsert_json_string(telemetry_object, "outfile", "");

    if !changed {
        return Ok(false);
    }

    write_json_if_changed(&settings_path, &settings)
}

fn ensure_external_runtime_telemetry_configs() {
    if let Err(error) = ensure_claude_telemetry_settings() {
        eprintln!("failed to update claude telemetry settings: {error}");
    }
    if let Err(error) = ensure_qwen_telemetry_settings() {
        eprintln!("failed to update qwen telemetry settings: {error}");
    }
    if let Err(error) = ensure_gemini_telemetry_settings() {
        eprintln!("failed to update gemini telemetry settings: {error}");
    }
}

fn ensure_desktop_runtime_session(
    state: &tauri::State<'_, RuntimeAppState>,
) -> Result<DesktopRuntimeSessionMeta, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "runtime session lock poisoned".to_string())?;
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone());
    }

    let started_at = current_timestamp()?;
    let session = DesktopRuntimeSessionMeta {
        id: format!("agentguard-desktop-{}", OffsetDateTime::now_utc().unix_timestamp()),
        started_at: started_at.clone(),
    };
    runtime_activity::upsert_session(
        &state.database_path,
        runtime_activity::RuntimeSessionInput {
            id: session.id.clone(),
            agent_name: "Aegis Desktop".to_string(),
            source: "agentguard-desktop".to_string(),
            workspace_path: repo_root().display().to_string(),
            started_at,
            ended_at: None,
            status: "active".to_string(),
            risk_level: "low".to_string(),
            summary: "Aegis desktop runtime activity session.".to_string(),
            duration_ms: None,
            source_updated_at: None,
        },
    )?;
    *guard = Some(session.clone());
    Ok(session)
}

fn record_desktop_runtime_event(
    state: &tauri::State<'_, RuntimeAppState>,
    event_type: &str,
    severity: &str,
    title: &str,
    details_json: String,
) -> Result<(), String> {
    let session = ensure_desktop_runtime_session(state)?;
    runtime_activity::append_event(
        &state.database_path,
        runtime_activity::RuntimeEventInput {
            session_id: session.id,
            event_type: event_type.to_string(),
            event_time: current_timestamp()?,
            severity: severity.to_string(),
            title: title.to_string(),
            details_json,
        },
    )
}

#[command]
#[allow(non_snake_case)]
async fn run_full_scan(
    state: tauri::State<'_, RuntimeAppState>,
    scanPaths: Option<Vec<String>>,
    scanOptions: Option<ScanOptionsInput>,
) -> Result<FullScanBundle, String> {
    let scan_control = state.scan_control.clone();
    let database_path = state.database_path.clone();
    start_scan(scan_control.as_ref())?;

    let task_scan_control = scan_control.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let mut engine = match scanPaths {
            Some(ref paths) if !paths.is_empty() => {
                build_engine_for_skill_roots(&database_path, paths, scanOptions.as_ref())?
            }
            _ => build_engine(&database_path, scanOptions.as_ref())?,
        };
        let mut full_scan = engine
            .run_full_scan_with_cancel(env!("CARGO_PKG_VERSION"), &|| {
                task_scan_control.cancel_requested.load(Ordering::SeqCst)
            })
            .map_err(|error| match error {
                discovery_engine::discovery::DiscoveryError::Cancelled => {
                    SCAN_CANCELLED_MESSAGE.to_string()
                }
                other => other.to_string(),
            })?;
        full_scan.snapshot = prune_transient_components_from_snapshot(full_scan.snapshot);
        full_scan.response =
            prune_transient_components_from_response(full_scan.response, &full_scan.snapshot);
        full_scan.artifact = build_scan_artifact(
            &full_scan.snapshot,
            &full_scan.response,
            env!("CARGO_PKG_VERSION"),
        );
        let skill_scan_options =
            scanOptions
                .as_ref()
                .map(|options| skill_library_sync::SkillScanOptionsInput {
                    recursive_scan: options.recursive_scan,
                    included_extensions: options.included_extensions.clone(),
                });
        let skill_refs = skill_library_sync::collect_skill_fingerprint_refs(
            &full_scan.snapshot,
            skill_scan_options.as_ref(),
        );

        Ok(FullScanBundle {
            run_id: full_scan.artifact.artifact_id.clone(),
            local_report: full_scan.response,
            full_artifact: full_scan.artifact,
            skill_refs,
        })
    })
    .await;

    finish_scan(scan_control.as_ref());

    match task {
        Ok(result) => result,
        Err(error) => Err(error.to_string()),
    }
}

#[command]
#[allow(non_snake_case)]
fn discover_inventory(
    state: tauri::State<'_, RuntimeAppState>,
    scanOptions: Option<ScanOptionsInput>,
) -> Result<DiscoverySnapshot, String> {
    let engine = build_engine(&state.database_path, scanOptions.as_ref())?;
    engine
        .discover_inventory()
        .map(prune_transient_components_from_snapshot)
        .map_err(|error| error.to_string())
}

#[command]
#[allow(non_snake_case)]
fn discover_inventory_for_paths(
    state: tauri::State<'_, RuntimeAppState>,
    scanPaths: Vec<String>,
    scanOptions: Option<ScanOptionsInput>,
) -> Result<DiscoverySnapshot, String> {
    let engine =
        build_engine_for_skill_roots(&state.database_path, &scanPaths, scanOptions.as_ref())?;
    engine
        .discover_inventory()
        .map(prune_transient_components_from_snapshot)
        .map_err(|error| error.to_string())
}

fn request_scan_cancel(state: tauri::State<'_, RuntimeAppState>) -> Result<bool, String> {
    if !state.scan_control.as_ref().running.load(Ordering::SeqCst) {
        return Ok(false);
    }

    state
        .scan_control
        .as_ref()
        .cancel_requested
        .store(true, Ordering::SeqCst);
    Ok(true)
}

#[command]
fn cancel_full_scan(state: tauri::State<'_, RuntimeAppState>) -> Result<bool, String> {
    request_scan_cancel(state)
}

#[command]
fn list_runtime_sessions(
    state: tauri::State<'_, RuntimeAppState>,
    limit: Option<usize>,
) -> Result<Vec<runtime_activity::RuntimeSessionRecord>, String> {
    runtime_activity::list_sessions(&state.database_path, limit.unwrap_or(24))
}

#[command]
fn list_runtime_events(
    state: tauri::State<'_, RuntimeAppState>,
    session_id: String,
) -> Result<Vec<runtime_activity::RuntimeEventRecord>, String> {
    runtime_activity::list_events(&state.database_path, &session_id)
}

#[command]
fn list_runtime_tool_stats(
    state: tauri::State<'_, RuntimeAppState>,
    limit: Option<usize>,
) -> Result<Vec<runtime_activity::RuntimeToolStatRecord>, String> {
    runtime_activity::list_tool_stats(&state.database_path, limit.unwrap_or(100))
}

#[command]
fn list_runtime_security_alerts(
    state: tauri::State<'_, RuntimeAppState>,
    limit: Option<usize>,
) -> Result<Vec<runtime_activity::RuntimeSecurityAlertRecord>, String> {
    runtime_activity::list_security_alerts(&state.database_path, limit.unwrap_or(48))
}

#[command]
fn get_runtime_ingest_config(state: tauri::State<'_, RuntimeAppState>) -> RuntimeBridgeConfig {
    RuntimeBridgeConfig {
        health_url: state.bridge.health_url.clone(),
        running: state.bridge.running,
        otlp_logs_endpoint: runtime_bridge_otlp_logs_endpoint(),
        otlp_traces_endpoint: runtime_bridge_otlp_traces_endpoint(),
        otlp_metrics_endpoint: runtime_bridge_otlp_metrics_endpoint(),
    }
}

#[command]
fn get_codex_guard_adapter_status(
    state: tauri::State<'_, RuntimeAppState>,
) -> Result<CodexGuardAdapterStatus, String> {
    state
        .codex_guard_adapter
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "codex guard adapter state is poisoned".to_string())
}

#[command]
fn set_codex_guard_soft_stop_enabled(
    state: tauri::State<'_, RuntimeAppState>,
    enabled: bool,
) -> Result<CodexGuardAdapterStatus, String> {
    state
        .codex_guard_soft_stop_enabled
        .store(enabled, Ordering::SeqCst);
    update_codex_guard_adapter_status(&state.codex_guard_adapter, |status| {
        status.experimental_soft_stop_enabled = enabled;
    });
    get_codex_guard_adapter_status(state)
}

#[command]
fn list_runtime_host_statuses(
    state: tauri::State<'_, RuntimeAppState>,
) -> Result<Vec<RuntimeHostStatus>, String> {
    let codex = state
        .codex_guard_adapter
        .lock()
        .map_err(|_| "codex guard adapter state is poisoned".to_string())?
        .clone();

    let mut hosts = Vec::new();
    hosts.push(RuntimeHostStatus {
        key: "codex".to_string(),
        label: "Codex".to_string(),
        capability_level: codex.support_level.clone(),
        status: codex.status.clone(),
        detected: codex.detected,
        last_activity_at: codex
            .last_synced_at
            .clone()
            .or(codex.last_checked_at.clone()),
        detail: codex.last_error.clone().or_else(|| {
            Some(format!(
                "processed={} blocked={}",
                codex.processed_events_total, codex.blocked_events_total
            ))
        }),
    });
    hosts.push(observed_host_status(
        "claude",
        "Claude",
        claude_projects_roots().iter().any(|path| path.exists()),
        state.bridge.running,
    ));
    hosts.push(observed_host_status(
        "gemini",
        "Gemini",
        host_detected(gemini_home_path()),
        state.bridge.running,
    ));
    hosts.push(observed_host_status(
        "qwen",
        "Qwen",
        host_detected(qwen_home_path()),
        state.bridge.running,
    ));
    hosts.push(observed_host_status(
        "opencode",
        "OpenCode",
        host_detected(opencode_data_path()),
        state.bridge.running,
    ));
    hosts.push(observed_host_status(
        "openclaw",
        "OpenClaw",
        openclaw_roots().iter().any(|path| path.exists()),
        state.bridge.running,
    ));

    Ok(hosts)
}

fn snapshot_runtime_guard_process(
    guard_state: &RuntimeGuardProcessState,
) -> Result<RuntimeGuardProcessSnapshot, String> {
    let control = guard_state
        .control
        .lock()
        .map_err(|_| "runtime guard process state is poisoned".to_string())?;
    Ok(RuntimeGuardProcessSnapshot {
        managed_by_desktop: control.child.is_some(),
        pending_action: control.pending_action,
    })
}

fn runtime_guard_last_error(
    guard_state: &RuntimeGuardProcessState,
) -> Result<Option<String>, String> {
    guard_state
        .control
        .lock()
        .map_err(|_| "runtime guard process state is poisoned".to_string())
        .map(|control| control.last_error.clone())
}

fn clear_runtime_guard_pending_state(guard_state: &RuntimeGuardProcessState) -> Result<(), String> {
    let mut control = guard_state
        .control
        .lock()
        .map_err(|_| "runtime guard process state is poisoned".to_string())?;
    control.pending_action = None;
    control.last_error = None;
    Ok(())
}

fn take_runtime_guard_process(
    guard_state: &RuntimeGuardProcessState,
) -> Result<Option<CommandChild>, String> {
    let mut control = guard_state
        .control
        .lock()
        .map_err(|_| "runtime guard process state is poisoned".to_string())?;
    Ok(control.child.take())
}

#[command]
fn get_runtime_guard_status(
    state: tauri::State<'_, RuntimeAppState>,
) -> Result<runtime_guard::RuntimeGuardDesktopStatus, String> {
    let snapshot = snapshot_runtime_guard_process(&state.guard)?;
    match runtime_guard::query_status(&state.guard.base_url) {
        Ok(status) => {
            clear_runtime_guard_pending_state(&state.guard)?;
            Ok(runtime_guard::build_status(
                &state.guard.base_url,
                &state.guard.bind_address,
                snapshot.managed_by_desktop,
                Ok(status),
                None,
                None,
            ))
        }
        Err(error) => Ok(runtime_guard::build_status(
            &state.guard.base_url,
            &state.guard.bind_address,
            snapshot.managed_by_desktop,
            Err(error),
            snapshot
                .pending_action
                .map(RuntimeGuardPendingAction::status_value)
                .map(str::to_string),
            runtime_guard_last_error(&state.guard)?,
        )),
    }
}

#[command]
fn start_runtime_guard(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeAppState>,
) -> Result<runtime_guard::RuntimeGuardDesktopStatus, String> {
    let snapshot = snapshot_runtime_guard_process(&state.guard)?;
    match runtime_guard::query_status(&state.guard.base_url) {
        Ok(status) => {
            clear_runtime_guard_pending_state(&state.guard)?;
            return Ok(runtime_guard::build_status(
                &state.guard.base_url,
                &state.guard.bind_address,
                snapshot.managed_by_desktop,
                Ok(status),
                None,
                None,
            ));
        }
        Err(error) if snapshot.managed_by_desktop => {
            return Ok(runtime_guard::build_status(
                &state.guard.base_url,
                &state.guard.bind_address,
                true,
                Err(error),
                snapshot
                    .pending_action
                    .map(RuntimeGuardPendingAction::status_value)
                    .map(str::to_string),
                runtime_guard_last_error(&state.guard)?,
            ));
        }
        Err(_) => {}
    }

    let child = runtime_guard::spawn_process(
        &app,
        &state.guard.control,
        state.guard.cli_repo_root.as_deref(),
        &state.guard.host,
        state.guard.port,
        &state.guard.database_path,
    )?;
    {
        let mut control = state
            .guard
            .control
            .lock()
            .map_err(|_| "runtime guard process state is poisoned".to_string())?;
        control.child = Some(child);
        control.pending_action = Some(RuntimeGuardPendingAction::Starting);
        control.last_error = None;
    }

    Ok(runtime_guard::build_status(
        &state.guard.base_url,
        &state.guard.bind_address,
        true,
        Err("runtime guard is starting".to_string()),
        Some(
            RuntimeGuardPendingAction::Starting
                .status_value()
                .to_string(),
        ),
        None,
    ))
}

#[command]
fn stop_runtime_guard(
    state: tauri::State<'_, RuntimeAppState>,
) -> Result<runtime_guard::RuntimeGuardDesktopStatus, String> {
    let snapshot = snapshot_runtime_guard_process(&state.guard)?;
    let shutdown_result = runtime_guard::stop(&state.guard.base_url);

    clear_runtime_guard_pending_state(&state.guard)?;
    if let Some(child) = take_runtime_guard_process(&state.guard)? {
        let _ = child.kill();
    }

    thread::sleep(Duration::from_millis(200));
    let status = runtime_guard::build_status(
        &state.guard.base_url,
        &state.guard.bind_address,
        false,
        runtime_guard::query_status(&state.guard.base_url),
        None,
        None,
    );

    if status.reachable {
        return Err("runtime guard did not stop cleanly".to_string());
    }

    match shutdown_result {
        Ok(()) => Ok(status),
        Err(_error) if snapshot.managed_by_desktop => Ok(status),
        Err(error) => Err(error),
    }
}

#[command]
fn list_runtime_guard_alerts(
    state: tauri::State<'_, RuntimeAppState>,
    limit: Option<usize>,
) -> Result<Vec<runtime_activity::RuntimeSecurityAlertRecord>, String> {
    runtime_guard::list_alerts(&state.guard.base_url, limit.unwrap_or(48))
}

#[command]
fn list_runtime_guard_blocked(
    state: tauri::State<'_, RuntimeAppState>,
    limit: Option<usize>,
) -> Result<Vec<runtime_activity::RuntimeSecurityAlertRecord>, String> {
    runtime_guard::list_blocked(&state.guard.base_url, limit.unwrap_or(48))
}

#[command]
fn list_runtime_guard_sessions(
    state: tauri::State<'_, RuntimeAppState>,
    limit: Option<usize>,
) -> Result<Vec<runtime_activity::RuntimeSessionRecord>, String> {
    runtime_guard::list_sessions(&state.guard.base_url, limit.unwrap_or(24))
}

#[command]
fn list_runtime_guard_session_events(
    state: tauri::State<'_, RuntimeAppState>,
    session_id: String,
) -> Result<Vec<runtime_activity::RuntimeEventRecord>, String> {
    runtime_guard::list_session_events(&state.guard.base_url, &session_id)
}

#[command]
fn create_runtime_guard_exception(
    state: tauri::State<'_, RuntimeAppState>,
    request: runtime_guard::RuntimeGuardExceptionRequest,
) -> Result<runtime_guard::RuntimeGuardExceptionRecord, String> {
    runtime_guard::create_exception(&state.guard.base_url, &request)
}

#[command]
fn get_desktop_shell_preferences(
    desktop_shell_state: tauri::State<'_, desktop_shell::DesktopShellState>,
) -> Result<desktop_shell::DesktopShellPreferences, String> {
    desktop_shell_state.get_preferences()
}

#[command]
fn set_desktop_shell_preferences(
    app: tauri::AppHandle,
    desktop_shell_state: tauri::State<'_, desktop_shell::DesktopShellState>,
    preferences: desktop_shell::DesktopShellPreferences,
) -> Result<desktop_shell::DesktopShellPreferences, String> {
    desktop_shell_state.set_preferences(&app, preferences)
}

#[command]
fn get_runtime_risk_inbox_state(
    desktop_shell_state: tauri::State<'_, desktop_shell::DesktopShellState>,
) -> Result<desktop_shell::RuntimeRiskInboxState, String> {
    desktop_shell_state.get_risk_inbox()
}

#[command]
fn mark_runtime_risk_inbox_seen(
    app: tauri::AppHandle,
    desktop_shell_state: tauri::State<'_, desktop_shell::DesktopShellState>,
) -> Result<desktop_shell::RuntimeRiskInboxState, String> {
    desktop_shell_state.mark_risk_inbox_seen(&app)
}

#[command]
fn attempt_runtime_guard_intervention(
    request: runtime_guard::RuntimeGuardInterventionRequest,
) -> runtime_guard::RuntimeGuardInterventionResult {
    runtime_guard::attempt_intervention(&request)
}

fn open_or_focus_window(
    app: &tauri::AppHandle,
    label: &str,
    title: &str,
    route: &str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(route.into()))
        .title(title)
        .background_color(Color(255, 255, 255, 255))
        .theme(Some(Theme::Light))
        .inner_size(width, height)
        .min_inner_size(min_width, min_height);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .accept_first_mouse(true);

    builder
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn start_runtime_ingest_bridge(db_path: PathBuf) -> bool {
    let port = runtime_bridge_port();
    let server = match Server::http(("127.0.0.1", port)) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("failed to start runtime ingest bridge: {error}");
            return false;
        }
    };

    thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();

            let response = match (method, url.as_str()) {
                (Method::Get, "/health") => json_response(StatusCode(200), r#"{"status":"ok"}"#),
                (Method::Post, "/") => {
                    let mut body = String::new();
                    match request.as_reader().read_to_string(&mut body) {
                        Ok(_) => match otlp_bridge::ingest_otlp_http(&db_path, &body) {
                            Ok(ingested) => json_response(
                                StatusCode(200),
                                &serde_json::json!({ "status": "accepted", "sessions_ingested": ingested }).to_string(),
                            ),
                            Err(error) => json_response(
                                StatusCode(400),
                                &serde_json::json!({ "error": error }).to_string(),
                            ),
                        },
                        Err(error) => json_response(
                            StatusCode(400),
                            &serde_json::json!({ "error": format!("failed to read request body: {error}") }).to_string(),
                        ),
                    }
                }
                (Method::Post, "/v1/logs") => {
                    let mut body = String::new();
                    match request.as_reader().read_to_string(&mut body) {
                        Ok(_) => match otlp_bridge::ingest_otlp_logs(&db_path, &body) {
                            Ok(ingested) => json_response(
                                StatusCode(200),
                                &serde_json::json!({ "status": "accepted", "sessions_ingested": ingested }).to_string(),
                            ),
                            Err(error) => json_response(
                                StatusCode(400),
                                &serde_json::json!({ "error": error }).to_string(),
                            ),
                        },
                        Err(error) => json_response(
                            StatusCode(400),
                            &serde_json::json!({ "error": format!("failed to read request body: {error}") }).to_string(),
                        ),
                    }
                }
                (Method::Post, "/v1/traces") => {
                    let mut body = String::new();
                    match request.as_reader().read_to_string(&mut body) {
                        Ok(_) => match otlp_bridge::ingest_otlp_traces(&db_path, &body) {
                            Ok(ingested) => json_response(
                                StatusCode(200),
                                &serde_json::json!({ "status": "accepted", "sessions_ingested": ingested }).to_string(),
                            ),
                            Err(error) => json_response(
                                StatusCode(400),
                                &serde_json::json!({ "error": error }).to_string(),
                            ),
                        },
                        Err(error) => json_response(
                            StatusCode(400),
                            &serde_json::json!({ "error": format!("failed to read request body: {error}") }).to_string(),
                        ),
                    }
                }
                (Method::Post, "/v1/metrics") => {
                    let mut body = String::new();
                    match request.as_reader().read_to_string(&mut body) {
                        Ok(_) => match otlp_bridge::ingest_otlp_metrics(&db_path, &body) {
                            Ok(ingested) => json_response(
                                StatusCode(200),
                                &serde_json::json!({ "status": "accepted", "sessions_ingested": ingested }).to_string(),
                            ),
                            Err(error) => json_response(
                                StatusCode(400),
                                &serde_json::json!({ "error": error }).to_string(),
                            ),
                        },
                        Err(error) => json_response(
                            StatusCode(400),
                            &serde_json::json!({ "error": format!("failed to read request body: {error}") }).to_string(),
                        ),
                    }
                }
                _ => json_response(StatusCode(404), r#"{"error":"not_found"}"#),
            };

            let _ = request.respond(response);
        }
    });

    true
}

fn json_response(status: StatusCode, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body.to_string()).with_status_code(status);
    if let Ok(header) = Header::from_bytes("Content-Type", "application/json") {
        response = response.with_header(header);
    }
    response
}

#[command]
fn open_activity_monitor_window(app: tauri::AppHandle) -> Result<(), String> {
    let desktop_shell_state = app.state::<desktop_shell::DesktopShellState>();
    desktop_shell_state.open_runtime_view(&app)
}

#[command]
fn open_runtime_guard_alert_window(
    app: tauri::AppHandle,
    alert_id: i64,
    session_id: String,
    blocked: bool,
) -> Result<(), String> {
    let desktop_shell_state = app.state::<desktop_shell::DesktopShellState>();
    desktop_shell::show_main_window(&app)?;
    app.emit_to(
        "main",
        desktop_shell::RUNTIME_RISK_FOCUS_REQUEST_EVENT,
        desktop_shell::RuntimeRiskFocusRequest {
            request_id: format!("risk-focus-{alert_id}"),
            session_id,
            alert_id,
            tab: if blocked {
                "blocked".to_string()
            } else {
                "alerts".to_string()
            },
        },
    )
    .map_err(|error| error.to_string())?;
    desktop_shell_state.refresh_tray(&app)
}

#[command]
fn open_quarantine_window(app: tauri::AppHandle) -> Result<(), String> {
    open_or_focus_window(
        &app,
        "quarantine-zone",
        "隔离区",
        "/?window=quarantine-zone",
        1140.0,
        800.0,
        1020.0,
        700.0,
    )
}

#[command]
fn open_repository_scan_window(app: tauri::AppHandle) -> Result<(), String> {
    open_or_focus_window(
        &app,
        "repository-scan",
        "代码库扫描",
        "/?window=repository-scan",
        1240.0,
        860.0,
        1100.0,
        760.0,
    )
}

#[command]
#[allow(non_snake_case)]
fn open_scan_check_window(
    app: tauri::AppHandle,
    windowLabel: String,
    title: String,
    storageKey: String,
) -> Result<(), String> {
    let route = format!(
        "/?window=scan-check-detail&label={}&title={}&storageKey={}",
        urlencoding::encode(windowLabel.trim()),
        urlencoding::encode(title.trim()),
        urlencoding::encode(storageKey.trim())
    );

    open_or_focus_window(
        &app,
        windowLabel.trim(),
        title.trim(),
        &route,
        1220.0,
        860.0,
        1040.0,
        720.0,
    )
}

fn is_markdown_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown") | Some("mdown") | Some("mkd")
    )
}

fn markdown_window_label(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    format!("markdown-preview-{:x}", hasher.finish())
}

fn managed_skill_window_label(skill_id: &str) -> String {
    let normalized: String = skill_id
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char == '-' {
                char.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    format!("managed-skill-detail-{}", normalized)
}

#[command]
fn open_markdown_preview_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeAppState>,
    path: String,
) -> Result<(), String> {
    let resolved = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("failed to resolve markdown path: {error}"))?;

    if !resolved.is_file() {
        return Err(format!("path is not a file: {}", resolved.display()));
    }

    if !is_markdown_path(&resolved) {
        return Err(format!(
            "path is not a markdown file: {}",
            resolved.display()
        ));
    }

    let label = markdown_window_label(&resolved);
    let title = format!(
        "Markdown 预览 · {}",
        resolved
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("未命名文件")
    );
    let route = format!(
        "/?window=markdown-preview&label={}&path={}",
        urlencoding::encode(&label),
        urlencoding::encode(&resolved.to_string_lossy())
    );

    record_desktop_runtime_event(
        &state,
        "tool_started",
        "info",
        "Markdown preview requested",
        serde_json::json!({
            "kind": "markdown_preview",
            "path": resolved.display().to_string(),
        })
        .to_string(),
    )?;
    open_or_focus_window(&app, &label, &title, &route, 980.0, 820.0, 760.0, 620.0)?;
    record_desktop_runtime_event(
        &state,
        "tool_finished",
        "info",
        "Markdown preview opened",
        serde_json::json!({
            "kind": "markdown_preview",
            "path": resolved.display().to_string(),
            "session_started_at": ensure_desktop_runtime_session(&state)?.started_at,
        })
        .to_string(),
    )
}

#[command]
#[allow(non_snake_case)]
fn open_managed_skill_detail_window(
    app: tauri::AppHandle,
    skillId: Option<String>,
    skillKey: String,
    skillName: String,
    sourceRef: Option<String>,
    centralPath: Option<String>,
    sourceType: Option<String>,
    status: Option<String>,
    action: Option<String>,
) -> Result<(), String> {
    let label = managed_skill_window_label(&skillKey);
    let title = format!("Skill 详情 · {}", skillName.trim());
    let mut route = format!(
        "/?window=managed-skill-detail&label={}&skillName={}",
        urlencoding::encode(&label),
        urlencoding::encode(skillName.trim())
    );

    if let Some(skill_id) = skillId.filter(|value| !value.trim().is_empty()) {
        route.push_str("&skillId=");
        route.push_str(&urlencoding::encode(&skill_id));
    }
    if let Some(source_ref) = sourceRef.filter(|value| !value.trim().is_empty()) {
        route.push_str("&sourceRef=");
        route.push_str(&urlencoding::encode(&source_ref));
    }
    if let Some(central_path) = centralPath.filter(|value| !value.trim().is_empty()) {
        route.push_str("&centralPath=");
        route.push_str(&urlencoding::encode(&central_path));
    }
    if let Some(source_type) = sourceType.filter(|value| !value.trim().is_empty()) {
        route.push_str("&sourceType=");
        route.push_str(&urlencoding::encode(&source_type));
    }
    if let Some(skill_status) = status.filter(|value| !value.trim().is_empty()) {
        route.push_str("&status=");
        route.push_str(&urlencoding::encode(&skill_status));
    }
    if let Some(detail_action) = action.filter(|value| !value.trim().is_empty()) {
        route.push_str("&action=");
        route.push_str(&urlencoding::encode(&detail_action));
    }

    open_or_focus_window(&app, &label, &title, &route, 1080.0, 820.0, 920.0, 680.0)
}

#[command]
fn close_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window not found: {label}"))?;

    window.close().map_err(|error| error.to_string())
}

#[command]
fn open_external_url(state: tauri::State<'_, RuntimeAppState>, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) urls are allowed".to_string());
    }

    record_desktop_runtime_event(
        &state,
        "tool_started",
        "info",
        "External URL request",
        serde_json::json!({
            "kind": "external_url",
            "url": url.clone(),
        })
        .to_string(),
    )?;
    open_with_system(&url)?;
    record_desktop_runtime_event(
        &state,
        "tool_finished",
        "info",
        "External URL opened",
        serde_json::json!({
            "kind": "external_url",
            "url": url.clone(),
            "status": "completed",
        })
        .to_string(),
    )?;
    record_desktop_runtime_event(
        &state,
        "security_alert",
        "warning",
        "External URL opened",
        serde_json::json!({
            "kind": "external_url",
            "url": url,
            "source": "desktop",
            "session_started_at": ensure_desktop_runtime_session(&state)?.started_at,
        })
        .to_string(),
    )
}

#[command]
fn open_local_path(state: tauri::State<'_, RuntimeAppState>, path: String) -> Result<(), String> {
    let resolved = PathBuf::from(&path);
    if !resolved.exists() {
        return Err(format!("path not found: {}", resolved.display()));
    }

    record_desktop_runtime_event(
        &state,
        "tool_started",
        "info",
        "Local path request",
        serde_json::json!({
            "kind": "local_path",
            "path": path.clone(),
        })
        .to_string(),
    )?;
    open_with_system(&path)?;
    record_desktop_runtime_event(
        &state,
        "tool_finished",
        "info",
        "Local path opened",
        serde_json::json!({
            "kind": "local_path",
            "path": path,
            "source": "desktop",
        })
        .to_string(),
    )
}

#[command]
fn read_markdown_file(path: String) -> Result<String, String> {
    let resolved = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("failed to resolve markdown path: {error}"))?;

    if !resolved.is_file() {
        return Err(format!("path is not a file: {}", resolved.display()));
    }

    if !is_markdown_path(&resolved) {
        return Err(format!(
            "path is not a markdown file: {}",
            resolved.display()
        ));
    }

    fs::read_to_string(&resolved).map_err(|error| format!("failed to read markdown file: {error}"))
}

fn open_with_system(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(target);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", target]);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(target);
        command
    };

    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .on_menu_event(|app, event| {
            let desktop_shell_state = app.state::<desktop_shell::DesktopShellState>();
            let _ = desktop_shell_state.handle_menu_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            let desktop_shell_state = window
                .app_handle()
                .state::<desktop_shell::DesktopShellState>();
            let _ = desktop_shell_state.handle_window_event(window, event);
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let database_path = resolve_runtime_database_path(&app_handle).map_err(|error| {
                Box::new(std::io::Error::new(std::io::ErrorKind::Other, error))
                    as Box<dyn std::error::Error>
            })?;
            let guard_database_path =
                resolve_runtime_guard_database_path(&app_handle).map_err(|error| {
                    Box::new(std::io::Error::new(std::io::ErrorKind::Other, error))
                        as Box<dyn std::error::Error>
                })?;
            let guard_host = runtime_guard::DEFAULT_GUARD_HOST.to_string();
            let guard_port = runtime_guard::DESKTOP_GUARD_PORT;
            let guard_bind_address = runtime_guard::bind_address(&guard_host, guard_port);
            let guard_base_url = runtime_guard::base_url(&guard_host, guard_port);
            let codex_guard_adapter = Arc::new(Mutex::new(default_codex_guard_adapter_status()));
            let codex_guard_soft_stop_enabled = Arc::new(AtomicBool::new(false));
            let desktop_shell_state =
                desktop_shell::DesktopShellState::new(&app_handle).map_err(|error| {
                    Box::new(std::io::Error::new(std::io::ErrorKind::Other, error))
                        as Box<dyn std::error::Error>
                })?;
            if let Err(error) = desktop_shell_state.initialize_tray(&app_handle) {
                eprintln!("failed to initialize desktop tray: {error}");
            }
            app.manage(desktop_shell_state);

            cleanup_runtime_activity_db(&database_path);
            let bridge_running = start_runtime_ingest_bridge(database_path.clone());
            if bridge_running {
                ensure_external_runtime_telemetry_configs();
                start_codex_session_sync(&app_handle);
                start_claude_session_sync(&app_handle);
                start_gemini_session_sync(&app_handle);
                start_qwen_session_sync(&app_handle, database_path.clone());
                start_opencode_session_sync(&app_handle);
                start_openclaw_session_sync(&app_handle);
            }
            start_codex_guard_sync(
                &app_handle,
                &guard_base_url,
                codex_guard_adapter.clone(),
                codex_guard_soft_stop_enabled.clone(),
            );
            start_runtime_guard_notification_loop(&app_handle, &guard_base_url);

            app.manage(RuntimeAppState {
                database_path,
                session: Mutex::new(None),
                bridge: RuntimeBridgeState {
                    health_url: runtime_bridge_health_url(),
                    running: bridge_running,
                },
                guard: RuntimeGuardProcessState {
                    host: guard_host.clone(),
                    port: guard_port,
                    base_url: guard_base_url,
                    bind_address: guard_bind_address,
                    database_path: guard_database_path,
                    cli_repo_root: runtime_guard::cli_repo_root(&workspace_root()),
                    control: Arc::new(Mutex::new(RuntimeGuardProcessControl::default())),
                },
                codex_guard_adapter,
                codex_guard_soft_stop_enabled,
                scan_control: Arc::new(ScanControlState {
                    running: AtomicBool::new(false),
                    cancel_requested: AtomicBool::new(false),
                }),
                repository_scan: repository_audit::RepositoryScanState::new(),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            repository_audit::choose_repository_directory,
            repository_audit::start_repository_scan_job,
            repository_audit::get_repository_scan_job_status,
            repository_audit::cancel_repository_scan_job,
            cancel_full_scan,
            get_desktop_shell_preferences,
            get_codex_guard_adapter_status,
            list_runtime_host_statuses,
            discover_inventory,
            discover_inventory_for_paths,
            local_mcp_discovery::discover_local_mcp_servers,
            get_runtime_ingest_config,
            get_runtime_guard_status,
            get_runtime_risk_inbox_state,
            list_runtime_events,
            list_runtime_guard_alerts,
            list_runtime_guard_blocked,
            attempt_runtime_guard_intervention,
            create_runtime_guard_exception,
            list_runtime_guard_session_events,
            list_runtime_guard_sessions,
            list_runtime_security_alerts,
            list_runtime_sessions,
            list_runtime_tool_stats,
            mark_runtime_risk_inbox_seen,
            run_full_scan,
            repository_audit::scan_repository,
            close_window,
            open_external_url,
            open_local_path,
            open_markdown_preview_window,
            open_managed_skill_detail_window,
            open_activity_monitor_window,
            open_runtime_guard_alert_window,
            open_quarantine_window,
            open_repository_scan_window,
            open_scan_check_window,
            read_markdown_file,
            set_desktop_shell_preferences,
            set_codex_guard_soft_stop_enabled,
            start_runtime_guard,
            stop_runtime_guard,
            skill_library_sync::collect_local_skill_packages,
            skill_manager::delete_managed_skill,
            skill_manager::get_central_repo_path,
            skill_manager::get_managed_skills,
            skill_manager::get_tool_status,
            skill_manager::import_git_skill,
            skill_manager::import_local_skill,
            skill_manager::sync_skill_to_tool,
            skill_manager::unsync_skill_from_tool,
            skill_manager::update_managed_skill
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Aegis");
}
