use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::command;

use crate::{configure_cli_command, record_desktop_runtime_event, RuntimeAppState};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManagedTarget {
    pub tool: String,
    pub mode: String,
    pub status: String,
    pub target_path: String,
    pub synced_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManagedSkill {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub central_path: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_sync_at: Option<i64>,
    pub status: String,
    pub targets: Vec<ManagedTarget>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolInfo {
    pub key: String,
    pub label: String,
    pub installed: bool,
    pub skills_dir: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolStatus {
    pub tools: Vec<ToolInfo>,
    pub installed: Vec<String>,
}

#[derive(Clone, Debug)]
struct ToolAdapter {
    key: &'static str,
    label: &'static str,
    detect_dir: &'static str,
    skills_dir: &'static str,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ManagedSkillStore {
    skills: Vec<ManagedSkill>,
}

const TOOL_ADAPTERS: &[ToolAdapter] = &[
    ToolAdapter {
        key: "codex",
        label: "Codex",
        detect_dir: "~/.codex",
        skills_dir: "~/.codex/skills",
    },
    ToolAdapter {
        key: "claude_code",
        label: "Claude Code",
        detect_dir: "~/.claude",
        skills_dir: "~/.claude/skills",
    },
    ToolAdapter {
        key: "cline",
        label: "Cline",
        detect_dir: "~/.cline",
        skills_dir: "~/.cline/plugins",
    },
    ToolAdapter {
        key: "openclaw",
        label: "OpenClaw",
        detect_dir: "~/.openclaw",
        skills_dir: "~/.openclaw/skills",
    },
    ToolAdapter {
        key: "cursor",
        label: "Cursor",
        detect_dir: "~/.cursor",
        skills_dir: "~/.cursor/skills",
    },
    ToolAdapter {
        key: "opencode",
        label: "OpenCode",
        detect_dir: "~/.config/opencode",
        skills_dir: "~/.config/opencode/skills",
    },
    ToolAdapter {
        key: "agents",
        label: "Agents Runtime",
        detect_dir: "~/.config/agents",
        skills_dir: "~/.config/agents/skills",
    },
];

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or_else(|| "Unable to resolve home directory".to_string())
}

fn expand_home(path: &str) -> Result<PathBuf, String> {
    if path == "~" {
        return home_dir();
    }

    if let Some(stripped) = path.strip_prefix("~/") {
        return Ok(home_dir()?.join(stripped));
    }

    Ok(PathBuf::from(path))
}

fn shield_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".agents-of-shield"))
}

fn central_repo_path_internal() -> Result<PathBuf, String> {
    Ok(shield_root()?.join("skills-vault"))
}

fn skill_store_path() -> Result<PathBuf, String> {
    Ok(shield_root()?.join("managed-skills.json"))
}

fn ensure_parent_dirs() -> Result<(), String> {
    fs::create_dir_all(shield_root()?).map_err(|error| error.to_string())?;
    fs::create_dir_all(central_repo_path_internal()?).map_err(|error| error.to_string())?;
    Ok(())
}

fn read_store() -> Result<ManagedSkillStore, String> {
    ensure_parent_dirs()?;
    let path = skill_store_path()?;

    if !path.exists() {
        return Ok(ManagedSkillStore { skills: Vec::new() });
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn write_store(store: &ManagedSkillStore) -> Result<(), String> {
    ensure_parent_dirs()?;
    let raw = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    fs::write(skill_store_path()?, raw).map_err(|error| error.to_string())
}

fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = false;

    for ch in input.chars() {
        let normalized = if ch.is_ascii_alphanumeric() {
            last_dash = false;
            ch.to_ascii_lowercase()
        } else if !last_dash {
            last_dash = true;
            '-'
        } else {
            continue;
        };
        out.push(normalized);
    }

    out.trim_matches('-').to_string()
}

fn remove_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;

    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| error.to_string())?;

        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn resolve_skill_root(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("Path not found: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    if path.join("SKILL.md").exists() {
        return Ok(path.to_path_buf());
    }

    let mut child_skill_dirs = Vec::new();
    let mut has_any_file = false;
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let entry_path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            if entry_path.join("SKILL.md").exists() {
                child_skill_dirs.push(entry_path);
            }
        } else {
            has_any_file = true;
        }
    }

    if child_skill_dirs.len() == 1 {
        return Ok(child_skill_dirs.remove(0));
    }

    if child_skill_dirs.len() > 1 {
        return Err(
            "This source contains multiple skill folders. Please choose a specific skill directory."
                .to_string(),
        );
    }

    if has_any_file {
        return Ok(path.to_path_buf());
    }

    Err(format!("No skill content found in {}", path.display()))
}

fn infer_skill_name(skill_root: &Path, requested_name: Option<String>) -> Result<String, String> {
    if let Some(name) = requested_name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    skill_root
        .file_name()
        .and_then(|item| item.to_str())
        .map(|item| item.to_string())
        .ok_or_else(|| "Unable to infer skill name".to_string())
}

fn unique_vault_path(name: &str) -> Result<PathBuf, String> {
    let base = central_repo_path_internal()?;
    let slug = slugify(name);
    let candidate = base.join(&slug);
    if !candidate.exists() {
        return Ok(candidate);
    }

    Ok(base.join(format!("{}-{}", slug, now_ms())))
}

fn find_tool(tool_id: &str) -> Result<&'static ToolAdapter, String> {
    TOOL_ADAPTERS
        .iter()
        .find(|tool| tool.key == tool_id)
        .ok_or_else(|| format!("Unknown tool: {tool_id}"))
}

fn sync_skill_record_to_tool(skill: &ManagedSkill, tool_id: &str) -> Result<ManagedTarget, String> {
    let tool = find_tool(tool_id)?;
    let detect_dir = expand_home(tool.detect_dir)?;
    if !detect_dir.exists() {
        return Err(format!("Tool is not installed: {}", tool.label));
    }

    let skills_dir = expand_home(tool.skills_dir)?;
    fs::create_dir_all(&skills_dir).map_err(|error| error.to_string())?;

    let target_path = skills_dir.join(&skill.name);
    remove_path(&target_path)?;
    copy_dir_recursive(Path::new(&skill.central_path), &target_path)?;

    Ok(ManagedTarget {
        tool: tool.key.to_string(),
        mode: "copy".to_string(),
        status: "synced".to_string(),
        target_path: target_path.to_string_lossy().to_string(),
        synced_at: Some(now_ms()),
    })
}

fn persist_new_skill(
    source_type: &str,
    source_ref: Option<String>,
    skill_root: &Path,
    name: Option<String>,
) -> Result<ManagedSkill, String> {
    let mut store = read_store()?;
    let resolved_name = infer_skill_name(skill_root, name)?;
    if store
        .skills
        .iter()
        .any(|skill| skill.name.eq_ignore_ascii_case(&resolved_name))
    {
        return Err(format!("Managed skill already exists: {resolved_name}"));
    }

    let central_path = unique_vault_path(&resolved_name)?;
    copy_dir_recursive(skill_root, &central_path)?;

    let timestamp = now_ms();
    let skill = ManagedSkill {
        id: format!("skill-{}-{}", slugify(&resolved_name), timestamp),
        name: resolved_name,
        source_type: source_type.to_string(),
        source_ref,
        central_path: central_path.to_string_lossy().to_string(),
        created_at: timestamp,
        updated_at: timestamp,
        last_sync_at: None,
        status: "managed".to_string(),
        targets: Vec::new(),
    };

    store.skills.push(skill.clone());
    store
        .skills
        .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    write_store(&store)?;
    Ok(skill)
}

fn clone_repo(repo_url: &str) -> Result<PathBuf, String> {
    let temp_dir = env::temp_dir().join(format!("agents-of-shield-git-{}", now_ms()));
    let mut command = Command::new("git");
    configure_cli_command(&mut command);
    let output = command
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .arg(repo_url)
        .arg(&temp_dir)
        .output()
        .map_err(|error| format!("Failed to launch git: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        let _ = remove_path(&temp_dir);
        return Err(format!("Git clone failed: {detail}"));
    }

    Ok(temp_dir)
}

fn refresh_targets(skill: &mut ManagedSkill) -> Result<(), String> {
    let target_ids = skill
        .targets
        .iter()
        .map(|target| target.tool.clone())
        .collect::<Vec<_>>();
    let refreshed_targets = target_ids
        .iter()
        .map(|tool_id| sync_skill_record_to_tool(skill, tool_id))
        .collect::<Result<Vec<_>, _>>()?;

    let latest_sync = refreshed_targets
        .iter()
        .filter_map(|target| target.synced_at)
        .max();
    skill.targets = refreshed_targets;
    skill.last_sync_at = latest_sync;
    Ok(())
}

#[command]
pub fn get_central_repo_path() -> Result<String, String> {
    Ok(central_repo_path_internal()?.to_string_lossy().to_string())
}

#[command]
pub fn get_tool_status() -> Result<ToolStatus, String> {
    let mut tools = Vec::new();
    let mut installed = Vec::new();

    for adapter in TOOL_ADAPTERS {
        let detect_dir = expand_home(adapter.detect_dir)?;
        let skills_dir = expand_home(adapter.skills_dir)?;
        let is_installed = detect_dir.exists();

        tools.push(ToolInfo {
            key: adapter.key.to_string(),
            label: adapter.label.to_string(),
            installed: is_installed,
            skills_dir: skills_dir.to_string_lossy().to_string(),
        });

        if is_installed {
            installed.push(adapter.key.to_string());
        }
    }

    Ok(ToolStatus { tools, installed })
}

#[command]
pub fn get_managed_skills() -> Result<Vec<ManagedSkill>, String> {
    Ok(read_store()?.skills)
}

#[command]
#[allow(non_snake_case)]
pub fn import_local_skill(
    state: tauri::State<'_, RuntimeAppState>,
    sourcePath: String,
    name: Option<String>,
) -> Result<ManagedSkill, String> {
    record_desktop_runtime_event(
        &state,
        "tool_started",
        "info",
        "Import local skill requested",
        json!({
            "source_path": sourcePath.clone(),
            "name": name.clone(),
        })
        .to_string(),
    )?;
    let source_path = expand_home(&sourcePath)?;
    let skill_root = resolve_skill_root(&source_path)?;
    let skill = persist_new_skill(
        "local",
        Some(skill_root.to_string_lossy().to_string()),
        &skill_root,
        name,
    )?;
    record_desktop_runtime_event(
        &state,
        "tool_finished",
        "info",
        "Local skill imported",
        json!({
            "skill_id": skill.id,
            "skill_name": skill.name,
            "central_path": skill.central_path,
        })
        .to_string(),
    )?;
    Ok(skill)
}

#[command]
#[allow(non_snake_case)]
pub fn import_git_skill(
    state: tauri::State<'_, RuntimeAppState>,
    repoUrl: String,
    name: Option<String>,
) -> Result<ManagedSkill, String> {
    record_desktop_runtime_event(
        &state,
        "tool_started",
        "info",
        "Import git skill requested",
        json!({
            "repo_url": repoUrl.clone(),
            "name": name.clone(),
        })
        .to_string(),
    )?;
    let clone_dir = clone_repo(&repoUrl)?;
    let import_result = (|| {
        let skill_root = resolve_skill_root(&clone_dir)?;
        persist_new_skill("git", Some(repoUrl.clone()), &skill_root, name)
    })();
    let _ = remove_path(&clone_dir);
    if let Ok(skill) = import_result.as_ref() {
        record_desktop_runtime_event(
            &state,
            "tool_finished",
            "info",
            "Git skill imported",
            json!({
                "skill_id": skill.id,
                "skill_name": skill.name,
                "source_ref": skill.source_ref,
            })
            .to_string(),
        )?;
    }
    import_result
}

#[command]
#[allow(non_snake_case)]
pub fn sync_skill_to_tool(
    state: tauri::State<'_, RuntimeAppState>,
    skillId: String,
    toolId: String,
) -> Result<ManagedSkill, String> {
    record_desktop_runtime_event(
        &state,
        "tool_started",
        "info",
        "Skill sync requested",
        json!({
            "skill_id": skillId.clone(),
            "tool_id": toolId.clone(),
        })
        .to_string(),
    )?;
    let mut store = read_store()?;
    let index = store
        .skills
        .iter()
        .position(|skill| skill.id == skillId)
        .ok_or_else(|| format!("Managed skill not found: {skillId}"))?;

    let mut skill = store.skills[index].clone();
    let target = sync_skill_record_to_tool(&skill, &toolId)?;
    skill.targets.retain(|item| item.tool != toolId);
    skill.targets.push(target.clone());
    skill
        .targets
        .sort_by(|left, right| left.tool.cmp(&right.tool));
    skill.last_sync_at = target.synced_at;
    skill.updated_at = now_ms();
    store.skills[index] = skill.clone();
    write_store(&store)?;
    record_desktop_runtime_event(
        &state,
        "tool_finished",
        "info",
        "Skill synced to tool",
        json!({
            "skill_id": skill.id,
            "tool_id": toolId,
            "targets": skill.targets,
        })
        .to_string(),
    )?;
    Ok(skill)
}

#[command]
#[allow(non_snake_case)]
pub fn unsync_skill_from_tool(
    state: tauri::State<'_, RuntimeAppState>,
    skillId: String,
    toolId: String,
) -> Result<ManagedSkill, String> {
    let mut store = read_store()?;
    let index = store
        .skills
        .iter()
        .position(|skill| skill.id == skillId)
        .ok_or_else(|| format!("Managed skill not found: {skillId}"))?;

    let mut skill = store.skills[index].clone();
    if let Some(target) = skill.targets.iter().find(|target| target.tool == toolId) {
        remove_path(Path::new(&target.target_path))?;
    }
    skill.targets.retain(|target| target.tool != toolId);
    skill.updated_at = now_ms();
    skill.last_sync_at = skill
        .targets
        .iter()
        .filter_map(|target| target.synced_at)
        .max();
    store.skills[index] = skill.clone();
    write_store(&store)?;
    record_desktop_runtime_event(
        &state,
        "tool_finished",
        "warning",
        "Skill unsynced from tool",
        json!({
            "skill_id": skill.id,
            "tool_id": toolId,
            "remaining_targets": skill.targets,
        })
        .to_string(),
    )?;
    Ok(skill)
}

#[command]
#[allow(non_snake_case)]
pub fn update_managed_skill(
    state: tauri::State<'_, RuntimeAppState>,
    skillId: String,
) -> Result<ManagedSkill, String> {
    record_desktop_runtime_event(
        &state,
        "tool_started",
        "info",
        "Managed skill update requested",
        json!({
            "skill_id": skillId.clone(),
        })
        .to_string(),
    )?;
    let mut store = read_store()?;
    let index = store
        .skills
        .iter()
        .position(|skill| skill.id == skillId)
        .ok_or_else(|| format!("Managed skill not found: {skillId}"))?;

    let mut skill = store.skills[index].clone();
    remove_path(Path::new(&skill.central_path))?;

    let refreshed_root = if skill.source_type == "git" {
        let repo_url = skill
            .source_ref
            .clone()
            .ok_or_else(|| format!("Missing git source for {}", skill.name))?;
        let clone_dir = clone_repo(&repo_url)?;
        let resolved = resolve_skill_root(&clone_dir);
        if let Ok(path) = resolved.as_ref() {
            copy_dir_recursive(path, Path::new(&skill.central_path))?;
        }
        let _ = remove_path(&clone_dir);
        resolved?
    } else {
        let source_ref = skill
            .source_ref
            .clone()
            .ok_or_else(|| format!("Missing local source for {}", skill.name))?;
        let source_root = resolve_skill_root(Path::new(&source_ref))?;
        copy_dir_recursive(&source_root, Path::new(&skill.central_path))?;
        source_root
    };

    skill.name = infer_skill_name(&refreshed_root, Some(skill.name.clone()))?;
    skill.updated_at = now_ms();
    refresh_targets(&mut skill)?;
    store.skills[index] = skill.clone();
    write_store(&store)?;
    record_desktop_runtime_event(
        &state,
        "tool_finished",
        "info",
        "Managed skill updated",
        json!({
            "skill_id": skill.id,
            "skill_name": skill.name,
            "targets": skill.targets,
        })
        .to_string(),
    )?;
    Ok(skill)
}

#[command]
#[allow(non_snake_case)]
pub fn delete_managed_skill(
    state: tauri::State<'_, RuntimeAppState>,
    skillId: String,
) -> Result<(), String> {
    let mut store = read_store()?;
    let index = store
        .skills
        .iter()
        .position(|skill| skill.id == skillId)
        .ok_or_else(|| format!("Managed skill not found: {skillId}"))?;

    let skill = store.skills.remove(index);
    for target in skill.targets {
        let _ = remove_path(Path::new(&target.target_path));
    }
    let _ = remove_path(Path::new(&skill.central_path));
    write_store(&store)?;
    record_desktop_runtime_event(
        &state,
        "security_alert",
        "warning",
        "Managed skill deleted",
        json!({
            "skill_id": skill.id,
            "skill_name": skill.name,
            "central_path": skill.central_path,
        })
        .to_string(),
    )?;
    Ok(())
}
