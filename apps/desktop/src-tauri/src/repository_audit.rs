use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use discovery_engine::{
    default_included_extensions, path_matches_included_extensions, ComponentReport, Finding,
    RepositoryAuditEngine, RepositoryAuditError, ScanResponse, ScanSummary, SkillReport,
};
use rfd::FileDialog;
use tauri::{async_runtime, command};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use walkdir::WalkDir;

const MCP_CONFIG_FILENAMES: &[&str] = &[
    "claude_desktop_config.json",
    "cline_mcp_settings.json",
    "docker-mcp.json",
    "docker-mcp.yaml",
    "mcp-config.json",
    "mcp-config.yaml",
    "mcp-config.yml",
    "mcp.json",
    "mcp.yaml",
    "mcp.yml",
];

const SKIP_DIR_NAMES: &[&str] = &[
    ".git",
    ".next",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
];

const REPOSITORY_PROGRESS_MIN: u8 = 6;
const REPOSITORY_PROGRESS_RUNNING_MAX: u8 = 96;

#[derive(Clone)]
pub struct RepositoryScanState {
    jobs: Arc<Mutex<HashMap<String, RepositoryScanJobStatus>>>,
    controls: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl RepositoryScanState {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
            controls: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn insert_job(
        &self,
        job: RepositoryScanJobStatus,
        cancel_requested: Arc<AtomicBool>,
    ) -> Result<(), String> {
        self.jobs
            .lock()
            .map_err(|_| "repository scan jobs lock poisoned".to_string())?
            .insert(job.job_id.clone(), job.clone());
        self.controls
            .lock()
            .map_err(|_| "repository scan controls lock poisoned".to_string())?
            .insert(job.job_id, cancel_requested);
        Ok(())
    }

    fn get_job(&self, job_id: &str) -> Result<Option<RepositoryScanJobStatus>, String> {
        Ok(self
            .jobs
            .lock()
            .map_err(|_| "repository scan jobs lock poisoned".to_string())?
            .get(job_id)
            .cloned())
    }

    fn update_job<F>(&self, job_id: &str, updater: F) -> Result<(), String>
    where
        F: FnOnce(&mut RepositoryScanJobStatus),
    {
        let mut guard = self
            .jobs
            .lock()
            .map_err(|_| "repository scan jobs lock poisoned".to_string())?;
        let job = guard
            .get_mut(job_id)
            .ok_or_else(|| format!("repository scan job not found: {job_id}"))?;
        updater(job);
        Ok(())
    }

    fn remove_control(&self, job_id: &str) -> Result<(), String> {
        self.controls
            .lock()
            .map_err(|_| "repository scan controls lock poisoned".to_string())?
            .remove(job_id);
        Ok(())
    }

    fn request_cancel(&self, job_id: &str) -> Result<bool, String> {
        let guard = self
            .controls
            .lock()
            .map_err(|_| "repository scan controls lock poisoned".to_string())?;
        let Some(cancel_requested) = guard.get(job_id) else {
            return Ok(false);
        };
        cancel_requested.store(true, Ordering::SeqCst);
        Ok(true)
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryScanJobStatus {
    pub job_id: String,
    pub path: String,
    pub status: String,
    pub stage: String,
    pub progress: u8,
    pub current_file: Option<String>,
    pub scanned_files: usize,
    pub total_files: usize,
    pub findings_count: usize,
    pub highest_severity: u8,
    pub stage_findings: HashMap<String, usize>,
    pub error_message: Option<String>,
    pub response: Option<ScanResponse>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Clone)]
struct RepositoryScanProgress {
    current_file: String,
    stage: String,
    progress: u8,
    scanned_files: usize,
    total_files: usize,
    findings_count: usize,
    highest_severity: u8,
    stage_findings: HashMap<String, usize>,
}

#[command]
pub fn choose_repository_directory() -> Result<Option<String>, String> {
    let selected = FileDialog::new()
        .set_title("选择要扫描的代码仓库")
        .pick_folder()
        .map(|path| path.display().to_string());

    Ok(selected)
}

#[command]
pub async fn scan_repository(path: String) -> Result<ScanResponse, String> {
    let selected_path = validate_repository_directory(&path)?;

    async_runtime::spawn_blocking(move || {
        let engine = RepositoryAuditEngine::new().map_err(|error| error.to_string())?;
        engine
            .scan(&selected_path)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[command]
pub fn start_repository_scan_job(
    state: tauri::State<'_, crate::RuntimeAppState>,
    path: String,
) -> Result<RepositoryScanJobStatus, String> {
    let selected_path = validate_repository_directory(&path)?;
    let canonical_path = selected_path.display().to_string();
    let job_id = build_repository_scan_job_id(&selected_path);
    let started_at = current_timestamp()?;
    let cancel_requested = Arc::new(AtomicBool::new(false));

    let initial = RepositoryScanJobStatus {
        job_id: job_id.clone(),
        path: canonical_path.clone(),
        status: "queued".to_string(),
        stage: "queued".to_string(),
        progress: 5,
        current_file: None,
        scanned_files: 0,
        total_files: 0,
        findings_count: 0,
        highest_severity: 0,
        stage_findings: HashMap::new(),
        error_message: None,
        response: None,
        started_at,
        finished_at: None,
    };

    state
        .repository_scan
        .insert_job(initial.clone(), cancel_requested.clone())?;

    let repository_scan_state = state.repository_scan.clone();
    async_runtime::spawn(async move {
        let audit_files = match collect_repository_scan_files(&selected_path) {
            Ok(files) => files,
            Err(error_message) => {
                let _ = repository_scan_state.update_job(&job_id, |job| {
                    job.status = "failed".to_string();
                    job.stage = "failed".to_string();
                    job.progress = 100;
                    job.current_file = None;
                    job.error_message = Some(error_message);
                    job.response = None;
                    job.finished_at = current_timestamp().ok();
                });
                let _ = repository_scan_state.remove_control(&job_id);
                return;
            }
        };

        let total_files = audit_files.len();
        let _ = repository_scan_state.update_job(&job_id, |job| {
            job.status = "running".to_string();
            job.stage = resolve_repository_scan_stage(REPOSITORY_PROGRESS_MIN).to_string();
            job.progress = if total_files == 0 {
                REPOSITORY_PROGRESS_RUNNING_MAX
            } else {
                REPOSITORY_PROGRESS_MIN
            };
            job.current_file = audit_files.first().map(|path| path.display().to_string());
            job.scanned_files = 0;
            job.total_files = total_files;
            job.findings_count = 0;
            job.highest_severity = 0;
            job.stage_findings = HashMap::new();
            job.error_message = None;
            job.response = None;
            job.finished_at = None;
        });

        let progress_state = repository_scan_state.clone();
        let progress_job_id = job_id.clone();
        let progress_cancel_requested = cancel_requested.clone();
        let scan_target = selected_path.clone();
        let result = async_runtime::spawn_blocking(move || {
            scan_repository_with_progress(
                &scan_target,
                audit_files,
                &|| progress_cancel_requested.load(Ordering::SeqCst),
                |snapshot| {
                    let _ = progress_state.update_job(&progress_job_id, |job| {
                        job.status = "running".to_string();
                        job.stage = snapshot.stage.clone();
                        job.progress = snapshot.progress;
                        job.current_file = Some(snapshot.current_file.clone());
                        job.scanned_files = snapshot.scanned_files;
                        job.total_files = snapshot.total_files;
                        job.findings_count = snapshot.findings_count;
                        job.highest_severity = snapshot.highest_severity;
                        job.stage_findings = snapshot.stage_findings.clone();
                        job.error_message = None;
                        job.response = None;
                    });
                },
            )
            .map_err(|error| match error {
                RepositoryAuditError::Cancelled => "REPOSITORY_SCAN_CANCELLED".to_string(),
                other => other.to_string(),
            })
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|value| value);

        match result {
            Ok(response) => {
                let highest_severity = highest_severity_for_response(&response);
                let stage_findings = stage_findings_for_response(&response);
                let _ = repository_scan_state.update_job(&job_id, |job| {
                    job.status = "completed".to_string();
                    job.stage = "completed".to_string();
                    job.progress = 100;
                    job.current_file = None;
                    job.scanned_files = response.summary.scanned_components;
                    job.total_files = total_files;
                    job.findings_count = response.summary.findings;
                    job.highest_severity = highest_severity;
                    job.stage_findings = stage_findings;
                    job.error_message = None;
                    job.response = Some(response);
                    job.finished_at = current_timestamp().ok();
                });
            }
            Err(error_message) if error_message == "REPOSITORY_SCAN_CANCELLED" => {
                let _ = repository_scan_state.update_job(&job_id, |job| {
                    job.status = "cancelled".to_string();
                    job.stage = "cancelled".to_string();
                    job.progress = 100;
                    job.current_file = None;
                    job.error_message = Some("代码库扫描已终止".to_string());
                    job.response = None;
                    job.finished_at = current_timestamp().ok();
                });
            }
            Err(error_message) => {
                let _ = repository_scan_state.update_job(&job_id, |job| {
                    job.status = "failed".to_string();
                    job.stage = "failed".to_string();
                    job.progress = 100;
                    job.current_file = None;
                    job.error_message = Some(error_message);
                    job.response = None;
                    job.finished_at = current_timestamp().ok();
                });
            }
        }

        let _ = repository_scan_state.remove_control(&job_id);
    });

    Ok(initial)
}

#[command]
#[allow(non_snake_case)]
pub fn get_repository_scan_job_status(
    state: tauri::State<'_, crate::RuntimeAppState>,
    jobId: String,
) -> Result<Option<RepositoryScanJobStatus>, String> {
    state.repository_scan.get_job(jobId.trim())
}

#[command]
#[allow(non_snake_case)]
pub fn cancel_repository_scan_job(
    state: tauri::State<'_, crate::RuntimeAppState>,
    jobId: String,
) -> Result<bool, String> {
    state.repository_scan.request_cancel(jobId.trim())
}

fn validate_repository_directory(path: &str) -> Result<PathBuf, String> {
    let selected_path = PathBuf::from(path);

    if !selected_path.exists() {
        return Err(format!("Path not found: {}", selected_path.display()));
    }

    if !selected_path.is_dir() {
        return Err(format!(
            "Path is not a directory: {}",
            selected_path.display()
        ));
    }

    selected_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve repository path: {error}"))
}

fn collect_repository_scan_files(target: &Path) -> Result<Vec<PathBuf>, String> {
    let included_extensions = repository_scan_included_extensions();
    if target.is_file() {
        return Ok(if is_repository_scan_file(target, &included_extensions) {
            vec![target.to_path_buf()]
        } else {
            Vec::new()
        });
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(target).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if entry.file_type().is_dir() && should_skip_repository_directory(path) {
            continue;
        }

        if entry.file_type().is_file() && is_repository_scan_file(path, &included_extensions) {
            files.push(path.to_path_buf());
        }
    }

    Ok(files)
}

fn repository_scan_included_extensions() -> BTreeSet<String> {
    let mut included_extensions = default_included_extensions();
    for extension in ["cfg", "conf", "config", "env", "properties", "xml"] {
        included_extensions.insert(extension.to_string());
    }
    included_extensions
}

fn is_repository_scan_file(path: &Path, included_extensions: &BTreeSet<String>) -> bool {
    is_known_mcp_config_path(path) || path_matches_included_extensions(path, included_extensions)
}

fn should_skip_repository_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| SKIP_DIR_NAMES.contains(&value))
        .unwrap_or(false)
}

fn is_known_mcp_config_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| {
            MCP_CONFIG_FILENAMES
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(value))
                || value.ends_with(".mcp.json")
        })
        .unwrap_or(false)
}

fn scan_repository_with_progress<F, G>(
    target: &Path,
    audit_files: Vec<PathBuf>,
    should_cancel: &F,
    mut on_progress: G,
) -> Result<ScanResponse, RepositoryAuditError>
where
    F: Fn() -> bool,
    G: FnMut(RepositoryScanProgress),
{
    let engine = RepositoryAuditEngine::new()?;
    let mut results = Vec::<SkillReport>::new();
    let mut mcp_results = Vec::<ComponentReport>::new();
    let mut agent_results = Vec::<ComponentReport>::new();
    let mut findings_count = 0usize;
    let mut highest_severity = 0u8;
    let mut stage_findings = HashMap::<String, usize>::new();
    let total_files = audit_files.len();

    for (index, file_path) in audit_files.iter().enumerate() {
        if should_cancel() {
            return Err(RepositoryAuditError::Cancelled);
        }

        let current_file = file_path.display().to_string();
        let scanned_files = index + 1;
        let progress = resolve_repository_scan_progress(scanned_files, total_files);

        if file_path.exists() && file_path.is_file() {
            let file_response = engine.scan_with_cancel(file_path, should_cancel)?;
            findings_count += file_response.summary.findings;
            highest_severity = highest_severity.max(highest_severity_for_response(&file_response));
            merge_stage_findings(
                &mut stage_findings,
                stage_findings_for_response(&file_response),
            );
            results.extend(file_response.results);
            mcp_results.extend(file_response.mcp_results);
            agent_results.extend(file_response.agent_results);
        }

        on_progress(RepositoryScanProgress {
            current_file,
            stage: resolve_repository_scan_stage(progress).to_string(),
            progress,
            scanned_files,
            total_files,
            findings_count,
            highest_severity,
            stage_findings: stage_findings.clone(),
        });
    }

    sort_skill_reports(&mut results);
    sort_component_reports(&mut mcp_results);
    sort_component_reports(&mut agent_results);

    let mcp_findings = component_findings_count(&mcp_results);
    let agent_findings = component_findings_count(&agent_results);

    Ok(ScanResponse {
        summary: ScanSummary {
            scanned_roots: vec![target.display().to_string()],
            scanned_skills: results.len(),
            scanned_mcps: mcp_results.len(),
            scanned_agents: agent_results.len(),
            scanned_components: total_files,
            findings: findings_count,
            skill_findings: findings_count,
            mcp_findings,
            agent_findings,
            backend: "repository_audit".to_string(),
            generated_at: current_timestamp().unwrap_or_else(|_| "unknown".to_string()),
        },
        results,
        mcp_results,
        agent_results,
    })
}

fn resolve_repository_scan_progress(scanned_files: usize, total_files: usize) -> u8 {
    if total_files == 0 {
        return REPOSITORY_PROGRESS_RUNNING_MAX;
    }

    let span = (REPOSITORY_PROGRESS_RUNNING_MAX - REPOSITORY_PROGRESS_MIN) as f32;
    let normalized = (scanned_files as f32 / total_files as f32).clamp(0.0, 1.0);
    (REPOSITORY_PROGRESS_MIN as f32 + span * normalized).round() as u8
}

fn resolve_repository_scan_stage(progress: u8) -> &'static str {
    match progress {
        0..=16 => "code_analysis",
        17..=28 => "dependency_review",
        29..=40 => "mcp_config",
        41..=52 => "agent_flow",
        53..=64 => "secret_detection",
        65..=76 => "network_review",
        77..=88 => "shell_execution",
        _ => "prompt_injection",
    }
}

fn highest_severity_for_response(response: &ScanResponse) -> u8 {
    response
        .results
        .iter()
        .flat_map(|report| report.files.iter())
        .flat_map(|file| file.findings.iter())
        .map(|finding| finding.severity)
        .max()
        .unwrap_or(0)
}

fn stage_findings_for_response(response: &ScanResponse) -> HashMap<String, usize> {
    let mut stage_findings = HashMap::<String, usize>::new();
    for finding in response
        .results
        .iter()
        .flat_map(|report| report.files.iter())
        .flat_map(|file| file.findings.iter())
    {
        for stage in stage_keys_for_finding(finding) {
            *stage_findings.entry(stage.to_string()).or_insert(0) += 1;
        }
    }

    stage_findings
}

fn merge_stage_findings(target: &mut HashMap<String, usize>, incoming: HashMap<String, usize>) {
    for (key, count) in incoming {
        *target.entry(key).or_insert(0) += count;
    }
}

fn stage_keys_for_finding(finding: &Finding) -> Vec<&'static str> {
    let mut stages = vec!["code_analysis"];
    let rule_id = finding.rule_id.as_str();
    let title = finding.title.to_ascii_lowercase();
    let description = finding.description.to_ascii_lowercase();
    let snippet = finding.snippet.to_ascii_lowercase();
    let file = finding.file.to_ascii_lowercase();
    let corpus = format!("{title} {description} {snippet} {file}");

    if matches_dependency_file(&file) {
        stages.push("dependency_review");
    }
    if is_mcp_related(&finding.file, finding) {
        stages.push("mcp_config");
    } else {
        stages.push("agent_flow");
    }
    if rule_id == "AGENT-004"
        || corpus.contains("secret")
        || corpus.contains("token")
        || corpus.contains("credential")
    {
        stages.push("secret_detection");
    }
    if rule_id == "AGENT-003"
        || corpus.contains("network")
        || corpus.contains("http")
        || corpus.contains("https")
        || corpus.contains("webhook")
        || corpus.contains("outbound")
    {
        stages.push("network_review");
    }
    if matches!(rule_id, "AGENT-001" | "AGENT-035")
        || corpus.contains("shell")
        || corpus.contains("command")
        || corpus.contains("subprocess")
        || corpus.contains("exec")
    {
        stages.push("shell_execution");
    }
    if rule_id == "AGENT-010"
        || corpus.contains("prompt injection")
        || corpus.contains("system prompt")
    {
        stages.push("prompt_injection");
    }

    stages.sort_unstable();
    stages.dedup();
    stages
}

fn matches_dependency_file(file: &str) -> bool {
    [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "requirements.txt",
        "pyproject.toml",
        "cargo.toml",
        "cargo.lock",
        "go.mod",
        "go.sum",
        "pom.xml",
    ]
    .iter()
    .any(|candidate| file.ends_with(candidate))
}

fn sort_skill_reports(reports: &mut [SkillReport]) {
    reports.sort_by(|left, right| {
        right.risk_score.cmp(&left.risk_score).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        })
    });
}

fn sort_component_reports(reports: &mut [ComponentReport]) {
    reports.sort_by(|left, right| {
        right.risk_score.cmp(&left.risk_score).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        })
    });
}

fn component_findings_count(reports: &[ComponentReport]) -> usize {
    reports
        .iter()
        .flat_map(|report| report.files.iter())
        .map(|file| file.findings.len())
        .sum()
}

fn is_mcp_related(path: &str, finding: &Finding) -> bool {
    if finding.rule_id.starts_with("AGENT-029")
        || finding.rule_id.starts_with("AGENT-030")
        || finding.rule_id.starts_with("AGENT-031")
        || finding.rule_id.starts_with("AGENT-033")
        || finding.rule_id.starts_with("AGENT-005")
    {
        return true;
    }

    let corpus = format!(
        "{} {} {} {} {}",
        path, finding.rule_id, finding.title, finding.description, finding.snippet
    )
    .to_ascii_lowercase();

    corpus.contains("mcp")
        || corpus.contains("claude_desktop_config")
        || corpus.contains("filesystem server")
}

fn build_repository_scan_job_id(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.display().to_string().hash(&mut hasher);
    format!(
        "repository-scan-{}-{:x}",
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
        hasher.finish()
    )
}

fn current_timestamp() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| error.to_string())
}
