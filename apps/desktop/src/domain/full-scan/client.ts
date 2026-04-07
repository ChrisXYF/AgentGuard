import { invoke } from "@tauri-apps/api/core";
import type { DiscoverySnapshot, FullScanBundle, RepositoryScanJobStatus, ScanResponse } from "../../types";

export type DesktopScanOptions = {
  recursiveScan: boolean;
  includedExtensions: string[];
};

export async function discoverInventory(scanPaths: string[], scanOptions?: DesktopScanOptions) {
  return scanPaths.length > 0
    ? invoke<DiscoverySnapshot>("discover_inventory_for_paths", { scanPaths, scanOptions })
    : invoke<DiscoverySnapshot>("discover_inventory", { scanOptions });
}

export async function discoverLocalMcpServers(scanPaths: string[]) {
  return invoke<DiscoverySnapshot>("discover_local_mcp_servers", { scanPaths });
}

export async function runFullScan(scanPaths: string[], scanOptions?: DesktopScanOptions) {
  return scanPaths.length > 0
    ? invoke<FullScanBundle>("run_full_scan", { scanPaths, scanOptions })
    : invoke<FullScanBundle>("run_full_scan", { scanOptions });
}

export async function cancelFullScan() {
  return invoke<boolean>("cancel_full_scan");
}

export async function scanRepository(path: string) {
  return invoke<ScanResponse>("scan_repository", { path });
}

export async function startRepositoryScanJob(path: string) {
  const job = await invoke<RepositoryScanJobStatus | Record<string, unknown>>("start_repository_scan_job", { path });
  return normalizeRepositoryScanJobStatus(job);
}

export async function getRepositoryScanJobStatus(jobId: string) {
  const job = await invoke<RepositoryScanJobStatus | Record<string, unknown> | null>("get_repository_scan_job_status", { jobId });
  return job ? normalizeRepositoryScanJobStatus(job) : null;
}

export async function cancelRepositoryScanJob(jobId: string) {
  return invoke<boolean>("cancel_repository_scan_job", { jobId });
}

function normalizeRepositoryScanJobStatus(job: RepositoryScanJobStatus | Record<string, unknown>): RepositoryScanJobStatus {
  const record = job as Record<string, unknown>;

  return {
    jobId: String(record.jobId ?? record.job_id ?? ""),
    path: String(record.path ?? ""),
    status: String(record.status ?? "queued") as RepositoryScanJobStatus["status"],
    stage: String(record.stage ?? "queued"),
    progress: Number(record.progress ?? 0),
    currentFile:
      typeof record.currentFile === "string"
        ? record.currentFile
        : typeof record.current_file === "string"
          ? record.current_file
          : null,
    scannedFiles: Number(record.scannedFiles ?? record.scanned_files ?? 0),
    totalFiles: Number(record.totalFiles ?? record.total_files ?? 0),
    findingsCount: Number(record.findingsCount ?? record.findings_count ?? 0),
    highestSeverity: Number(record.highestSeverity ?? record.highest_severity ?? 0),
    stageFindings:
      (record.stageFindings as Record<string, number> | undefined) ??
      (record.stage_findings as Record<string, number> | undefined) ??
      {},
    errorMessage:
      typeof record.errorMessage === "string"
        ? record.errorMessage
        : typeof record.error_message === "string"
          ? record.error_message
          : null,
    response: (record.response as ScanResponse | null | undefined) ?? null,
    startedAt: String(record.startedAt ?? record.started_at ?? ""),
    finishedAt:
      typeof record.finishedAt === "string"
        ? record.finishedAt
        : typeof record.finished_at === "string"
          ? record.finished_at
          : null,
  };
}
