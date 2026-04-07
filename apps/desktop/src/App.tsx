import { Suspense, lazy, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  onAction as onNotificationAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useScanner } from "./scanner-ui/useScanner";
import type {
  AppSettings,
  FindingWithFile,
  InstalledSkillListItem,
  ManagedSkillDetailAction,
  View,
} from "./shared/appTypes";
import {
  DashboardScreen,
  QuarantineWindowScreen,
  SettingsScreen,
  Sidebar,
} from "./features/chrome/chromeScreens";
import { MarkdownPreviewScreen } from "./features/chrome/MarkdownPreviewScreen";
import { DetailScreen, ToolboxScreen } from "./features/workbench/detailToolboxScreens";
import { ScanCheckDetailWindowScreen, ScanScreen } from "./features/scan/scanScreens";
import {
  type RepositoryReportWindowPayload,
  RepositoryReportDetailScreen,
} from "./features/scan/repositoryReportDetailWindow";
import { SCREENSHOT_DATA, SCREENSHOT_SKILLS } from "./mocks/screenshotData";
import { SkillsScreen } from "./features/skills/skillsScreen";
import { ManagedSkillDetailWindowScreen } from "./features/skills/skillsUi";
import {
  REPOSITORY_SCAN_MIN_DURATION_MS,
  REPOSITORY_SCAN_PATH_KEY,
  REPOSITORY_SCAN_REQUEST_EVENT,
  DESKTOP_SHELL_OPEN_VIEW_REQUEST_EVENT,
  DESKTOP_SHELL_PREFERENCES_UPDATED_EVENT,
  RUNTIME_RISK_FOCUS_REQUEST_EVENT,
  RUNTIME_RISK_INBOX_UPDATED_EVENT,
  RUNTIME_RISK_NOTIFICATION_ACTION_TYPE,
  SKILL_ANALYSIS_UPDATED_EVENT,
  WINDOW_DRAG_BLOCK_SELECTOR,
  WINDOW_DRAG_REGION_SELECTOR,
  buildManagedSkillWindowFallback,
  buildRepositoryScanPreviewFiles,
  getAppMode,
  getScreenshotView,
  getWindowParam,
  isTauriRuntime,
  loadSettings,
  saveSettings,
} from "./shared/shared";
import { useSkillManager } from "./skills-manager/useSkillManager";
import type {
  CodexGuardAdapterStatus,
  ComponentReport,
  DesktopShellOpenViewRequest,
  DesktopShellPreferences,
  RiskCategory,
  RuntimeGuardStatus,
  RuntimeHostStatus,
  RuntimeRiskFocusRequest,
  RuntimeRiskInboxState,
  SkillReport,
} from "./types";

type RepositoryScanRequestPayload = {
  path: string;
};

type SkillAnalysisUpdatedPayload = {
  fingerprint: string;
  skillId: string | null;
  skillPath: string | null;
};

type NotificationPermissionStatus = "default" | "denied" | "granted" | "unsupported";

const LOCAL_SCAN_DISPLAY_CAP = 80;
const DASHBOARD_RUNTIME_REFRESH_INTERVAL_MS = 5_000;

type DashboardRuntimeSummary = {
  blockedThreats: number;
  detectedAgentRuntimes: number;
};

const DEFAULT_DASHBOARD_RUNTIME_SUMMARY: DashboardRuntimeSummary = {
  blockedThreats: 0,
  detectedAgentRuntimes: 0,
};

function calculateSecurityScore(
  reports: Array<{ risk_score: number }>,
  hasCompleteScanRecord: boolean,
) {
  if (reports.length === 0) {
    return hasCompleteScanRecord ? 100 : null;
  }

  return Math.max(
    12,
    Math.round(
      reports.reduce((acc, item) => acc + (100 - item.risk_score), 0) / reports.length,
    ),
  );
}

function resolveDashboardRuntimeSummary(
  guardStatus: RuntimeGuardStatus | null,
  codexGuardAdapterStatus: CodexGuardAdapterStatus | null,
  hostStatuses: RuntimeHostStatus[],
): DashboardRuntimeSummary {
  return {
    blockedThreats: guardStatus?.reachable
      ? guardStatus.total_blocked
      : codexGuardAdapterStatus?.blocked_events_total ?? 0,
    detectedAgentRuntimes: hostStatuses.filter((host) => host.detected).length,
  };
}

const LazyActivityMonitorScreen = lazy(async () => {
  const module = await import("./features/runtime/runtimeMonitorScreen");
  return { default: module.ActivityMonitorScreen };
});

function DeferredScreenFallback({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-[radial-gradient(circle_at_top_left,#ffffff_0%,#f7f9fc_44%,#f3f6fb_100%)] px-6 text-[13px] text-[#8a94a6]">
      {label}加载中...
    </div>
  );
}

export default function App() {
  const screenshotView = getScreenshotView();
  const appMode = getAppMode();
  const assetsRoute = appMode === "skills-manager";
  const standaloneActivityWindow = appMode === "activity-monitor";
  const standaloneMarkdownPreviewWindow = appMode === "markdown-preview";
  const standaloneManagedSkillDetailWindow = appMode === "managed-skill-detail";
  const standaloneQuarantineWindow = appMode === "quarantine-zone";
  const standaloneRepositoryScanWindow = appMode === "repository-scan";
  const standaloneScanCheckDetailWindow = appMode === "scan-check-detail";
  const standaloneAuxiliaryWindow =
    standaloneActivityWindow ||
    standaloneMarkdownPreviewWindow ||
    standaloneManagedSkillDetailWindow ||
    standaloneQuarantineWindow ||
    standaloneRepositoryScanWindow ||
    standaloneScanCheckDetailWindow;
  const managedSkillWindowLabel = getWindowParam("label");
  const scanCheckWindowStorageKey = getWindowParam("storageKey");
  const scanCheckWindowTitle = getWindowParam("title");
  const managedSkillWindowId = getWindowParam("skillId");
  const managedSkillWindowName = getWindowParam("skillName");
  const managedSkillWindowSourceRef = getWindowParam("sourceRef");
  const managedSkillWindowCentralPath = getWindowParam("centralPath");
  const managedSkillWindowSourceType = getWindowParam("sourceType");
  const managedSkillWindowStatus = getWindowParam("status");
  const managedSkillWindowAction = getWindowParam("action");
  const markdownPreviewLabel = getWindowParam("label");
  const markdownPreviewPath = getWindowParam("path");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const {
    data,
    loading,
    stopping,
    scanInterrupted,
    currentRunHasResult,
    error,
    repositoryScanJob,
    scan,
    scanRepository,
    stopScan,
  } = useScanner({
    storageKey: standaloneRepositoryScanWindow ? null : undefined,
    scanPaths: settings.scanPaths,
    recursiveScan: settings.recursiveScan,
    includedExtensions: settings.includedExtensions,
  });
  const {
    clearError: clearManagerError,
    error: managerError,
    loading: managerLoading,
    managedSkills,
    refresh: refreshManagedSkills,
    toolStatus,
  } = useSkillManager();
  const standaloneManagedSkillFallback = useMemo(
    () =>
      buildManagedSkillWindowFallback({
        id: managedSkillWindowId,
        name: managedSkillWindowName,
        sourceRef: managedSkillWindowSourceRef,
        centralPath: managedSkillWindowCentralPath,
        sourceType: managedSkillWindowSourceType,
        status: managedSkillWindowStatus,
      }),
    [
      managedSkillWindowCentralPath,
      managedSkillWindowId,
      managedSkillWindowName,
      managedSkillWindowSourceRef,
      managedSkillWindowSourceType,
      managedSkillWindowStatus,
    ],
  );
  const [view, setView] = useState<View>(
    assetsRoute
      ? "assets"
      : standaloneRepositoryScanWindow
        ? "scan"
        : screenshotView === "activity"
          ? "dashboard"
          : screenshotView ?? "dashboard",
  );
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [detailBackView, setDetailBackView] = useState<View>(assetsRoute ? "assets" : "dashboard");
  const [selectedPath, setSelectedPath] = useState<string | null>(
    screenshotView === "detail"
      ? SCREENSHOT_SKILLS[0]?.path ?? null
      : null,
  );
  const [progress, setProgress] = useState(0);
  const [scanPreparing, setScanPreparing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [desktopShellLoading, setDesktopShellLoading] = useState(isTauriRuntime());
  const [desktopShellPreferences, setDesktopShellPreferences] = useState<DesktopShellPreferences | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionStatus>("unsupported");
  const [runtimeRiskInbox, setRuntimeRiskInbox] = useState<RuntimeRiskInboxState | null>(null);
  const [dashboardRuntimeSummary, setDashboardRuntimeSummary] = useState<DashboardRuntimeSummary>(
    DEFAULT_DASHBOARD_RUNTIME_SUMMARY,
  );
  const [pendingRuntimeRiskFocus, setPendingRuntimeRiskFocus] = useState<RuntimeRiskFocusRequest | null>(null);
  const [dismissedRiskCardAlertId, setDismissedRiskCardAlertId] = useState<number | null>(null);
  const [repositoryScanReady, setRepositoryScanReady] = useState(!standaloneRepositoryScanWindow);
  const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false);
  const [repositoryScanTargetPath, setRepositoryScanTargetPath] = useState<string | null>(null);
  const [repositoryScanStartedAt, setRepositoryScanStartedAt] = useState<number | null>(null);
  const [repositoryScanDisplayProgress, setRepositoryScanDisplayProgress] = useState(0);
  const [repositoryScanRevealPending, setRepositoryScanRevealPending] = useState(false);
  const [repositoryScanPreviewIndex, setRepositoryScanPreviewIndex] = useState(0);
  const [repositoryReportPayload, setRepositoryReportPayload] = useState<RepositoryReportWindowPayload | null>(null);
  const [skillsAnalysisRefreshVersion, setSkillsAnalysisRefreshVersion] = useState(0);
  const repositoryScanStartedRef = useRef(false);
  const repositoryScanRequestRef = useRef<{ path: string; at: number } | null>(null);
  const latestNotifiedRiskAlertIdRef = useRef<number | null>(null);

  const systemScanBusy = loading || scanPreparing;
  const hideStaleScanData = scanPreparing || ((loading || scanInterrupted) && !currentRunHasResult);
  const effectiveData = screenshotView
    ? SCREENSHOT_DATA
    : standaloneRepositoryScanWindow && !repositoryScanReady
      ? null
      : hideStaleScanData
        ? null
        : data;
  const scanBackend = effectiveData?.summary.backend ?? "local-scanner";
  const isRepositoryScan =
    scanBackend === "repository_audit" || standaloneRepositoryScanWindow;
  const results = effectiveData?.results ?? [];
  const mcpResults = effectiveData?.mcp_results ?? [];
  const agentResults = effectiveData?.agent_results ?? [];
  const allReports = useMemo<Array<SkillReport | ComponentReport>>(
    () => [...results, ...mcpResults, ...agentResults],
    [agentResults, mcpResults, results],
  );
  const selectedSkill = results.find((item) => item.path === selectedPath) ?? null;
  const repositoryScanPreviewFiles = useMemo(
    () => buildRepositoryScanPreviewFiles(repositoryScanTargetPath, data),
    [data, repositoryScanTargetPath],
  );
  const currentRepositoryPreviewFile =
    repositoryScanJob?.currentFile
      ? repositoryScanJob.currentFile
      : repositoryScanRevealPending && repositoryScanPreviewFiles.length > 0
      ? repositoryScanPreviewFiles[0]
      : repositoryScanPreviewFiles.length > 0
      ? repositoryScanPreviewFiles[repositoryScanPreviewIndex % repositoryScanPreviewFiles.length]
      : repositoryScanTargetPath ?? "等待选择项目目录";
  const showTopErrorBanner = Boolean(
    error && !(view === "scan" && (standaloneRepositoryScanWindow || scanBackend === "repository_audit")),
  );
  const navigateToView = (nextView: View) => {
    startTransition(() => {
      setView(nextView);
    });
  };

  useEffect(() => {
    if (selectedPath && !results.some((item) => item.path === selectedPath)) {
      setSelectedPath(null);
    }
  }, [results, selectedPath]);

  useEffect(() => {
    if (standaloneActivityWindow || screenshotView === "activity") {
      return;
    }

    const timer = window.setTimeout(() => {
      void import("./features/runtime/runtimeMonitorScreen");
    }, 600);

    return () => window.clearTimeout(timer);
  }, [screenshotView, standaloneActivityWindow]);

  useEffect(() => {
    if (view !== "scan" && repositoryReportPayload) {
      setRepositoryReportPayload(null);
    }
  }, [repositoryReportPayload, view]);

  useEffect(() => {
    if (scanInterrupted) {
      return;
    }
    if (scanPreparing && !loading) {
      setProgress(0);
      return;
    }
    if (loading && currentRunHasResult) {
      setProgress((current) => Math.max(current, LOCAL_SCAN_DISPLAY_CAP));
      return;
    }
    if (!loading) {
      setProgress(data ? 100 : 0);
      return;
    }
    setProgress(0);
    const timer = window.setInterval(() => {
      setProgress((current) => Math.min(current + (current < 64 ? 7 : 2), LOCAL_SCAN_DISPLAY_CAP));
    }, 220);
    return () => window.clearInterval(timer);
  }, [currentRunHasResult, data, loading, scanInterrupted, scanPreparing]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!managerError) {
      return;
    }
    setToast(managerError);
    clearManagerError();
  }, [clearManagerError, managerError]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | null = null;

    void listen<SkillAnalysisUpdatedPayload>(SKILL_ANALYSIS_UPDATED_EVENT, () => {
      if (!disposed) {
        setSkillsAnalysisRefreshVersion((current) => current + 1);
      }
    }).then((unlisten) => {
      if (disposed) {
        void unlisten();
        return;
      }
      cleanup = unlisten;
    });

    return () => {
      disposed = true;
      if (cleanup) {
        void cleanup();
      }
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const currentWindow = getCurrentWindow();
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.closest(WINDOW_DRAG_BLOCK_SELECTOR)) {
        return;
      }

      if (!target.closest(WINDOW_DRAG_REGION_SELECTOR)) {
        return;
      }

      void currentWindow.startDragging().catch(() => {
        // Ignore native drag-region handling failures in non-window contexts.
      });
    };

    window.addEventListener("mousedown", handleMouseDown, true);
    return () => window.removeEventListener("mousedown", handleMouseDown, true);
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const refreshNotificationPermission = async () => {
    if (!isTauriRuntime()) {
      setNotificationPermission("unsupported");
      return "unsupported" as const;
    }

    try {
      const granted = await isPermissionGranted();
      const nextPermission = granted ? "granted" : (window.Notification?.permission ?? "default");
      setNotificationPermission(nextPermission);
      return nextPermission;
    } catch {
      setNotificationPermission("unsupported");
      return "unsupported" as const;
    }
  };

  const applyDesktopShellPreferenceChange = async (update: Partial<DesktopShellPreferences>) => {
    const currentPreferences = desktopShellPreferences ?? {
      enableSystemNotifications: true,
      enableForegroundRiskCard: true,
      hideToMenuBarOnClose: true,
    };
    try {
      const nextPreferences = await invoke<DesktopShellPreferences>("set_desktop_shell_preferences", {
        preferences: { ...currentPreferences, ...update },
      });
      setDesktopShellPreferences(nextPreferences);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "更新后台运行设置失败");
    }
  };

  const handleRuntimeRiskFocus = async (request: RuntimeRiskFocusRequest, markSeen: boolean) => {
    if (isTauriRuntime()) {
      try {
        const currentWindow = getCurrentWindow();
        await currentWindow.show();
        await currentWindow.setFocus();
      } catch {
        // Ignore focus restoration errors outside desktop main-window contexts.
      }
    }

    startTransition(() => {
      setView("runtime");
      setPendingRuntimeRiskFocus({
        ...request,
        requestId:
          request.requestId ?? `runtime-risk-focus-${request.alertId}-${Date.now()}`,
      });
    });

    if (!markSeen) {
      return;
    }

    try {
      const nextInbox = await invoke<RuntimeRiskInboxState>("mark_runtime_risk_inbox_seen");
      setRuntimeRiskInbox(nextInbox);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "更新风险收件箱状态失败");
    }
  };

  const requestNotificationAccess = async () => {
    if (!isTauriRuntime()) {
      setNotificationPermission("unsupported");
      return;
    }

    try {
      const permission = await requestPermission();
      setNotificationPermission(permission);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "请求通知权限失败");
    }
  };

  useEffect(() => {
    if (!isTauriRuntime() || standaloneAuxiliaryWindow) {
      setDesktopShellLoading(false);
      setNotificationPermission(isTauriRuntime() ? "default" : "unsupported");
      return;
    }

    let disposed = false;
    setDesktopShellLoading(true);

    void (async () => {
      try {
        const [preferences, inbox] = await Promise.all([
          invoke<DesktopShellPreferences>("get_desktop_shell_preferences"),
          invoke<RuntimeRiskInboxState>("get_runtime_risk_inbox_state"),
        ]);
        if (disposed) {
          return;
        }
        setDesktopShellPreferences(preferences);
        setRuntimeRiskInbox(inbox);
        latestNotifiedRiskAlertIdRef.current = inbox.latestPendingAlertId ?? null;
      } catch (error) {
        if (!disposed) {
          setToast(error instanceof Error ? error.message : "读取后台运行状态失败");
        }
      } finally {
        if (!disposed) {
          setDesktopShellLoading(false);
        }
      }
    })();

    void refreshNotificationPermission();

    return () => {
      disposed = true;
    };
  }, [standaloneAuxiliaryWindow]);

  useEffect(() => {
    if (!isTauriRuntime() || standaloneAuxiliaryWindow) {
      setDashboardRuntimeSummary(DEFAULT_DASHBOARD_RUNTIME_SUMMARY);
      return;
    }

    let disposed = false;

    const loadDashboardRuntimeSummary = async () => {
      const [guardStatus, codexGuardAdapterStatus, hostStatuses] = await Promise.all([
        invoke<RuntimeGuardStatus>("get_runtime_guard_status").catch(() => null),
        invoke<CodexGuardAdapterStatus>("get_codex_guard_adapter_status").catch(() => null),
        invoke<RuntimeHostStatus[]>("list_runtime_host_statuses").catch(() => []),
      ]);

      if (disposed) {
        return;
      }

      setDashboardRuntimeSummary(
        resolveDashboardRuntimeSummary(guardStatus, codexGuardAdapterStatus, hostStatuses),
      );
    };

    void loadDashboardRuntimeSummary();
    const timer = window.setInterval(() => {
      void loadDashboardRuntimeSummary();
    }, DASHBOARD_RUNTIME_REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [standaloneAuxiliaryWindow]);

  useEffect(() => {
    if (!isTauriRuntime() || standaloneAuxiliaryWindow) {
      return;
    }

    let disposed = false;
    const cleanups: Array<() => void> = [];

    const bindEvents = async () => {
      const preferenceCleanup = await listen<DesktopShellPreferences>(
        DESKTOP_SHELL_PREFERENCES_UPDATED_EVENT,
        (event) => {
          if (!disposed) {
            setDesktopShellPreferences(event.payload);
          }
        },
      );
      cleanups.push(preferenceCleanup);

      const inboxCleanup = await listen<RuntimeRiskInboxState>(
        RUNTIME_RISK_INBOX_UPDATED_EVENT,
        (event) => {
          if (!disposed) {
            setRuntimeRiskInbox(event.payload);
          }
        },
      );
      cleanups.push(inboxCleanup);

      const openViewCleanup = await listen<DesktopShellOpenViewRequest>(
        DESKTOP_SHELL_OPEN_VIEW_REQUEST_EVENT,
        (event) => {
          if (!disposed) {
            startTransition(() => {
              setView(event.payload.view);
            });
          }
        },
      );
      cleanups.push(openViewCleanup);

      const riskFocusCleanup = await listen<RuntimeRiskFocusRequest>(
        RUNTIME_RISK_FOCUS_REQUEST_EVENT,
        (event) => {
          if (disposed || !event.payload?.sessionId || typeof event.payload.alertId !== "number") {
            return;
          }
          void handleRuntimeRiskFocus(event.payload, false);
        },
      );
      cleanups.push(riskFocusCleanup);
    };

    void bindEvents();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [standaloneAuxiliaryWindow]);

  useEffect(() => {
    if (!isTauriRuntime() || standaloneAuxiliaryWindow) {
      return;
    }

    let disposed = false;
    let cleanup: { unregister: () => Promise<void> } | null = null;

    void registerActionTypes([
      {
        id: RUNTIME_RISK_NOTIFICATION_ACTION_TYPE,
        actions: [
          {
            id: "view-details",
            title: "查看详情",
            foreground: true,
          },
        ],
      },
    ]).catch((error) => {
      console.warn("[notification] failed to register runtime risk action type", error);
    });

    void onNotificationAction((notification) => {
      const extra = notification.extra ?? {};
      const sessionId = typeof extra.sessionId === "string" ? extra.sessionId : null;
      const alertId =
        typeof extra.alertId === "number"
          ? extra.alertId
          : typeof extra.alertId === "string"
            ? Number.parseInt(extra.alertId, 10)
            : NaN;
      if (disposed || !sessionId || !Number.isFinite(alertId)) {
        return;
      }
      void handleRuntimeRiskFocus(
        {
          requestId:
            typeof extra.requestId === "string" ? extra.requestId : `notification-${alertId}-${Date.now()}`,
          sessionId,
          alertId,
          tab: extra.tab === "blocked" ? "blocked" : "alerts",
        },
        true,
      );
    }).then((unlisten) => {
      if (disposed) {
        void unlisten.unregister();
        return;
      }
      cleanup = unlisten;
    });

    return () => {
      disposed = true;
      if (cleanup) {
        void cleanup.unregister();
      }
    };
  }, [standaloneAuxiliaryWindow]);

  useEffect(() => {
    if (
      !isTauriRuntime() ||
      notificationPermission !== "granted" ||
      !desktopShellPreferences?.enableSystemNotifications
    ) {
      return;
    }

    const latestAlert = runtimeRiskInbox?.latestAlert ?? null;
    const latestPendingAlertId = runtimeRiskInbox?.latestPendingAlertId ?? null;
    if (!latestAlert || latestPendingAlertId === null) {
      return;
    }

    if (latestNotifiedRiskAlertIdRef.current === latestPendingAlertId) {
      return;
    }

    latestNotifiedRiskAlertIdRef.current = latestPendingAlertId;
    sendNotification({
      title: latestAlert.blocked ? "检测到已拦截风险操作" : "检测到运行时风险",
      body: `${latestAlert.title}${latestAlert.reason ? ` · ${latestAlert.reason}` : ""}`,
      actionTypeId: RUNTIME_RISK_NOTIFICATION_ACTION_TYPE,
      autoCancel: true,
      extra: {
        requestId: `notification-${latestAlert.id}-${Date.now()}`,
        sessionId: latestAlert.session_id,
        alertId: latestAlert.id,
        tab: latestAlert.blocked ? "blocked" : "alerts",
      },
    });
  }, [desktopShellPreferences?.enableSystemNotifications, notificationPermission, runtimeRiskInbox]);

  useEffect(() => {
    if (!repositoryScanStartedAt || repositoryScanReady || !repositoryScanJob) {
      return;
    }

    setRepositoryScanDisplayProgress((current) =>
      Math.max(current, repositoryScanJob.status === "completed" ? 100 : repositoryScanJob.progress),
    );
  }, [repositoryScanJob, repositoryScanReady, repositoryScanStartedAt]);

  useEffect(() => {
    if (
      !repositoryScanStartedAt ||
      repositoryScanReady ||
      repositoryScanRevealPending ||
      repositoryScanJob?.currentFile
    ) {
      return;
    }

    setRepositoryScanPreviewIndex(0);
    const fileTimer = window.setInterval(() => {
      setRepositoryScanPreviewIndex((current) =>
        repositoryScanPreviewFiles.length > 0 ? (current + 1) % repositoryScanPreviewFiles.length : 0,
      );
    }, 280);

    return () => {
      window.clearInterval(fileTimer);
    };
  }, [
    repositoryScanJob?.currentFile,
    repositoryScanPreviewFiles.length,
    repositoryScanRevealPending,
    repositoryScanReady,
    repositoryScanStartedAt,
  ]);

  const allFindings = useMemo<FindingWithFile[]>(
    () =>
      allReports.flatMap((report) =>
        report.files.flatMap((file) =>
          file.findings.map((finding) => ({
            ...finding,
            filePath: file.path,
            sourceName: report.name,
          })),
        ),
      ),
    [allReports],
  );

  const summary = useMemo(() => {
    const counts: Record<RiskCategory, number> = {
      safe: 0,
      suspicious: 0,
      high_risk: 0,
      malicious: 0,
    };

    for (const item of allReports) {
      counts[item.category] += 1;
    }

    const hasCompleteScanRecord = Boolean(effectiveData?.summary.generated_at);
    const score = calculateSecurityScore(allReports, hasCompleteScanRecord);

    return {
      totalSkills: results.length,
      score,
      counts,
      findings: allFindings.length,
      quarantined: allReports.filter((item) => item.risk_score >= 50).length,
    };
  }, [allFindings.length, allReports, effectiveData?.summary.generated_at, results]);

  const dashboardScanData = screenshotView ? SCREENSHOT_DATA : data;
  const dashboardReports = useMemo<Array<SkillReport | ComponentReport>>(
    () => [
      ...(dashboardScanData?.results ?? []),
      ...(dashboardScanData?.mcp_results ?? []),
      ...(dashboardScanData?.agent_results ?? []),
    ],
    [dashboardScanData],
  );
  const hasLastScanResult = Boolean(dashboardScanData?.summary.generated_at);
  const dashboardScore = useMemo(
    () => calculateSecurityScore(dashboardReports, hasLastScanResult),
    [dashboardReports, hasLastScanResult],
  );
  const latestScanText = dashboardScanData?.summary.generated_at
    ? new Date(dashboardScanData.summary.generated_at).toLocaleString()
    : "";
  const latestRuntimeRiskAlert = runtimeRiskInbox?.latestAlert ?? null;
  const pendingRuntimeRiskCount = runtimeRiskInbox?.pendingCount ?? 0;
  const activeRuntimeRiskCard =
    !standaloneAuxiliaryWindow &&
    desktopShellPreferences?.enableForegroundRiskCard !== false &&
    latestRuntimeRiskAlert &&
    pendingRuntimeRiskCount > 0 &&
    latestRuntimeRiskAlert.id !== dismissedRiskCardAlertId
      ? latestRuntimeRiskAlert
      : null;

  const waitForCommittedPaint = () =>
    new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });

  const shouldIgnoreRepositoryScanRequest = (path: string) => {
    const previousRequest = repositoryScanRequestRef.current;
    const now = Date.now();
    if (previousRequest && previousRequest.path === path && now - previousRequest.at < 1500) {
      return true;
    }

    repositoryScanRequestRef.current = {
      path,
      at: now,
    };
    return false;
  };

  const runScan = async () => {
    if (systemScanBusy) {
      return;
    }

    setRepositoryReportPayload(null);
    setProgress(0);
    setScanPreparing(true);
    setView("scan");
    await waitForCommittedPaint();
    try {
      await scan();
    } finally {
      setScanPreparing(false);
    }
  };

  const openLastScanResult = () => {
    if (!hasLastScanResult) {
      return;
    }

    setView("scan");
  };

  const runRepositoryScan = async (path?: string) => {
    let targetPath: string | null | undefined = path;

    if (!targetPath) {
      setRepositoryPickerOpen(true);
      try {
        targetPath = await invoke<string | null>("choose_repository_directory");
      } finally {
        setRepositoryPickerOpen(false);
      }
    }

    if (!targetPath) {
      if (standaloneRepositoryScanWindow) {
        setToast("已取消选择目录");
      }
      return null;
    }

    const startedAt = Date.now();
    setRepositoryReportPayload(null);
    setRepositoryScanRevealPending(false);
    setRepositoryScanTargetPath(targetPath);
    setRepositoryScanStartedAt(startedAt);
    setRepositoryScanDisplayProgress(6);
    setRepositoryScanPreviewIndex(0);
    setRepositoryScanReady(false);
    const response = await scanRepository(targetPath);
    if (response) {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, REPOSITORY_SCAN_MIN_DURATION_MS - elapsed);
      if (remaining > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remaining));
      }
      setRepositoryScanDisplayProgress(100);
      setRepositoryScanRevealPending(true);
      return response;
    }
    setRepositoryScanRevealPending(false);
    setRepositoryScanReady(true);
    return null;
  };

  const runRepositoryScanFromRequest = async (path: string) => {
    if (!path || shouldIgnoreRepositoryScanRequest(path)) {
      return null;
    }

    if (systemScanBusy) {
      setToast("当前扫描尚未完成，请稍候再试。");
      return null;
    }

    return runRepositoryScan(path);
  };

  const dispatchRepositoryScanRequest = async (path: string) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await emitTo<RepositoryScanRequestPayload>("repository-scan", REPOSITORY_SCAN_REQUEST_EVENT, { path });
        return;
      } catch (error) {
        if (attempt === 7) {
          console.warn("[repository-scan] failed to emit scan request to repository window", error);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
    }
  };

  const rerunCurrentScan = async () => {
    if (standaloneRepositoryScanWindow && !effectiveData) {
      await runRepositoryScan();
      return;
    }

    if (isRepositoryScan) {
      await runRepositoryScan(effectiveData?.summary.scanned_roots?.[0]);
      return;
    }

    await runScan();
  };

  const openRepositoryScanResult = () => {
    setRepositoryScanRevealPending(false);
    setRepositoryScanReady(true);
  };

  const openSkill = (path: string, nextView: View = "assets") => {
    setSelectedPath(path);
    if (nextView === "detail") {
      setDetailBackView(view);
    }
    setView(nextView);
  };

  const openRepositoryReport = (path: string) => {
    const report =
      results.find((item) => item.path === path) ??
      mcpResults.find((item) => item.path === path) ??
      agentResults.find((item) => item.path === path) ??
      null;

    if (!report) {
      setToast("没有找到这份仓库审计报告，请重新扫描后再试。");
      return;
    }

    const kind =
      results.some((item) => item.path === path)
        ? "skill"
        : mcpResults.some((item) => item.path === path)
          ? "mcp"
          : "agent";

    setRepositoryReportPayload({
      kind,
      report,
      repositoryPath: effectiveData?.summary.scanned_roots?.[0] ?? repositoryScanTargetPath ?? null,
    });
  };

  const openQuarantineWindow = async () => {
    if (!isTauriRuntime()) {
      return;
    }

    await invoke("open_quarantine_window");
  };

  const openRepositoryScanWindow = async () => {
    if (!isTauriRuntime()) {
      await runRepositoryScan();
      return;
    }

    setRepositoryPickerOpen(true);
    let targetPath: string | null = null;
    try {
      targetPath = await invoke<string | null>("choose_repository_directory");
    } finally {
      setRepositoryPickerOpen(false);
    }

    if (!targetPath) {
      return;
    }

    window.localStorage.setItem(REPOSITORY_SCAN_PATH_KEY, targetPath);
    await invoke("open_repository_scan_window");
    await dispatchRepositoryScanRequest(targetPath);
  };

  const openManagedSkillDetailWindow = async (
    skill: InstalledSkillListItem,
    action: ManagedSkillDetailAction = "view",
  ) => {
    const managedRecord = skill.managedSkill;
    const windowKey = managedRecord?.id ?? skill.id;
    const sourceRef = managedRecord?.source_ref ?? skill.primaryPath ?? null;
    const centralPath = managedRecord?.central_path ?? skill.primaryPath ?? null;
    const sourceType = managedRecord?.source_type ?? "discovered";
    const status = managedRecord?.status ?? "discovered";

    if (!isTauriRuntime()) {
      const params = new URLSearchParams({
        window: "managed-skill-detail",
        skillId: windowKey,
        skillName: skill.name,
        sourceType,
        status,
      });
      params.set("action", action);
      if (sourceRef) params.set("sourceRef", sourceRef);
      if (centralPath) params.set("centralPath", centralPath);
      const route = `/?${params.toString()}`;
      window.open(route, "_blank", "noopener,noreferrer,width=1080,height=820");
      return;
    }

    await invoke("open_managed_skill_detail_window", {
      skillId: managedRecord?.id ?? null,
      skillKey: windowKey,
      skillName: skill.name,
      sourceRef,
      centralPath,
      sourceType,
      status,
      action,
    });
  };

  const closeStandaloneWindow = async (label?: string) => {
    if (isTauriRuntime()) {
      if (label) {
        await invoke("close_window", { label });
        return;
      }

      window.close();
      return;
    }

    window.close();
  };

  if (standaloneActivityWindow || screenshotView === "activity") {
    return (
      <Suspense fallback={<DeferredScreenFallback label="运行时监控" />}>
        <LazyActivityMonitorScreen onClose={() => void closeStandaloneWindow("activity-monitor")} />
      </Suspense>
    );
  }

  if (standaloneMarkdownPreviewWindow) {
    return (
      <MarkdownPreviewScreen
        markdownPath={markdownPreviewPath}
        onClose={() => void closeStandaloneWindow(markdownPreviewLabel ?? undefined)}
      />
    );
  }

  if (standaloneQuarantineWindow) {
    return (
      <QuarantineWindowScreen
        latestScanText={latestScanText}
        onClose={() => void closeStandaloneWindow("quarantine-zone")}
        quarantined={results.filter((item) => item.risk_score >= 50)}
      />
    );
  }

  useEffect(() => {
    if (!standaloneRepositoryScanWindow || repositoryScanStartedRef.current) {
      return;
    }

    repositoryScanStartedRef.current = true;
    setView("scan");
    const pendingPath = window.localStorage.getItem(REPOSITORY_SCAN_PATH_KEY);
    if (pendingPath) {
      window.localStorage.removeItem(REPOSITORY_SCAN_PATH_KEY);
    }
    if (pendingPath) {
      void runRepositoryScanFromRequest(pendingPath);
      return;
    }
    void runRepositoryScan();
  }, [standaloneRepositoryScanWindow]);

  useEffect(() => {
    if (!standaloneRepositoryScanWindow) {
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | null = null;

    void listen<RepositoryScanRequestPayload>(REPOSITORY_SCAN_REQUEST_EVENT, (event) => {
      if (disposed || !event.payload?.path) {
        return;
      }

      void runRepositoryScanFromRequest(event.payload.path);
    }, {
      target: "repository-scan",
    }).then((unlisten) => {
      if (disposed) {
        void unlisten();
        return;
      }
      cleanup = unlisten;
    });

    return () => {
      disposed = true;
      if (cleanup) {
        void cleanup();
      }
    };
  }, [standaloneRepositoryScanWindow, systemScanBusy]);

  if (standaloneManagedSkillDetailWindow) {
    return (
      <ManagedSkillDetailWindowScreen
        loading={managerLoading}
        managedSkill={managedSkills.find((skill) => skill.id === managedSkillWindowId) ?? standaloneManagedSkillFallback}
        initialAction={managedSkillWindowAction === "analyze" ? "analyze" : "view"}
        onClose={() => void closeStandaloneWindow(managedSkillWindowLabel ?? undefined)}
      />
    );
  }

  if (standaloneScanCheckDetailWindow) {
    return (
      <ScanCheckDetailWindowScreen
        initialTitle={scanCheckWindowTitle}
        storageKey={scanCheckWindowStorageKey}
      />
    );
  }

  return (
    <main className="fixed inset-0 overflow-hidden bg-white text-[#333]">
      {toast ? (
        <div className="pointer-events-none absolute right-5 top-5 z-50 rounded-lg border border-[#d9e7ff] bg-white px-4 py-2 text-sm text-[#2f76e9] shadow-[0_10px_30px_rgba(47,118,233,0.12)]">
          {toast}
        </div>
      ) : null}
      {activeRuntimeRiskCard ? (
        <div className="absolute bottom-5 right-5 z-50 w-[360px] rounded-xl border border-[#dbe4ef] bg-white p-4 shadow-[0_20px_50px_rgba(15,23,42,0.14)]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-md px-2 py-1 text-[11px] font-semibold ${
                    activeRuntimeRiskCard.blocked
                      ? "bg-[#fff1f2] text-[#be123c]"
                      : "bg-[#eff6ff] text-[#1d4ed8]"
                  }`}
                >
                  {activeRuntimeRiskCard.blocked ? "已拦截" : "风险提示"}
                </span>
                <span className="text-[11px] text-[#6b7280]">
                  未处理 {pendingRuntimeRiskCount}
                </span>
              </div>
              <div className="mt-3 text-[14px] font-semibold text-[#111827]">
                {activeRuntimeRiskCard.title}
              </div>
              <div className="mt-1 text-[12px] leading-6 text-[#4b5563]">
                {activeRuntimeRiskCard.reason || "运行时检测到新的高风险行为，请进入详情页确认处置结果。"}
              </div>
              <div className="mt-2 truncate text-[11px] text-[#94a3b8]">
                {activeRuntimeRiskCard.workspace_path}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDismissedRiskCardAlertId(activeRuntimeRiskCard.id)}
              className="rounded-md border border-[#e5e7eb] px-2 py-1 text-[11px] font-medium text-[#6b7280] transition hover:bg-[#f9fafb] hover:text-[#111827]"
            >
              忽略
            </button>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() =>
                void handleRuntimeRiskFocus(
                  {
                    requestId: `risk-card-${activeRuntimeRiskCard.id}-${Date.now()}`,
                    sessionId: activeRuntimeRiskCard.session_id,
                    alertId: activeRuntimeRiskCard.id,
                    tab: activeRuntimeRiskCard.blocked ? "blocked" : "alerts",
                  },
                  true,
                )
              }
              className="rounded-md bg-[#111827] px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-[#1f2937]"
            >
              查看详情
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex h-full w-full overflow-hidden bg-white">
        {!standaloneRepositoryScanWindow ? (
          <Sidebar
            expanded={sidebarExpanded}
            onToggle={() => setSidebarExpanded((current) => !current)}
            view={
              view === "assets" || view === "runtime" || view === "toolbox" || view === "settings"
                ? view
                : view === "detail" && detailBackView === "assets"
                  ? "assets"
                  : "dashboard"
            }
            onChange={navigateToView}
            onOpenSettings={() => navigateToView("settings")}
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {showTopErrorBanner ? (
            <div className="border-b border-[#ebeef2] bg-[#fff5f5] px-5 py-2 text-xs text-[#cf2e2e]">
              {error}
            </div>
          ) : null}

          {view === "dashboard" ? (
            <DashboardScreen
              blockedThreats={dashboardRuntimeSummary.blockedThreats}
              detectedAgentRuntimes={dashboardRuntimeSummary.detectedAgentRuntimes}
              hasLastScan={hasLastScanResult}
              lastScanText={latestScanText}
              loading={systemScanBusy}
              onOpenActivity={() => navigateToView("runtime")}
              onOpenLastScan={openLastScanResult}
              onScan={runScan}
              score={dashboardScore}
            />
          ) : null}

          {view === "scan" ? (
            repositoryReportPayload ? (
              <RepositoryReportDetailScreen
                payload={repositoryReportPayload}
                onBack={() => setRepositoryReportPayload(null)}
              />
            ) : (
              <ScanScreen
                backend={standaloneRepositoryScanWindow ? "repository_audit" : scanBackend}
                currentRunHasResult={currentRunHasResult}
                errorMessage={error}
                findingsCount={effectiveData?.summary.findings ?? 0}
                agentFindings={effectiveData?.summary.agent_findings ?? 0}
                agentResults={agentResults}
                mcpFindings={effectiveData?.summary.mcp_findings ?? 0}
                mcpResults={mcpResults}
                loading={systemScanBusy}
                pickingDirectory={repositoryPickerOpen}
                onBack={() => {
                  if (standaloneRepositoryScanWindow) {
                    void closeStandaloneWindow("repository-scan");
                    return;
                  }
                  setView("dashboard");
                }}
                onOpenActivity={() => navigateToView("runtime")}
                onOpenDetail={(path) => {
                  if (standaloneRepositoryScanWindow || scanBackend === "repository_audit") {
                    openRepositoryReport(path);
                    return;
                  }

                  openSkill(path, "detail");
                }}
                onQuickFix={() =>
                  setToast(
                    (effectiveData?.summary.findings ?? 0) > 0
                      ? "一键修复功能即将上线。"
                      : "当前没有需要修复的问题。",
                  )
                }
                onScan={rerunCurrentScan}
                onStopScan={() => void stopScan()}
                progress={progress}
                results={results}
                scanInterrupted={scanInterrupted}
                stopping={stopping}
                scannedAgents={effectiveData?.summary.scanned_agents ?? 0}
                scannedComponents={effectiveData?.summary.scanned_components ?? results.length}
                scannedMcps={effectiveData?.summary.scanned_mcps ?? 0}
                scannedRoots={effectiveData?.summary.scanned_roots ?? []}
                skillFindings={effectiveData?.summary.skill_findings ?? allFindings.length}
                standaloneRepositoryWindow={standaloneRepositoryScanWindow}
                repositoryScanJob={repositoryScanJob}
                repositoryScanLoading={!repositoryScanReady}
                repositoryScanDisplayProgress={repositoryScanDisplayProgress}
                repositoryScanCurrentFile={currentRepositoryPreviewFile}
                repositoryScanRevealPending={repositoryScanRevealPending}
                repositoryScanTargetPath={repositoryScanTargetPath}
                onOpenRepositoryResult={openRepositoryScanResult}
              />
            )
          ) : null}

          {view === "assets" ? (
            <SkillsScreen
              analysisRefreshVersion={skillsAnalysisRefreshVersion}
              managedLoading={managerLoading}
              managedSkills={managedSkills}
              onOpenManagedSkillDetail={openManagedSkillDetailWindow}
              onRefreshManaged={() => refreshManagedSkills().catch(() => undefined)}
              recursiveScan={settings.recursiveScan}
              skillScanPaths={settings.scanPaths}
              mcpScanPaths={settings.mcpScanPaths}
              includedExtensions={settings.includedExtensions}
              toolInfos={toolStatus?.tools ?? []}
            />
          ) : null}

          {view === "detail" ? (
            <DetailScreen
              skill={selectedSkill}
              onBack={() => setView(detailBackView === "detail" ? "dashboard" : detailBackView)}
            />
          ) : null}

          {view === "toolbox" ? (
            <ToolboxScreen
              onOpenQuarantine={() => void openQuarantineWindow()}
              onRunRepositoryScan={openRepositoryScanWindow}
              quarantined={results.filter((item) => item.risk_score >= 50)}
            />
          ) : null}

          {view === "runtime" ? (
            <Suspense fallback={<DeferredScreenFallback label="运行时监控" />}>
              <LazyActivityMonitorScreen
                focusRequest={pendingRuntimeRiskFocus}
                onFocusHandled={(handledRequestId) => {
                  if (!handledRequestId) {
                    setPendingRuntimeRiskFocus(null);
                    return;
                  }
                  setPendingRuntimeRiskFocus((current) =>
                    current?.requestId === handledRequestId ? null : current,
                  );
                }}
              />
            </Suspense>
          ) : null}

          {view === "settings" ? (
            <SettingsScreen
              desktopShellLoading={desktopShellLoading}
              desktopShellPreferences={desktopShellPreferences}
              notificationPermission={notificationPermission}
              settings={settings}
              onChange={setSettings}
              onDesktopShellPreferenceChange={applyDesktopShellPreferenceChange}
              onRequestNotificationPermission={requestNotificationAccess}
            />
          ) : null}
        </div>
      </div>

    </main>
  );
}
