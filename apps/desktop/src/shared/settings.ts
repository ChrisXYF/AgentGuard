import type { AppSettings } from "./appTypes";
import { normalizePathForLookup } from "./pathUtils";

const DEFAULT_SKILL_SCAN_PATHS = [
  "~/.openclaw/skills",
  "~/.agents/skills",
  "~/.cline/plugins",
  "~/.codex/skills",
  "~/.claude/skills",
];

const DEFAULT_MCP_SCAN_PATHS = [
  "~/.openclaw",
  "~/.agents",
  "~/.cline",
  "~/.codex",
  "~/.claude",
];

const DEFAULT_SKILL_SCAN_PATH_LOOKUP = new Set(
  DEFAULT_SKILL_SCAN_PATHS.map((path) => normalizePathForLookup(path)),
);

export const DEFAULT_SETTINGS: AppSettings = {
  scanPaths: DEFAULT_SKILL_SCAN_PATHS,
  mcpScanPaths: DEFAULT_MCP_SCAN_PATHS,
  recursiveScan: true,
  realtimeProtection: true,
  autoScanOnLaunch: true,
  autoScanInterval: "daily",
  autoQuarantine: true,
  logRetentionDays: "30",
  backend: "local_scanner",
  aiExplanation: false,
  includedExtensions: [".py", ".js", ".ts", ".sh", ".md"],
};

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem("agents-of-shield.settings");
    if (!raw) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const normalizeConfiguredPaths = (value: unknown) =>
      Array.isArray(value)
        ? value.filter(
            (path, index, paths) => typeof path === "string" && path.trim() && paths.indexOf(path) === index,
          )
        : null;

    const scanPaths = normalizeConfiguredPaths(parsed.scanPaths) ?? DEFAULT_SETTINGS.scanPaths;
    const rawMcpScanPaths = normalizeConfiguredPaths(parsed.mcpScanPaths);
    const hasLegacySkillRootsInMcpPaths =
      rawMcpScanPaths?.some((path) => DEFAULT_SKILL_SCAN_PATH_LOOKUP.has(normalizePathForLookup(path))) ?? false;
    const migratedMcpScanPaths = rawMcpScanPaths?.filter(
      (path) => !DEFAULT_SKILL_SCAN_PATH_LOOKUP.has(normalizePathForLookup(path)),
    );
    const mcpScanPaths = rawMcpScanPaths
      ? migratedMcpScanPaths && migratedMcpScanPaths.length === 0 && hasLegacySkillRootsInMcpPaths
        ? DEFAULT_SETTINGS.mcpScanPaths
        : migratedMcpScanPaths ?? []
      : DEFAULT_SETTINGS.mcpScanPaths;

    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      scanPaths,
      mcpScanPaths,
      includedExtensions: Array.isArray(parsed.includedExtensions)
        ? parsed.includedExtensions
        : DEFAULT_SETTINGS.includedExtensions,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem("agents-of-shield.settings", JSON.stringify(settings));
}
