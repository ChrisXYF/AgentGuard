use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use discovery_engine::{
    ComponentKind, ComponentRelationship, DiscoveredComponent, DiscoverySnapshot, DiscoverySource,
};
use serde_json::{Map as JsonMap, Value as JsonValue};
use tauri::command;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Clone, Copy)]
struct KnownMcpConfig {
    client_key: &'static str,
    client_label: &'static str,
    relative_path: &'static str,
}

#[derive(Clone, Debug)]
struct McpConfigTarget {
    client_key: String,
    client_label: String,
    config_path: PathBuf,
}

#[derive(Clone, Debug)]
struct ParsedMcpServer {
    name: String,
    section: String,
    config: JsonMap<String, JsonValue>,
}

const KNOWN_MCP_CONFIGS: &[KnownMcpConfig] = &[
    KnownMcpConfig {
        client_key: "codex",
        client_label: "Codex",
        relative_path: ".codex/config.toml",
    },
    KnownMcpConfig {
        client_key: "claude",
        client_label: "Claude",
        relative_path: ".claude/settings.json",
    },
    KnownMcpConfig {
        client_key: "claude",
        client_label: "Claude",
        relative_path: ".config/claude/settings.json",
    },
    KnownMcpConfig {
        client_key: "cursor",
        client_label: "Cursor",
        relative_path: ".cursor/mcp.json",
    },
    KnownMcpConfig {
        client_key: "cline",
        client_label: "Cline",
        relative_path: ".cline/mcp.json",
    },
    KnownMcpConfig {
        client_key: "cline",
        client_label: "Cline",
        relative_path: ".cline/settings.json",
    },
    KnownMcpConfig {
        client_key: "openclaw",
        client_label: "OpenClaw",
        relative_path: ".openclaw/config.json",
    },
    KnownMcpConfig {
        client_key: "openclaw",
        client_label: "OpenClaw",
        relative_path: ".openclaw/mcp.json",
    },
    KnownMcpConfig {
        client_key: "agents",
        client_label: "Agents Runtime",
        relative_path: ".agents/config.json",
    },
    KnownMcpConfig {
        client_key: "agents",
        client_label: "Agents Runtime",
        relative_path: ".config/agents/config.json",
    },
    KnownMcpConfig {
        client_key: "opencode",
        client_label: "OpenCode",
        relative_path: ".config/opencode/opencode.json",
    },
    KnownMcpConfig {
        client_key: "opencode",
        client_label: "OpenCode",
        relative_path: ".config/opencode/mcp.json",
    },
    KnownMcpConfig {
        client_key: "windsurf",
        client_label: "Windsurf",
        relative_path: ".codeium/windsurf/mcp.json",
    },
];

const WORKSPACE_MCP_CONFIGS: &[&str] = &[
    ".cursor/mcp.json",
    ".vscode/mcp.json",
    ".mcp.json",
    "mcp.json",
    "mcp.yaml",
    "mcp.yml",
    "mcp-config.json",
    "mcp-config.yaml",
    "mcp-config.yml",
    "cline_mcp_settings.json",
    "docker-mcp.json",
    "docker-mcp.yaml",
    "docker-mcp.yml",
];

const SERVER_CONFIG_KEYS: &[&str] = &[
    "args",
    "command",
    "cwd",
    "description",
    "enabled",
    "endpoint",
    "env",
    "headers",
    "transport",
    "type",
    "url",
];

#[command]
#[allow(non_snake_case)]
pub fn discover_local_mcp_servers(scanPaths: Vec<String>) -> Result<DiscoverySnapshot, String> {
    let components = discover_local_mcp_components(&scanPaths);

    Ok(DiscoverySnapshot {
        generated_at: OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "unknown".to_string()),
        components,
    })
}

fn discover_local_mcp_components(scan_paths: &[String]) -> Vec<DiscoveredComponent> {
    let mut targets = known_mcp_config_targets();
    targets.extend(workspace_mcp_config_targets(scan_paths));

    let mut seen_targets = BTreeSet::new();
    let mut components = Vec::new();

    for target in targets {
        let target_key = format!("{}:{}", target.client_key, target.config_path.display());
        if !seen_targets.insert(target_key) {
            continue;
        }

        let parsed = match parse_mcp_config_file(&target.config_path) {
            Ok(value) => value,
            Err(error) => {
                eprintln!(
                    "failed to parse MCP config {}: {error}",
                    target.config_path.display()
                );
                continue;
            }
        };

        let servers = extract_mcp_servers(&parsed, &target.config_path);
        for server in servers {
            components.push(to_component(&target, server));
        }
    }

    components.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.id.cmp(&right.id))
    });
    components
}

fn known_mcp_config_targets() -> Vec<McpConfigTarget> {
    let mut targets = Vec::new();
    let Some(home) = home_path() else {
        return targets;
    };

    for config in KNOWN_MCP_CONFIGS {
        let config_path = home.join(config.relative_path);
        if config_path.exists() {
            targets.push(McpConfigTarget {
                client_key: config.client_key.to_string(),
                client_label: config.client_label.to_string(),
                config_path,
            });
        }
    }

    targets
}

fn workspace_mcp_config_targets(scan_paths: &[String]) -> Vec<McpConfigTarget> {
    let mut targets = Vec::new();

    for scan_path in scan_paths {
        let root = expand_home_path(scan_path);
        if !root.exists() || !root.is_dir() {
            continue;
        }

        for relative_path in WORKSPACE_MCP_CONFIGS {
            let config_path = root.join(relative_path);
            if config_path.exists() {
                targets.push(McpConfigTarget {
                    client_key: "workspace".to_string(),
                    client_label: "Workspace".to_string(),
                    config_path,
                });
            }
        }
    }

    targets
}

fn home_path() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn expand_home_path(path: &str) -> PathBuf {
    if path == "~" {
        return home_path().unwrap_or_else(|| PathBuf::from(path));
    }

    if let Some(stripped) = path.strip_prefix("~/") {
        return home_path()
            .map(|home| home.join(stripped))
            .unwrap_or_else(|| PathBuf::from(path));
    }

    PathBuf::from(path)
}

fn parse_mcp_config_file(path: &Path) -> Result<JsonValue, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "toml" => {
            let value: toml::Value = toml::from_str(&raw).map_err(|error| error.to_string())?;
            serde_json::to_value(value).map_err(|error| error.to_string())
        }
        "yaml" | "yml" => serde_yaml::from_str(&raw).map_err(|error| error.to_string()),
        _ => serde_json::from_str(&raw).map_err(|error| error.to_string()),
    }
}

fn extract_mcp_servers(value: &JsonValue, config_path: &Path) -> Vec<ParsedMcpServer> {
    let mut results = Vec::new();
    let mut seen = BTreeSet::new();

    if is_opencode_config(config_path) {
        if let Some(mcp_object) = value
            .as_object()
            .and_then(|object| object.get("mcp"))
            .and_then(JsonValue::as_object)
        {
            collect_server_registry(mcp_object, "mcp", &mut results, &mut seen);
        }
    }

    collect_server_registries(value, &mut results, &mut seen);
    results
}

fn is_opencode_config(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("opencode.json"))
        .unwrap_or(false)
}

fn collect_server_registries(
    value: &JsonValue,
    results: &mut Vec<ParsedMcpServer>,
    seen: &mut BTreeSet<String>,
) {
    match value {
        JsonValue::Object(object) => {
            for (key, child) in object {
                match key.as_str() {
                    "mcpServers" | "mcp_servers" => {
                        if let Some(server_object) = child.as_object() {
                            collect_server_registry(server_object, key, results, seen);
                        }
                    }
                    "mcp" => {
                        if let Some(mcp_object) = child.as_object() {
                            if let Some(servers_value) = mcp_object.get("servers") {
                                if let Some(server_object) = servers_value.as_object() {
                                    collect_server_registry(
                                        server_object,
                                        "mcp.servers",
                                        results,
                                        seen,
                                    );
                                }
                            }

                            if looks_like_server_registry(mcp_object) {
                                collect_server_registry(mcp_object, "mcp", results, seen);
                            }
                        }
                    }
                    _ => {}
                }

                collect_server_registries(child, results, seen);
            }
        }
        JsonValue::Array(items) => {
            for item in items {
                collect_server_registries(item, results, seen);
            }
        }
        _ => {}
    }
}

fn collect_server_registry(
    servers: &JsonMap<String, JsonValue>,
    section: &str,
    results: &mut Vec<ParsedMcpServer>,
    seen: &mut BTreeSet<String>,
) {
    for (name, server_value) in servers {
        let Some(server_object) = server_value.as_object() else {
            continue;
        };
        if !looks_like_server_config(server_object) {
            continue;
        }

        let fingerprint = format!(
            "{}:{}:{}",
            section,
            name,
            serde_json::to_string(server_value).unwrap_or_default()
        );
        if !seen.insert(fingerprint) {
            continue;
        }

        results.push(ParsedMcpServer {
            name: name.to_string(),
            section: section.to_string(),
            config: server_object.clone(),
        });
    }
}

fn looks_like_server_registry(object: &JsonMap<String, JsonValue>) -> bool {
    object.iter().any(|(key, value)| {
        !SERVER_CONFIG_KEYS.contains(&key.as_str())
            && value
                .as_object()
                .map(looks_like_server_config)
                .unwrap_or(false)
    })
}

fn looks_like_server_config(object: &JsonMap<String, JsonValue>) -> bool {
    SERVER_CONFIG_KEYS
        .iter()
        .any(|key| object.contains_key(*key))
}

fn to_component(target: &McpConfigTarget, server: ParsedMcpServer) -> DiscoveredComponent {
    let config_path = target.config_path.display().to_string();
    let enabled = server
        .config
        .get("enabled")
        .and_then(JsonValue::as_bool)
        .unwrap_or(true);
    let transport = infer_transport(&server.config);
    let description = server
        .config
        .get("description")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| describe_server(&server.config, transport.as_deref()));

    let (command, args) = extract_command_and_args(&server.config);
    let url = extract_string_value(&server.config, &["url", "endpoint"]);
    let cwd = extract_string_value(&server.config, &["cwd"]);
    let env_keys = extract_object_keys(&server.config, &["env"]);
    let header_keys = extract_object_keys(&server.config, &["headers"]);

    let mut metadata = JsonMap::new();
    metadata.insert(
        "client".to_string(),
        JsonValue::String(target.client_key.clone()),
    );
    metadata.insert(
        "client_label".to_string(),
        JsonValue::String(target.client_label.clone()),
    );
    metadata.insert(
        "config_path".to_string(),
        JsonValue::String(config_path.clone()),
    );
    metadata.insert(
        "section".to_string(),
        JsonValue::String(server.section.clone()),
    );
    metadata.insert("enabled".to_string(), JsonValue::Bool(enabled));
    metadata.insert(
        "server_name".to_string(),
        JsonValue::String(server.name.clone()),
    );
    if let Some(transport) = transport.clone() {
        metadata.insert("transport".to_string(), JsonValue::String(transport));
    }
    if let Some(command) = command {
        metadata.insert("command".to_string(), JsonValue::String(command));
    }
    if !args.is_empty() {
        metadata.insert(
            "args".to_string(),
            JsonValue::Array(args.into_iter().map(JsonValue::String).collect()),
        );
    }
    if let Some(url) = url {
        metadata.insert("url".to_string(), JsonValue::String(url));
    }
    if let Some(cwd) = cwd {
        metadata.insert("cwd".to_string(), JsonValue::String(cwd));
    }
    if !env_keys.is_empty() {
        metadata.insert(
            "env_keys".to_string(),
            JsonValue::Array(env_keys.into_iter().map(JsonValue::String).collect()),
        );
    }
    if !header_keys.is_empty() {
        metadata.insert(
            "header_keys".to_string(),
            JsonValue::Array(header_keys.into_iter().map(JsonValue::String).collect()),
        );
    }

    DiscoveredComponent {
        id: local_mcp_component_id(&target.client_key, &server.name, &target.config_path),
        kind: ComponentKind::McpServer,
        name: server.name,
        source: DiscoverySource::ConfigFile,
        path: config_path.clone(),
        description,
        metadata: JsonValue::Object(metadata),
        relationships: vec![
            ComponentRelationship {
                relation: "defined_in".to_string(),
                target_id: config_path,
            },
            ComponentRelationship {
                relation: "client".to_string(),
                target_id: target.client_label.clone(),
            },
        ],
    }
}

fn local_mcp_component_id(client_key: &str, server_name: &str, config_path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    client_key.hash(&mut hasher);
    server_name.to_ascii_lowercase().hash(&mut hasher);
    config_path.hash(&mut hasher);
    format!("local_mcp_server_{:x}", hasher.finish())
}

fn infer_transport(config: &JsonMap<String, JsonValue>) -> Option<String> {
    if let Some(value) = extract_string_value(config, &["transport", "type"]) {
        return Some(value);
    }

    if extract_string_value(config, &["url", "endpoint"]).is_some() {
        return Some("http".to_string());
    }

    if config.contains_key("command") {
        return Some("stdio".to_string());
    }

    None
}

fn describe_server(config: &JsonMap<String, JsonValue>, transport: Option<&str>) -> Option<String> {
    if let Some(url) = extract_string_value(config, &["url", "endpoint"]) {
        return Some(format!("Remote MCP server endpoint: {url}"));
    }

    let (command, args) = extract_command_and_args(config);
    if let Some(command) = command {
        let rendered_args = if args.is_empty() {
            command
        } else {
            format!("{command} {}", args.join(" "))
        };
        return Some(match transport {
            Some(value) if !value.is_empty() => {
                format!("Local MCP server via {value}: {rendered_args}")
            }
            _ => format!("Local MCP server command: {rendered_args}"),
        });
    }

    transport.map(|value| format!("MCP server transport: {value}"))
}

fn extract_command_and_args(config: &JsonMap<String, JsonValue>) -> (Option<String>, Vec<String>) {
    match config.get("command") {
        Some(JsonValue::String(value)) => (
            Some(value.clone()),
            extract_string_array(config.get("args")),
        ),
        Some(JsonValue::Array(values)) => {
            let tokens = values
                .iter()
                .filter_map(JsonValue::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            let command = tokens.first().cloned();
            let args = if tokens.len() > 1 {
                tokens[1..].to_vec()
            } else {
                Vec::new()
            };
            (command, args)
        }
        _ => (None, extract_string_array(config.get("args"))),
    }
}

fn extract_string_array(value: Option<&JsonValue>) -> Vec<String> {
    value
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn extract_string_value(config: &JsonMap<String, JsonValue>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        config
            .get(*key)
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn extract_object_keys(config: &JsonMap<String, JsonValue>, keys: &[&str]) -> Vec<String> {
    let mut values = config
        .iter()
        .filter_map(|(key, value)| {
            if !keys.contains(&key.as_str()) {
                return None;
            }
            value
                .as_object()
                .map(|object| object.keys().cloned().collect::<Vec<_>>())
        })
        .flatten()
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_codex_style_toml_servers() {
        let parsed = serde_json::to_value(
            toml::from_str::<toml::Value>(
                r#"
                [mcp_servers.playwright]
                command = "npx"
                args = ["@playwright/mcp@latest"]
                "#,
            )
            .expect("valid toml"),
        )
        .expect("serializable toml");

        let servers = extract_mcp_servers(&parsed, Path::new("/tmp/config.toml"));
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "playwright");
        assert_eq!(
            servers[0].config.get("command").and_then(JsonValue::as_str),
            Some("npx")
        );
    }

    #[test]
    fn extracts_opencode_style_json_servers() {
        let parsed = serde_json::from_str::<JsonValue>(
            r#"
            {
              "mcp": {
                "pencil": {
                  "command": [
                    "/tmp/pencil-server",
                    "--app",
                    "antigravity"
                  ],
                  "enabled": true,
                  "type": "local"
                }
              }
            }
            "#,
        )
        .expect("valid json");

        let servers = extract_mcp_servers(&parsed, Path::new("/tmp/opencode.json"));
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "pencil");
        assert_eq!(
            servers[0].config.get("type").and_then(JsonValue::as_str),
            Some("local")
        );
    }
}
