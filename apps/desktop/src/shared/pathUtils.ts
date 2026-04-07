import type { ScanBackend } from "./appTypes";
import type { ToolInfo } from "../types";

export function backendLabel(backend: ScanBackend) {
  if (backend === "local_scanner") return "local-scanner";
  if (backend === "repository_audit") return "repository-audit";
  return backend;
}

export function toolLabel(tools: ToolInfo[], toolId: string) {
  return tools.find((tool) => tool.key === toolId)?.label ?? toolId;
}

export function basename(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function dirname(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

export function normalizePathForLookup(value?: string | null) {
  if (!value) {
    return "";
  }

  return value
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function toolInfoForSkillRoot(rootOrPath: string | null, toolInfos: ToolInfo[]) {
  const normalized = normalizePathForLookup(rootOrPath);
  if (!normalized) {
    return null;
  }

  return (
    toolInfos.find((tool) => {
      const toolRoot = normalizePathForLookup(tool.skills_dir);
      return (
        normalized === toolRoot ||
        normalized.startsWith(`${toolRoot}/`) ||
        toolRoot.startsWith(`${normalized}/`)
      );
    }) ?? null
  );
}

export function normalizeSkillLookupKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isHttpUrl(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function isMarkdownPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "markdown" || ext === "mdown" || ext === "mkd";
}

export function fileType(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "py") return "Python 脚本";
  if (ext === "sh") return "Shell 脚本";
  if (ext === "js") return "JavaScript";
  if (ext === "ts") return "TypeScript";
  if (ext === "json") return "JSON 数据";
  if (isMarkdownPath(path)) return "Markdown";
  return "未知";
}
