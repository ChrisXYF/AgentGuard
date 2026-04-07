import { startTransition, useEffect, useRef, useState } from "react";
import type {
  DiscoverySnapshot,
  RepositoryScanJobStatus,
  ScanArtifact,
  ScanResponse,
} from "../../types";
import {
  runFullScan,
  cancelFullScan,
  discoverInventory,
  startRepositoryScanJob,
  getRepositoryScanJobStatus,
  cancelRepositoryScanJob,
  type DesktopScanOptions,
} from "./client";
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
    return true;
  }
  if (typeof error === "string" && error.includes("AbortError")) {
    return true;
  }
  return false;
}

const DEFAULT_STORAGE_KEY = "agents-of-shield.latest-scan";
const SCAN_CANCELLED_MESSAGE = "SCAN_CANCELLED";
const USER_CANCELLED_MESSAGE = "扫描已终止";
const REPOSITORY_SCAN_CANCELLED_MESSAGE = "REPOSITORY_SCAN_CANCELLED";
const REPOSITORY_SCAN_POLL_INTERVAL_MS = 240;
const REPOSITORY_SCAN_MAX_POLLS = 3_600;
const MAX_STORED_SCAN_RESPONSE_LENGTH = 2_000_000;

type ScheduledStorageWrite =
  | { kind: "idle"; id: number }
  | { kind: "timeout"; id: number }
  | null;

function clearStoredScanResponse(storageKey?: string | null) {
  if (!storageKey || typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(storageKey);
}

function loadStoredScanResponse(storageKey?: string | null) {
  if (!storageKey || typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    if (raw.length > MAX_STORED_SCAN_RESPONSE_LENGTH) {
      clearStoredScanResponse(storageKey);
      return null;
    }
    return JSON.parse(raw) as ScanResponse;
  } catch {
    return null;
  }
}

function persistStoredScanResponse(response: ScanResponse, storageKey?: string | null) {
  if (!storageKey || typeof window === "undefined") {
    return;
  }

  try {
    const serialized = JSON.stringify(response);
    if (serialized.length > MAX_STORED_SCAN_RESPONSE_LENGTH) {
      clearStoredScanResponse(storageKey);
      console.warn(
        `[full-scan] skipping scan response persistence because payload is too large (${serialized.length} chars)`,
      );
      return;
    }

    window.localStorage.setItem(storageKey, serialized);
  } catch (error) {
    console.warn("[full-scan] failed to persist scan response", error);
  }
}

function cancelScheduledStorageWrite(handle: ScheduledStorageWrite) {
  if (!handle || typeof window === "undefined") {
    return;
  }

  if (handle.kind === "idle" && "cancelIdleCallback" in window) {
    window.cancelIdleCallback(handle.id);
    return;
  }

  clearTimeout(handle.id);
}

function artifactToInventory(artifact: ScanArtifact): DiscoverySnapshot {
  return {
    generated_at: artifact.generated_at,
    components: artifact.inventory.components,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return fallback;
}


export function useFullScanSession(options?: {
  storageKey?: string | null;
  scanPaths?: string[];
  recursiveScan?: boolean;
  includedExtensions?: string[];
}) {
  const storageKey = options?.storageKey ?? DEFAULT_STORAGE_KEY;
  const scanPaths = options?.scanPaths ?? [];
  const scanOptions: DesktopScanOptions = {
    recursiveScan: options?.recursiveScan ?? true,
    includedExtensions: options?.includedExtensions ?? [],
  };
  const scanPathsKey = scanPaths.join("\n");
  const scanOptionsKey = `${scanOptions.recursiveScan}:${scanOptions.includedExtensions.join(",")}`;
  const [data, setData] = useState<ScanResponse | null>(() => loadStoredScanResponse(storageKey));
  const [inventory, setInventory] = useState<DiscoverySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [scanInterrupted, setScanInterrupted] = useState(false);
  const [currentRunHasResult, setCurrentRunHasResult] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositoryScanJob, setRepositoryScanJob] = useState<RepositoryScanJobStatus | null>(null);
  const repositoryScanJobIdRef = useRef<string | null>(null);
  const storageWriteRef = useRef<ScheduledStorageWrite>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !storageKey) {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) {
        return;
      }

      setData(loadStoredScanResponse(storageKey));
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [storageKey]);

  const applyResponse = (response: ScanResponse) => {
    startTransition(() => setData(response));
    cancelScheduledStorageWrite(storageWriteRef.current);

    if (!storageKey || typeof window === "undefined") {
      storageWriteRef.current = null;
      return;
    }

    const writeResponse = () => {
      storageWriteRef.current = null;
      persistStoredScanResponse(response, storageKey);
    };

    if ("requestIdleCallback" in window) {
      storageWriteRef.current = {
        kind: "idle",
        id: window.requestIdleCallback(writeResponse, { timeout: 1_000 }),
      };
      return;
    }

    storageWriteRef.current = {
      kind: "timeout",
      id: setTimeout(writeResponse, 0),
    };
  };

  const refreshInventory = async () => {
    try {
      const snapshot = await discoverInventory(scanPaths, scanOptions);
      startTransition(() => setInventory(snapshot));
      return snapshot;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    void refreshInventory();
  }, [scanPathsKey, scanOptionsKey]);

  useEffect(
    () => () => {
      cancelScheduledStorageWrite(storageWriteRef.current);
    },
    [],
  );

  const scan = async () => {
    setLoading(true);
    setStopping(false);
    setScanInterrupted(false);
    setCurrentRunHasResult(false);
    setError(null);
    let localCompleted = false;

    try {
      const bundle = await runFullScan(scanPaths, scanOptions);
      applyResponse(bundle.local_report);
      setCurrentRunHasResult(true);
      localCompleted = true;
      startTransition(() => setInventory(artifactToInventory(bundle.full_artifact)));

      return bundle.local_report;
    } catch (scanError) {
      const cancelled =
        isAbortError(scanError) ||
        (scanError instanceof Error && scanError.message === SCAN_CANCELLED_MESSAGE);
      const message = cancelled
        ? USER_CANCELLED_MESSAGE
        : normalizeErrorMessage(scanError, "Scan failed");
      if (cancelled) {
        setScanInterrupted(true);
      }
      console.error("[full-scan] run failed", {
        currentRunHasResult: localCompleted,
        error: message,
      });
      if (!localCompleted) {
        setError(cancelled ? null : message);
      }
      return null;
    } finally {
      setStopping(false);
      setLoading(false);
    }
  };

  const scanRepository = async (path: string) => {
    startTransition(() => setData(null));
    setLoading(true);
    setStopping(false);
    setScanInterrupted(false);
    setCurrentRunHasResult(false);
    setError(null);
    setRepositoryScanJob(null);

    try {
      const job = await startRepositoryScanJob(path);
      repositoryScanJobIdRef.current = job.jobId;
      setRepositoryScanJob(job);
      let latestJob = job;

      for (let attempt = 0; attempt < REPOSITORY_SCAN_MAX_POLLS; attempt += 1) {
        setRepositoryScanJob(latestJob);
        if (latestJob.status === "completed") {
          if (!latestJob.response) {
            throw new Error("Repository scan finished without a result");
          }

          const response = latestJob.response;
          applyResponse(response);
          setCurrentRunHasResult(true);
          return response;
        }

        if (latestJob.status === "failed") {
          throw new Error(latestJob.errorMessage || "Repository scan failed");
        }

        if (latestJob.status === "cancelled") {
          throw new Error(REPOSITORY_SCAN_CANCELLED_MESSAGE);
        }

        await wait(REPOSITORY_SCAN_POLL_INTERVAL_MS);
        const nextJob = await getRepositoryScanJobStatus(job.jobId);
        if (!nextJob) {
          throw new Error("Repository scan job disappeared");
        }
        latestJob = nextJob;
      }

      throw new Error("Timed out waiting for repository scan result");
    } catch (scanError) {
      const cancelled =
        scanError instanceof Error && scanError.message === REPOSITORY_SCAN_CANCELLED_MESSAGE;
      if (cancelled) {
        setScanInterrupted(true);
        setError(null);
        return null;
      }

      setError(normalizeErrorMessage(scanError, "Repository scan failed"));
      return null;
    } finally {
      repositoryScanJobIdRef.current = null;
      setStopping(false);
      setLoading(false);
    }
  };

  const stopScan = async () => {
    if (!loading || stopping) {
      return false;
    }

    setStopping(true);
    const repositoryScanJobId = repositoryScanJobIdRef.current;
    if (repositoryScanJobId) {
      try {
        return await cancelRepositoryScanJob(repositoryScanJobId);
      } catch {
        return false;
      } finally {
        setStopping(false);
      }
    }

    try {
      return await cancelFullScan();
    } catch {
      return false;
    }
  };

  return {
    data,
    inventory,
    loading,
    stopping,
    scanInterrupted,
    currentRunHasResult,
    error,
    repositoryScanJob,
    scan,
    scanRepository,
    stopScan,
    refreshInventory,
  };
}
