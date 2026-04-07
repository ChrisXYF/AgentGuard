import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { View } from "./appTypes";
import { isMarkdownPath } from "./pathUtils";

export const DRAG_REGION_STYLE = { WebkitAppRegion: "drag" } as CSSProperties;
export const NO_DRAG_REGION_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;
export const WINDOW_DRAG_REGION_SELECTOR = "[data-tauri-drag-region]";
export const WINDOW_DRAG_BLOCK_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "a[href]",
  "summary",
  "label",
  "[role='button']",
  "[contenteditable='true']",
  "[data-window-drag-disabled='true']",
].join(", ");

export const REPOSITORY_SCAN_PATH_KEY = "agents-of-shield.repository-scan-path";
export const REPOSITORY_SCAN_REQUEST_EVENT = "agents-of-shield:repository-scan-request";
export const REPOSITORY_SCAN_MIN_DURATION_MS = 9000;
export const SKILL_ANALYSIS_UPDATED_EVENT = "agents-of-shield:skill-analysis-updated";
export const DESKTOP_SHELL_OPEN_VIEW_REQUEST_EVENT = "desktop-shell-open-view-request";
export const DESKTOP_SHELL_PREFERENCES_UPDATED_EVENT = "desktop-shell-preferences-updated";
export const RUNTIME_RISK_FOCUS_REQUEST_EVENT = "runtime-risk-focus-request";
export const RUNTIME_RISK_INBOX_UPDATED_EVENT = "runtime-risk-inbox-updated";
export const RUNTIME_RISK_NOTIFICATION_ACTION_TYPE = "runtime-risk-details";

export async function openExternalUrl(url: string) {
  if (isTauriRuntime()) {
    await invoke("open_external_url", { url });
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

export async function openLocalPath(path: string) {
  if (isTauriRuntime()) {
    await invoke("open_local_path", { path });
    return;
  }

  window.open(path, "_blank", "noopener,noreferrer");
}

export async function openMarkdownPreview(path: string) {
  if (isTauriRuntime()) {
    await invoke("open_markdown_preview_window", { path });
    return;
  }

  await openLocalPath(path);
}

export async function openRelatedFile(path: string) {
  if (isMarkdownPath(path)) {
    await openMarkdownPreview(path);
    return;
  }

  await openLocalPath(path);
}

export function getScreenshotView(): View | "activity" | null {
  if (typeof window === "undefined") {
    return null;
  }

  const mode = new URLSearchParams(window.location.search).get("screenshot");
  if (mode === "quarantine") {
    return "toolbox";
  }
  if (mode === "skills") {
    return "assets";
  }
  if (
    mode === "dashboard" ||
    mode === "assets" ||
    mode === "detail" ||
    mode === "toolbox" ||
    mode === "activity" ||
    mode === "settings"
  ) {
    return mode;
  }

  return null;
}

export function getWindowParam(name: string) {
  if (typeof window === "undefined") {
    return null;
  }

  return new URLSearchParams(window.location.search).get(name);
}

export function getAppMode() {
  return getWindowParam("window") ?? "main";
}

export function isTauriRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(
    (window as { __TAURI__?: unknown }).__TAURI__ ||
      (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}
