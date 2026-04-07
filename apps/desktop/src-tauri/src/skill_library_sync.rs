use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use base64::Engine;
use discovery_engine::{
    default_included_extensions, normalize_included_extensions, path_matches_included_extensions,
    ComponentKind, DiscoverySnapshot,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::command;
use walkdir::WalkDir;

const SKILL_LIBRARY_FINGERPRINT_VERSION: &str = "skill-content-v1";

#[derive(Debug, Clone, Serialize)]
pub struct LocalSkillPackageFile {
    pub path: String,
    pub sha256: String,
    pub content_base64: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalSkillPackage {
    pub name: String,
    pub path: String,
    pub fingerprint: String,
    pub file_count: usize,
    pub files: Vec<LocalSkillPackageFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillFingerprintRef {
    pub component_id: String,
    pub name: String,
    pub path: String,
    pub root: Option<String>,
    pub fingerprint: String,
    pub file_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanOptionsInput {
    pub recursive_scan: Option<bool>,
    pub included_extensions: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
struct SkillPackageOptions {
    recursive_scan: bool,
    included_extensions: BTreeSet<String>,
}

#[command]
#[allow(non_snake_case)]
pub fn collect_local_skill_packages(
    skillPaths: Vec<String>,
    scanOptions: Option<SkillScanOptionsInput>,
) -> Result<Vec<LocalSkillPackage>, String> {
    let options = build_skill_package_options(scanOptions.as_ref());
    let mut packages = skillPaths
        .into_iter()
        .map(|skill_path| collect_local_skill_package(&skill_path, &options))
        .collect::<Result<Vec<_>, String>>()?;
    packages.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(packages)
}

pub fn collect_skill_fingerprint_refs(
    snapshot: &DiscoverySnapshot,
    scan_options: Option<&SkillScanOptionsInput>,
) -> Vec<SkillFingerprintRef> {
    let options = build_skill_package_options(scan_options);
    let mut refs = Vec::new();
    let mut seen_paths = BTreeSet::new();

    for component in &snapshot.components {
        if component.kind != ComponentKind::Skill || !seen_paths.insert(component.path.clone()) {
            continue;
        }

        let root = component
            .metadata
            .get("root")
            .and_then(|value| value.as_str())
            .map(str::to_string);

        match collect_local_skill_package(&component.path, &options) {
            Ok(package) => refs.push(SkillFingerprintRef {
                component_id: component.id.clone(),
                name: component.name.clone(),
                path: component.path.clone(),
                root,
                fingerprint: package.fingerprint,
                file_count: package.file_count,
            }),
            Err(error) => {
                eprintln!(
                    "[skill-library-sync] failed to collect fingerprint for skill '{}': {}",
                    component.path, error
                );
            }
        }
    }

    refs.sort_by(|left, right| left.path.cmp(&right.path));
    refs
}

fn collect_local_skill_package(
    skill_path: &str,
    options: &SkillPackageOptions,
) -> Result<LocalSkillPackage, String> {
    let resolved_root = PathBuf::from(skill_path)
        .canonicalize()
        .map_err(|error| format!("failed to resolve skill path: {error}"))?;
    if !resolved_root.is_dir() {
        return Err(format!(
            "skill path is not a directory: {}",
            resolved_root.display()
        ));
    }

    let mut walker = WalkDir::new(&resolved_root);
    if !options.recursive_scan {
        walker = walker.max_depth(1);
    }

    let mut files = walker
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| is_supported_skill_sync_file(entry.path(), options))
        .map(|entry| {
            let full_path = entry.into_path();
            let relative_path = full_path
                .strip_prefix(&resolved_root)
                .map_err(|error| format!("failed to build relative path: {error}"))?;
            let normalized_relative_path = normalize_relative_path(relative_path)
                .ok_or_else(|| format!("invalid skill file path: {}", relative_path.display()))?;
            let bytes = fs::read(&full_path).map_err(|error| {
                format!(
                    "failed to read skill file '{}': {error}",
                    full_path.display()
                )
            })?;
            Ok(LocalSkillPackageFile {
                path: normalized_relative_path,
                sha256: sha256_bytes(&bytes),
                content_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    files.sort_by(|left, right| left.path.cmp(&right.path));
    let fingerprint = build_skill_content_fingerprint(&files)?;
    let name = resolved_root
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("unknown-skill")
        .to_string();

    Ok(LocalSkillPackage {
        name,
        path: skill_path.to_string(),
        fingerprint,
        file_count: files.len(),
        files,
    })
}

fn build_skill_content_fingerprint(files: &[LocalSkillPackageFile]) -> Result<String, String> {
    let manifest = SkillFingerprintManifest {
        files: files
            .iter()
            .filter(|file| should_include_in_fingerprint(&file.path))
            .map(|file| SkillFingerprintManifestFile {
                path: file.path.clone(),
                sha256: file.sha256.clone(),
            })
            .collect(),
        version: SKILL_LIBRARY_FINGERPRINT_VERSION.to_string(),
    };
    let serialized = serde_json::to_string(&manifest)
        .map_err(|error| format!("failed to serialize skill fingerprint manifest: {error}"))?;
    Ok(sha256_bytes(serialized.as_bytes()))
}

fn should_include_in_fingerprint(path: &str) -> bool {
    let normalized = path.trim_start_matches('/').trim_start_matches("./");
    if normalized.is_empty() {
        return false;
    }

    let basename = normalized
        .split('/')
        .next_back()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if basename.is_empty() || basename == "_meta.json" {
        return false;
    }

    let extension = basename
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .unwrap_or_default();
    matches!(
        extension,
        "md" | "txt"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "py"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "sh"
            | "bash"
            | "rb"
            | "csv"
            | "sql"
            | "schema"
    )
}

fn is_supported_skill_sync_file(path: &Path, options: &SkillPackageOptions) -> bool {
    path_matches_included_extensions(path, &options.included_extensions)
}

fn build_skill_package_options(
    scan_options: Option<&SkillScanOptionsInput>,
) -> SkillPackageOptions {
    let mut options = SkillPackageOptions {
        recursive_scan: true,
        included_extensions: default_included_extensions(),
    };

    if let Some(scan_options) = scan_options {
        if let Some(recursive_scan) = scan_options.recursive_scan {
            options.recursive_scan = recursive_scan;
        }
        if let Some(included_extensions) = scan_options.included_extensions.as_ref() {
            options.included_extensions = normalize_included_extensions(included_extensions);
        }
    }

    options
}

fn normalize_relative_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for part in path.components() {
        let value = part.as_os_str().to_str()?;
        if value.is_empty() || value == "." {
            continue;
        }
        if value == ".." {
            return None;
        }
        parts.push(value);
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[derive(Debug, Serialize)]
struct SkillFingerprintManifest {
    files: Vec<SkillFingerprintManifestFile>,
    version: String,
}

#[derive(Debug, Serialize)]
struct SkillFingerprintManifestFile {
    path: String,
    sha256: String,
}
