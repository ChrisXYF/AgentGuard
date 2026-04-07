import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { flushSync } from "react-dom";
import type {
  CodexGuardAdapterStatus,
  RuntimeRiskFocusRequest,
  RuntimeEvent,
  RuntimeGuardStatus,
  RuntimeGuardInterventionResult,
  RuntimeHostStatus,
  RuntimeIngestConfig,
  RuntimeSecurityAlert,
  RuntimeSession,
  RuntimeToolStat,
} from "../../types";
import { DRAG_REGION_STYLE, NO_DRAG_REGION_STYLE, getWindowParam } from "../../shared/shared";

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];
const EMPTY_RUNTIME_EVENT_SUMMARY: { items: Array<{ label: string; value: string }>; body: string } = {
  items: [],
  body: "",
};
const RUNTIME_EVENT_PAGE_SIZE = 10;
const RUNTIME_TOOL_PAGE_SIZE = 10;
const RUNTIME_ALERT_PAGE_SIZE = 8;
const USER_INTERACTION_AUTO_REFRESH_PAUSE_MS = 1200;

type RuntimeTab = "overview" | "protection" | "sessions" | "alerts";
type RuntimeSessionFeed = "all" | "observed" | "guard";
type GuardActionIntent = "start" | "stop" | null;
type RuntimeRefreshDetailLevel = "summary" | "full";

export function ActivityMonitorScreen({
  focusRequest,
  onFocusHandled,
  onClose,
}: {
  focusRequest?: RuntimeRiskFocusRequest | null;
  onFocusHandled?: (requestId?: string) => void;
  onClose?: () => void;
}) {
  const hasStandaloneChrome = Boolean(onClose);
  const initialMode = getWindowParam("mode");
  const initialTab = getWindowParam("tab");
  const initialFeed = getWindowParam("feed");
  const initialSessionId = getWindowParam("sessionId");
  const initialAlertId = parseOptionalInt(getWindowParam("alertId"));
  const [activeTab, setActiveTab] = useState<RuntimeTab>(() => resolveInitialRuntimeTab(initialMode, initialTab));
  const [sessionFeed, setSessionFeed] = useState<RuntimeSessionFeed>(
    initialFeed === "observed" || initialFeed === "guard" ? initialFeed : "all",
  );
  const [collapsedOverview, setCollapsedOverview] = useState(false);
  const [eventDetailsExpanded, setEventDetailsExpanded] = useState<Record<number, boolean>>({});
  const [alertDetailsExpanded, setAlertDetailsExpanded] = useState<Record<number, boolean>>({});
  const [eventViewMode, setEventViewMode] = useState<"summary" | "list">("summary");
  const [sessionSearch, setSessionSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | string>("all");
  const [riskFilter, setRiskFilter] = useState<"all" | "low" | "medium" | "high">("all");
  const [toolSearch, setToolSearch] = useState("");
  const [toolHealthFilter, setToolHealthFilter] = useState<"all" | "healthy" | "needs-review">("all");
  const [alertSearch, setAlertSearch] = useState("");
  const [alertBlockedFilter, setAlertBlockedFilter] = useState<"all" | "blocked" | "unblocked">("all");
  const [eventTypeFilter, setEventTypeFilter] = useState<"all" | "model" | "tool" | "security">("all");
  const [eventSearch, setEventSearch] = useState("");
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [ingestConfig, setIngestConfig] = useState<RuntimeIngestConfig | null>(null);
  const [guardStatus, setGuardStatus] = useState<RuntimeGuardStatus | null>(null);
  const [guardActionPending, setGuardActionPending] = useState(false);
  const [guardActionIntent, setGuardActionIntent] = useState<GuardActionIntent>(null);
  const [guardError, setGuardError] = useState<string | null>(null);
  const [codexGuardAdapterStatus, setCodexGuardAdapterStatus] = useState<CodexGuardAdapterStatus | null>(null);
  const [hostStatuses, setHostStatuses] = useState<RuntimeHostStatus[]>([]);
  const [softStopPending, setSoftStopPending] = useState(false);
  const [observedSessions, setObservedSessions] = useState<RuntimeSession[]>([]);
  const [guardSessions, setGuardSessions] = useState<RuntimeSession[]>([]);
  const [toolStats, setToolStats] = useState<RuntimeToolStat[]>([]);
  const [securityAlerts, setSecurityAlerts] = useState<RuntimeSecurityAlert[]>([]);
  const [blockedAlerts, setBlockedAlerts] = useState<RuntimeSecurityAlert[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [targetedEventId, setTargetedEventId] = useState<number | null>(null);
  const [copiedAlertId, setCopiedAlertId] = useState<number | null>(null);
  const [selectedAlertId, setSelectedAlertId] = useState<number | null>(null);
  const [interventionPending, setInterventionPending] = useState(false);
  const [interventionResult, setInterventionResult] = useState<RuntimeGuardInterventionResult | null>(null);
  const [eventPage, setEventPage] = useState(1);
  const [toolPage, setToolPage] = useState(1);
  const [alertPage, setAlertPage] = useState(1);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const deferredTaskIdsRef = useRef<number[]>([]);
  const tabHydrationRequestIdRef = useRef(0);
  const lastHandledFocusRequestIdRef = useRef<string | null>(null);
  const lastUserInteractionAtRef = useRef(0);

  const isOverviewTab = activeTab === "overview";
  const isSessionTab = activeTab === "sessions";
  const isAlertsTab = activeTab === "alerts";
  const isProtectionTab = activeTab === "protection";

  const sessionSearchQuery = sessionSearch.trim().toLowerCase();
  const toolSearchQuery = toolSearch.trim().toLowerCase();
  const alertSearchQuery = alertSearch.trim().toLowerCase();
  const eventSearchQuery = eventSearch.trim().toLowerCase();

  const mergedSessions = useMemo(
    () => mergeRuntimeSessions(observedSessions, guardSessions),
    [guardSessions, observedSessions],
  );
  const observedSessionIdSet = useMemo(
    () => new Set(observedSessions.map((session) => session.id)),
    [observedSessions],
  );
  const activeSessions = useMemo(
    () => {
      if (sessionFeed === "observed") return observedSessions;
      if (sessionFeed === "guard") return guardSessions;
      return mergedSessions.filter((session) => observedSessionIdSet.has(session.id));
    },
    [guardSessions, mergedSessions, observedSessionIdSet, observedSessions, sessionFeed],
  );

  const availableSources = useMemo(
    () =>
      Array.from(
        new Set([
          ...observedSessions.map((session) => session.source),
          ...guardSessions.map((session) => session.source),
          ...securityAlerts.map((alert) => alert.source),
          ...blockedAlerts.map((alert) => alert.source),
        ]),
      ).sort(),
    [blockedAlerts, guardSessions, observedSessions, securityAlerts],
  );

  const filteredSessions = useMemo(
    () =>
      activeSessions.filter((session) => {
        if (sourceFilter !== "all" && session.source !== sourceFilter) return false;
        if (riskFilter !== "all" && session.risk_level !== riskFilter) return false;
        if (!sessionSearchQuery) return true;
        return [
          session.summary,
          session.workspace_path,
          session.source,
          formatRuntimeSourceLabel(session.source),
        ]
          .join(" ")
          .toLowerCase()
          .includes(sessionSearchQuery);
      }),
    [activeSessions, riskFilter, sessionSearchQuery, sourceFilter],
  );

  const selectedSession = useMemo(
    () => filteredSessions.find((session) => session.id === selectedSessionId) ?? null,
    [filteredSessions, selectedSessionId],
  );
  const selectedSessionFeed = useMemo(
    () =>
      selectedSession
        ? resolveSessionFeed(selectedSession.id, sessionFeed, observedSessions, guardSessions)
        : sessionFeed === "all"
          ? "observed"
          : sessionFeed,
    [guardSessions, observedSessions, selectedSession, sessionFeed],
  );

  const filteredEvents = useMemo(() => {
    if (!isSessionTab) return EMPTY_RUNTIME_EVENTS;
    return events.filter((event) => {
      if (eventTypeFilter !== "all" && runtimeEventCategory(event) !== eventTypeFilter) return false;
      if (!eventSearchQuery) return true;
      return [event.title, event.event_type, event.severity, event.details_json].join(" ").toLowerCase().includes(eventSearchQuery);
    });
  }, [eventSearchQuery, eventTypeFilter, events, isSessionTab]);

  const deferredFilteredEvents = useDeferredValue(filteredEvents);
  const eventPageCount = Math.max(1, Math.ceil(deferredFilteredEvents.length / RUNTIME_EVENT_PAGE_SIZE));
  const pagedEvents = useMemo(() => {
    const pageStart = (eventPage - 1) * RUNTIME_EVENT_PAGE_SIZE;
    return deferredFilteredEvents.slice(pageStart, pageStart + RUNTIME_EVENT_PAGE_SIZE);
  }, [deferredFilteredEvents, eventPage]);

  const filteredToolStats = useMemo(
    () =>
      toolStats.filter((tool) => {
        if (toolHealthFilter === "healthy" && tool.failure_calls > 0) return false;
        if (toolHealthFilter === "needs-review" && tool.failure_calls === 0) return false;
        if (!toolSearchQuery) return true;
        return tool.tool_name.toLowerCase().includes(toolSearchQuery);
      }),
    [toolHealthFilter, toolSearchQuery, toolStats],
  );
  const deferredFilteredToolStats = useDeferredValue(filteredToolStats);
  const toolPageCount = Math.max(1, Math.ceil(deferredFilteredToolStats.length / RUNTIME_TOOL_PAGE_SIZE));
  const pagedToolStats = useMemo(() => {
    const pageStart = (toolPage - 1) * RUNTIME_TOOL_PAGE_SIZE;
    return deferredFilteredToolStats.slice(pageStart, pageStart + RUNTIME_TOOL_PAGE_SIZE);
  }, [deferredFilteredToolStats, toolPage]);

  const mergedAlerts = useMemo(
    () => mergeRuntimeAlerts(securityAlerts, blockedAlerts),
    [blockedAlerts, securityAlerts],
  );

  const alertFeed = useMemo(
    () =>
      mergedAlerts.filter((alert) => {
        if (sourceFilter !== "all" && alert.source !== sourceFilter) return false;
        if (riskFilter !== "all" && alert.severity !== riskFilter && !(riskFilter === "high" && alert.severity === "critical")) return false;
        if (alertBlockedFilter === "blocked" && !alert.blocked) return false;
        if (alertBlockedFilter === "unblocked" && alert.blocked) return false;
        if (!alertSearchQuery) return true;
        return [alert.title, alert.alert_type, alert.resource, alert.action, alert.workspace_path, alert.source]
          .join(" ")
          .toLowerCase()
          .includes(alertSearchQuery);
      }),
    [alertBlockedFilter, alertSearchQuery, mergedAlerts, riskFilter, sourceFilter],
  );
  const alertPageCount = Math.max(1, Math.ceil(alertFeed.length / RUNTIME_ALERT_PAGE_SIZE));
  const pagedAlertFeed = useMemo(() => {
    const pageStart = (alertPage - 1) * RUNTIME_ALERT_PAGE_SIZE;
    return alertFeed.slice(pageStart, pageStart + RUNTIME_ALERT_PAGE_SIZE);
  }, [alertFeed, alertPage]);
  const selectedAlert = useMemo(
    () => alertFeed.find((alert) => alert.id === selectedAlertId) ?? alertFeed[0] ?? null,
    [alertFeed, selectedAlertId],
  );
  const selectedAlertSupportsIntervention = useMemo(
    () => (selectedAlert ? guardAlertSupportsManualIntervention(selectedAlert) : false),
    [selectedAlert],
  );

  const toolSummary = useMemo(
    () => ({
      tools: filteredToolStats.length,
      calls: filteredToolStats.reduce((sum, tool) => sum + tool.total_calls, 0),
      successes: filteredToolStats.reduce((sum, tool) => sum + tool.success_calls, 0),
      failures: filteredToolStats.reduce((sum, tool) => sum + tool.failure_calls, 0),
      avgLatency:
        filteredToolStats.length === 0 ? 0 : filteredToolStats.reduce((sum, tool) => sum + tool.avg_latency_ms, 0) / filteredToolStats.length,
    }),
    [filteredToolStats],
  );
  const toolInsights = useMemo(() => {
    const byCalls = [...filteredToolStats].sort((left, right) => right.total_calls - left.total_calls);
    const byLatency = [...filteredToolStats].sort((left, right) => right.avg_latency_ms - left.avg_latency_ms);
    const byPeakLatency = [...filteredToolStats].sort((left, right) => right.max_latency_ms - left.max_latency_ms);
    const byRisk = [...filteredToolStats].sort(
      (left, right) =>
        toolFailureRate(right) - toolFailureRate(left) ||
        right.failure_calls - left.failure_calls ||
        right.avg_latency_ms - left.avg_latency_ms,
    );
    const failureHotspots = byRisk.filter((tool) => tool.failure_calls > 0);
    const slowTools = byLatency.filter((tool) => tool.avg_latency_ms >= 1000);

    return {
      busiest: byCalls[0] ?? null,
      slowest: byLatency[0] ?? null,
      peakiest: byPeakLatency[0] ?? null,
      riskiest: failureHotspots[0] ?? null,
      hotTools: byCalls.slice(0, 5),
      failureHotspots: failureHotspots.slice(0, 5),
      slowTools: slowTools.slice(0, 5),
      failingToolsCount: failureHotspots.length,
      slowToolsCount: slowTools.length,
      successRate: toolSummary.calls > 0 ? toolSummary.successes / toolSummary.calls : 1,
    };
  }, [filteredToolStats, toolSummary.calls, toolSummary.successes]);

  const alertSummary = useMemo(
    () => ({
      alerts: mergedAlerts.length,
      critical: mergedAlerts.filter((alert) => alert.severity === "critical").length,
      blocked: mergedAlerts.filter((alert) => alert.blocked).length,
      sources: new Set(mergedAlerts.map((alert) => alert.source)).size,
    }),
    [mergedAlerts],
  );
  const recentProtectionEvents = useMemo(
    () => mergedAlerts.slice(0, 6),
    [mergedAlerts],
  );
  const highRiskSessions = useMemo(
    () => mergedSessions.filter((session) => session.risk_level === "high" || session.risk_level === "critical").slice(0, 5),
    [mergedSessions],
  );
  const overviewSummary = useMemo(
    () => ({
      sessions: mergedSessions.length,
      toolCalls: mergedSessions.reduce((sum, session) => sum + session.tool_calls, 0),
      avgToolLatency:
        toolStats.reduce((sum, tool) => sum + tool.total_calls, 0) === 0
          ? 0
          : toolStats.reduce((sum, tool) => sum + tool.avg_latency_ms * tool.total_calls, 0) /
            toolStats.reduce((sum, tool) => sum + tool.total_calls, 0),
      alerts: mergedAlerts.length,
      blocked: mergedAlerts.filter((alert) => alert.blocked).length,
      activeHosts: hostStatuses.filter((host) => host.detected).length,
    }),
    [hostStatuses, mergedAlerts, mergedSessions, toolStats],
  );

  const runtimeSummary = useMemo(
    () => ({
      sessions: filteredSessions.length,
      tokens: filteredSessions.reduce((sum, session) => sum + session.total_input_tokens + session.total_output_tokens, 0),
      toolCalls: filteredSessions.reduce((sum, session) => sum + session.tool_calls, 0),
      alerts: filteredSessions.reduce((sum, session) => sum + session.security_events, 0),
    }),
    [filteredSessions],
  );

  const shouldPauseAutoRefresh = () => {
    if (document.hidden) {
      return true;
    }
    return Date.now() - lastUserInteractionAtRef.current < USER_INTERACTION_AUTO_REFRESH_PAUSE_MS;
  };

  const loadObservedSessions = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) {
      setRuntimeLoading(true);
      setRuntimeError(null);
    }

    try {
      const runtimeSessions = await invoke<RuntimeSession[]>("list_runtime_sessions", { limit: 200 });
      startTransition(() => {
        setObservedSessions((current) => (areRuntimeSessionsEqual(current, runtimeSessions) ? current : runtimeSessions));
        if (activeTab === "sessions" && sessionFeed === "observed") {
          setSelectedSessionId((current) =>
            current && runtimeSessions.some((session) => session.id === current) ? current : runtimeSessions[0]?.id ?? null,
          );
        }
      });
    } catch (error) {
      if (!silent) {
        setRuntimeError(error instanceof Error ? error.message : "加载运行时会话失败");
      }
    } finally {
      if (!silent) {
        setRuntimeLoading(false);
      }
    }
  };

  const loadGuardSessions = async ({ silent = false, preferredSessionId = null }: { silent?: boolean; preferredSessionId?: string | null } = {}) => {
    if (!silent) {
      setRuntimeLoading(true);
      setRuntimeError(null);
    }

    try {
      const runtimeSessions = await invoke<RuntimeSession[]>("list_runtime_guard_sessions", { limit: 200 });
      const preferredExists = preferredSessionId
        ? runtimeSessions.some((session) => session.id === preferredSessionId)
        : false;
      startTransition(() => {
        setGuardSessions((current) => (areRuntimeSessionsEqual(current, runtimeSessions) ? current : runtimeSessions));
        if (activeTab === "sessions" && sessionFeed === "guard") {
          setSelectedSessionId((current) =>
            preferredExists
              ? preferredSessionId
              : current && runtimeSessions.some((session) => session.id === current)
                ? current
                : runtimeSessions[0]?.id ?? null,
          );
        } else if (preferredExists) {
          setSelectedSessionId(preferredSessionId);
        }
      });
      if (preferredSessionId && !preferredExists) {
        setRuntimeError("未找到该告警对应的 Guard session。");
      }
    } catch (error) {
      if (!silent) {
        setRuntimeError(error instanceof Error ? error.message : "加载防护会话失败");
      }
      startTransition(() => {
        setGuardSessions([]);
      });
    } finally {
      if (!silent) {
        setRuntimeLoading(false);
      }
    }
  };

  const loadIngestConfig = async () => {
    try {
      const config = await invoke<RuntimeIngestConfig>("get_runtime_ingest_config");
      setIngestConfig((current) => (areRuntimeIngestConfigsEqual(current, config) ? current : config));
    } catch {
      setIngestConfig((current) => (current === null ? current : null));
    }
  };

  const loadGuardStatus = async (
    { silent = false, detail = "full" }: { silent?: boolean; detail?: RuntimeRefreshDetailLevel } = {},
  ) => {
    try {
      const status = await invoke<RuntimeGuardStatus>("get_runtime_guard_status");
      startTransition(() => {
        setGuardStatus((current) => (areRuntimeGuardStatusesEqual(current, status, detail) ? current : status));
        if (detail === "full") {
          setGuardError((current) => (current === (status.error ?? null) ? current : status.error ?? null));
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载实时防护状态失败";
      startTransition(() => {
        setGuardStatus((current) => (current === null ? current : null));
        if (detail === "full") {
          setGuardError((current) => (current === message ? current : message));
        }
      });
    }
  };

  const loadCodexGuardAdapterStatus = async ({ detail = "full" }: { detail?: RuntimeRefreshDetailLevel } = {}) => {
    try {
      const status = await invoke<CodexGuardAdapterStatus>("get_codex_guard_adapter_status");
      startTransition(() => {
        setCodexGuardAdapterStatus((current) => (areCodexGuardAdapterStatusesEqual(current, status, detail) ? current : status));
      });
    } catch {
      setCodexGuardAdapterStatus((current) => (current === null ? current : null));
    }
  };

  const loadHostStatuses = async ({ detail = "full" }: { detail?: RuntimeRefreshDetailLevel } = {}) => {
    try {
      const statuses = await invoke<RuntimeHostStatus[]>("list_runtime_host_statuses");
      startTransition(() => {
        setHostStatuses((current) => (areRuntimeHostStatusesEqual(current, statuses, detail) ? current : statuses));
      });
    } catch {
      setHostStatuses((current) => (current.length === 0 ? current : []));
    }
  };

  const loadToolStats = async () => {
    try {
      const stats = await invoke<RuntimeToolStat[]>("list_runtime_tool_stats", { limit: 100 });
      startTransition(() => {
        setToolStats((current) => (areRuntimeToolStatsEqual(current, stats) ? current : stats));
      });
    } catch {
      startTransition(() => {
        setToolStats((current) => (current.length === 0 ? current : []));
      });
    }
  };

  const loadGuardAlerts = async () => {
    try {
      const [alerts, blocked] = await Promise.all([
        invoke<RuntimeSecurityAlert[]>("list_runtime_guard_alerts", { limit: 64 }),
        invoke<RuntimeSecurityAlert[]>("list_runtime_guard_blocked", { limit: 64 }),
      ]);
      startTransition(() => {
        setSecurityAlerts((current) => (areRuntimeAlertsEqual(current, alerts) ? current : alerts));
        setBlockedAlerts((current) => (areRuntimeAlertsEqual(current, blocked) ? current : blocked));
      });
    } catch {
      startTransition(() => {
        setSecurityAlerts((current) => (current.length === 0 ? current : []));
        setBlockedAlerts((current) => (current.length === 0 ? current : []));
      });
    }
  };

  const loadEvents = async (sessionId: string, feed: RuntimeSessionFeed, { silent = false }: { silent?: boolean } = {}) => {
    if (!silent) {
      setEventsLoading(true);
    }

    try {
      const runtimeEvents = await invoke<RuntimeEvent[]>(
        feed === "guard" ? "list_runtime_guard_session_events" : "list_runtime_events",
        { sessionId },
      );
      startTransition(() => {
        setEvents((current) => {
          if (
            current.length === runtimeEvents.length &&
            current.every((event, index) => {
              const nextEvent = runtimeEvents[index];
              return nextEvent && event.id === nextEvent.id;
            })
          ) {
            return current;
          }
          return runtimeEvents;
        });
      });
    } catch (error) {
      if (!silent) {
        setRuntimeError(error instanceof Error ? error.message : "加载运行时事件失败");
      }
    } finally {
      if (!silent) {
        setEventsLoading(false);
      }
    }
  };

  const clearDeferredLoads = () => {
    deferredTaskIdsRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    deferredTaskIdsRef.current = [];
  };

  const cancelPendingTabHydration = () => {
    tabHydrationRequestIdRef.current += 1;
    clearDeferredLoads();
  };

  const scheduleDeferredLoad = (requestId: number, task: () => void, delay = 0) => {
    const timerId = window.setTimeout(() => {
      deferredTaskIdsRef.current = deferredTaskIdsRef.current.filter((currentId) => currentId !== timerId);
      if (tabHydrationRequestIdRef.current !== requestId) {
        return;
      }
      task();
    }, delay);

    deferredTaskIdsRef.current.push(timerId);
  };

  const hydrateTabData = async (
    nextTab: RuntimeTab,
    { waitForPaint = false }: { waitForPaint?: boolean } = {},
  ) => {
    cancelPendingTabHydration();
    const requestId = tabHydrationRequestIdRef.current;

    if (waitForPaint) {
      await waitForNextPaint();
      if (tabHydrationRequestIdRef.current !== requestId) {
        return;
      }
    }

    void loadIngestConfig();

    if (nextTab === "overview") {
      void loadObservedSessions({ silent: true });

      scheduleDeferredLoad(requestId, () => {
        void loadGuardSessions({ silent: true });
        void loadGuardStatus({ silent: true, detail: "summary" });
      });
      scheduleDeferredLoad(requestId, () => {
        void loadGuardAlerts();
      }, 90);
      scheduleDeferredLoad(requestId, () => {
        void loadToolStats();
        void loadCodexGuardAdapterStatus({ detail: "summary" });
        void loadHostStatuses({ detail: "summary" });
      }, 180);
      return;
    }

    if (nextTab === "sessions") {
      void loadObservedSessions();

      scheduleDeferredLoad(requestId, () => {
        void loadGuardSessions({ silent: true });
        void loadGuardStatus({ silent: true });
      }, 90);
      scheduleDeferredLoad(requestId, () => {
        void loadGuardAlerts();
      }, 180);
      return;
    }

    if (nextTab === "alerts") {
      void loadGuardAlerts();

      scheduleDeferredLoad(requestId, () => {
        void loadGuardStatus({ silent: true });
      }, 90);
      return;
    }

    void loadGuardStatus();

    scheduleDeferredLoad(requestId, () => {
      void loadGuardAlerts();
      void loadGuardSessions({ silent: true });
    });
    scheduleDeferredLoad(requestId, () => {
      void loadCodexGuardAdapterStatus();
      void loadHostStatuses();
    }, 90);
  };

  const switchActiveTab = (nextTab: RuntimeTab) => {
    if (nextTab === activeTab) return;
    startTransition(() => {
      setActiveTab(nextTab);
      if (nextTab === "sessions") {
        setSessionFeed("all");
      }
      if (nextTab !== "sessions") {
        setTargetedEventId(null);
      }
    });
    void hydrateTabData(nextTab, { waitForPaint: true });
  };

  const handleOpenAlertTimeline = async (alert: RuntimeSecurityAlert) => {
    startTransition(() => {
      setActiveTab("sessions");
      setSessionFeed("guard");
      setSelectedSessionId(alert.session_id);
      setTargetedEventId(alert.id);
      setCollapsedOverview(false);
      setEventViewMode("summary");
      setEventTypeFilter("all");
      setEventSearch("");
    });
    await loadGuardSessions({ preferredSessionId: alert.session_id });
  };

  const focusGuardAlert = async (
    sessionId: string,
    alertId: number,
  ) => {
    startTransition(() => {
      setActiveTab("sessions");
      setSessionFeed("guard");
      setSelectedSessionId(sessionId);
      setSelectedAlertId(alertId);
      setTargetedEventId(alertId);
      setCollapsedOverview(false);
      setEventViewMode("summary");
      setEventTypeFilter("all");
      setEventSearch("");
      setAlertSearch("");
    });

    await Promise.all([
      loadObservedSessions({ silent: true }),
      loadGuardAlerts(),
      loadGuardSessions({ preferredSessionId: sessionId }),
      loadGuardStatus({ silent: true }),
      loadCodexGuardAdapterStatus(),
      loadHostStatuses(),
    ]);
  };

  const handleCopyAlertSummary = async (alert: RuntimeSecurityAlert) => {
    try {
      await navigator.clipboard.writeText(buildGuardAuditSummary(alert));
      setCopiedAlertId(alert.id);
      window.setTimeout(() => {
        setCopiedAlertId((current) => (current === alert.id ? null : current));
      }, 1800);
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : "复制审计摘要失败");
    }
  };

  const handleManualIntervention = async (alert: RuntimeSecurityAlert) => {
    setInterventionPending(true);
    setInterventionResult(null);
    try {
      const result = await invoke<RuntimeGuardInterventionResult>("attempt_runtime_guard_intervention", {
        request: {
          source: alert.source,
          sessionId: alert.session_id,
          workspacePath: alert.workspace_path,
          detailsJson: alert.details_json,
        },
      });
      setInterventionResult(result);
    } catch (error) {
      setInterventionResult({
        supported: true,
        attempted: true,
        success: false,
        detail: error instanceof Error ? error.message : "手动中断失败",
      });
    } finally {
      setInterventionPending(false);
    }
  };

  const handleGuardStart = async () => {
    flushSync(() => {
      setGuardActionIntent("start");
      setGuardActionPending(true);
    });
    try {
      await waitForNextPaint();
      const status = await invoke<RuntimeGuardStatus>("start_runtime_guard");
      startTransition(() => {
        setGuardStatus(status);
        setGuardError(status.error ?? null);
      });
      if (!status.pending_action) {
        await loadGuardAlerts();
        await loadGuardSessions({ silent: true });
      }
      await loadCodexGuardAdapterStatus();
      await loadHostStatuses();
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : "启动实时防护失败");
    } finally {
      setGuardActionPending(false);
      setGuardActionIntent(null);
    }
  };

  const handleGuardStop = async () => {
    flushSync(() => {
      setGuardActionIntent("stop");
      setGuardActionPending(true);
    });
    try {
      await waitForNextPaint();
      const status = await invoke<RuntimeGuardStatus>("stop_runtime_guard");
      startTransition(() => {
        setGuardStatus(status);
        setGuardError(status.error ?? null);
        setSecurityAlerts([]);
        setBlockedAlerts([]);
        setGuardSessions([]);
      });
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : "停止实时防护失败");
    } finally {
      setGuardActionPending(false);
      setGuardActionIntent(null);
    }
  };

  const handleSoftStopToggle = async (enabled: boolean) => {
    setSoftStopPending(true);
    try {
      const status = await invoke<CodexGuardAdapterStatus>("set_codex_guard_soft_stop_enabled", { enabled });
      startTransition(() => {
        setCodexGuardAdapterStatus(status);
      });
      await loadHostStatuses();
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : "更新 Codex soft stop 失败");
    } finally {
      setSoftStopPending(false);
    }
  };

  useEffect(() => {
    void hydrateTabData(activeTab, { waitForPaint: true });

    return () => {
      cancelPendingTabHydration();
    };
  }, []);

  useEffect(() => {
    if (!initialSessionId || initialAlertId === null) {
      return;
    }
    const shouldFocusGuardTimeline =
      initialMode === "guard" ||
      (initialMode === "telemetry" && initialTab === "telemetry_sessions" && initialFeed === "guard");
    if (!shouldFocusGuardTimeline) {
      return;
    }
    void focusGuardAlert(initialSessionId, initialAlertId);
  }, [initialAlertId, initialFeed, initialMode, initialSessionId, initialTab]);

  useEffect(() => {
    if (!focusRequest?.sessionId || typeof focusRequest.alertId !== "number") {
      return;
    }

    const requestIdentity =
      focusRequest.requestId ?? `${focusRequest.sessionId}:${focusRequest.alertId}:${focusRequest.tab ?? "alerts"}`;
    if (lastHandledFocusRequestIdRef.current === requestIdentity) {
      return;
    }

    lastHandledFocusRequestIdRef.current = requestIdentity;
    void focusGuardAlert(focusRequest.sessionId, focusRequest.alertId).finally(() => {
      onFocusHandled?.(focusRequest.requestId);
    });
  }, [focusRequest, onFocusHandled]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void listen<RuntimeRiskFocusRequest>("runtime-risk-focus", (event) => {
      if (disposed || !event.payload?.sessionId || typeof event.payload.alertId !== "number") {
        return;
      }
      void focusGuardAlert(event.payload.sessionId, event.payload.alertId);
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
    const markUserInteraction = () => {
      lastUserInteractionAtRef.current = Date.now();
    };

    const windowOptions: AddEventListenerOptions = { passive: true };
    const documentOptions: AddEventListenerOptions = { capture: true, passive: true };

    window.addEventListener("wheel", markUserInteraction, windowOptions);
    window.addEventListener("touchmove", markUserInteraction, windowOptions);
    window.addEventListener("keydown", markUserInteraction);
    document.addEventListener("scroll", markUserInteraction, documentOptions);

    return () => {
      window.removeEventListener("wheel", markUserInteraction, windowOptions);
      window.removeEventListener("touchmove", markUserInteraction, windowOptions);
      window.removeEventListener("keydown", markUserInteraction);
      document.removeEventListener("scroll", markUserInteraction, documentOptions);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (shouldPauseAutoRefresh()) {
        return;
      }
      void loadIngestConfig();
      void loadObservedSessions({ silent: true });
      if (isProtectionTab) {
        void loadGuardStatus({ silent: true });
        void loadCodexGuardAdapterStatus();
        void loadHostStatuses();
      } else if (isOverviewTab) {
        void loadGuardStatus({ silent: true, detail: "summary" });
        void loadCodexGuardAdapterStatus({ detail: "summary" });
        void loadHostStatuses({ detail: "summary" });
      }
      if (isOverviewTab || isSessionTab || isProtectionTab) {
        void loadGuardSessions({ silent: true });
      }
      if (isOverviewTab || isAlertsTab || isProtectionTab) {
        void loadGuardAlerts();
      }
      if (isOverviewTab) {
        void loadToolStats();
      }
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isAlertsTab, isOverviewTab, isProtectionTab, isSessionTab]);

  useEffect(() => {
    setInterventionPending(false);
    setInterventionResult(null);
  }, [selectedAlert?.id, activeTab]);

  useEffect(() => {
    if (!selectedSessionId) {
      setEvents([]);
      setEventsLoading(false);
      return;
    }
    if (!isSessionTab) {
      setEventsLoading(false);
      return;
    }

    void loadEvents(selectedSessionId, selectedSessionFeed);
    const timer = window.setInterval(() => {
      if (shouldPauseAutoRefresh()) {
        return;
      }
      void loadEvents(selectedSessionId, selectedSessionFeed, { silent: true });
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isSessionTab, selectedSessionFeed, selectedSessionId]);

  useEffect(() => {
    setSelectedSessionId((current) =>
      current && filteredSessions.some((session) => session.id === current) ? current : filteredSessions[0]?.id ?? null,
    );
  }, [filteredSessions]);

  useEffect(() => {
    if (!targetedEventId) return;
    const targetExists = filteredEvents.some((event) => event.id === targetedEventId);
    if (!targetExists) return;
    const targetIndex = filteredEvents.findIndex((event) => event.id === targetedEventId);
    if (targetIndex >= 0) {
      const targetPage = Math.floor(targetIndex / RUNTIME_EVENT_PAGE_SIZE) + 1;
      if (targetPage !== eventPage) {
        setEventPage(targetPage);
      }
    }
    setEventDetailsExpanded((current) =>
      current[targetedEventId] ? current : { ...current, [targetedEventId]: true },
    );
    const element = document.getElementById(runtimeEventAnchorId(targetedEventId));
    if (!element) return;
    window.requestAnimationFrame(() => {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [eventPage, filteredEvents, targetedEventId]);

  useEffect(() => {
    setEventPage(1);
  }, [eventSearchQuery, eventTypeFilter, selectedSessionId, activeTab, sessionFeed]);

  useEffect(() => {
    setEventPage((current) => Math.min(current, eventPageCount));
  }, [eventPageCount]);

  useEffect(() => {
    setToolPage(1);
  }, [toolHealthFilter, toolSearchQuery]);

  useEffect(() => {
    setToolPage((current) => Math.min(current, toolPageCount));
  }, [toolPageCount]);

  useEffect(() => {
    setAlertPage(1);
  }, [alertBlockedFilter, alertSearchQuery, riskFilter, sourceFilter, activeTab]);

  useEffect(() => {
    setAlertPage((current) => Math.min(current, alertPageCount));
  }, [alertPageCount]);

  useEffect(() => {
    setSelectedAlertId((current) => (current && pagedAlertFeed.some((alert) => alert.id === current) ? current : pagedAlertFeed[0]?.id ?? null));
  }, [pagedAlertFeed]);

  const alertFilterLabel =
    alertBlockedFilter === "blocked"
      ? "仅查看已拦截事件"
      : alertBlockedFilter === "unblocked"
        ? "仅查看未拦截事件"
        : "查看全部风险事件";

  const openAlertDetails = (alert: RuntimeSecurityAlert, nextFilter: "all" | "blocked" | "unblocked" = "all") => {
    startTransition(() => {
      setActiveTab("alerts");
      setAlertBlockedFilter(nextFilter);
      setSelectedAlertId(alert.id);
      setAlertSearch("");
    });
    void hydrateTabData("alerts", { waitForPaint: true });
  };

  const openSessionDetails = (session: RuntimeSession, preferredFeed: RuntimeSessionFeed = "all") => {
    const nextFeed =
      preferredFeed === "all"
        ? resolveSessionFeed(session.id, "all", observedSessions, guardSessions)
        : preferredFeed;

    startTransition(() => {
      setActiveTab("sessions");
      setSessionFeed(nextFeed);
      setSelectedSessionId(session.id);
      setTargetedEventId(null);
    });
    void hydrateTabData("sessions", { waitForPaint: true });
  };

  const refreshActiveTab = () => {
    cancelPendingTabHydration();
    void loadIngestConfig();
    void loadGuardStatus({ silent: !isProtectionTab });
    void loadCodexGuardAdapterStatus();
    void loadHostStatuses();

    if (activeTab === "overview") {
      void loadObservedSessions({ silent: true });
      void loadGuardSessions({ silent: true });
      void loadGuardAlerts();
      void loadToolStats();
      return;
    }

    if (activeTab === "sessions") {
      void loadObservedSessions();
      void loadGuardSessions({ silent: true });
      void loadGuardAlerts();
      if (isSessionTab && selectedSessionId) {
        void loadEvents(selectedSessionId, resolveSessionFeed(selectedSessionId, sessionFeed, observedSessions, guardSessions));
      }
      return;
    }

    if (activeTab === "alerts") {
      void loadGuardAlerts();
      return;
    }

    void loadGuardAlerts();
    void loadGuardSessions({ silent: true });
  };

  return (
    <main className="relative flex h-full flex-col overflow-hidden bg-[#f4f7fb]">
      <GuardActionLoadingOverlay
        action={
          guardActionPending
            ? guardActionIntent
            : guardStatus?.pending_action === "starting"
              ? "start"
              : null
        }
      />
      {hasStandaloneChrome ? (
        <>
          <div
            data-tauri-drag-region
            className="absolute inset-x-0 top-0 z-20 h-[38px] select-none"
            style={DRAG_REGION_STYLE}
          />
          <header data-tauri-drag-region className="relative h-[38px] shrink-0 bg-white pl-20 pr-4" style={DRAG_REGION_STYLE} />
        </>
      ) : null}

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#fbfcfd]"
        data-window-drag-disabled="true"
        style={NO_DRAG_REGION_STYLE}
      >
        <header
          data-tauri-drag-region
          className="border-b border-[#eceef1] bg-white px-5 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
          style={DRAG_REGION_STYLE}
        >
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94a3b8]">Runtime Center</div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-3">
                <h1 className="text-[18px] font-bold tracking-tight text-[#1e293b]">运行时监控</h1>
              </div>
            </div>

            <div className="flex items-center gap-2" data-window-drag-disabled="true" style={NO_DRAG_REGION_STYLE}>
              <button
                type="button"
                onClick={refreshActiveTab}
                className="flex h-7 items-center rounded-md border border-[#dfe3e8] bg-white px-3 text-[11px] font-bold text-[#64748b] shadow-sm transition-all hover:bg-slate-50 hover:text-[#1e293b] active:scale-95"
              >
                刷新
              </button>
              {onClose ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="flex h-8 items-center rounded-md border border-[#cbd5e1] bg-white px-3 text-[12px] font-medium text-[#475569] transition hover:bg-[#f8fafc] hover:text-[#1e293b]"
                >
                  关闭
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
            <RuntimeStatusBadge
              tone={ingestConfig?.running ? "blue" : "neutral"}
              label={ingestConfig?.running ? "采集链路在线" : "采集链路未连接"}
            />
            <RuntimeStatusBadge
              tone={ingestConfig?.running ? "blue" : "neutral"}
              label={ingestConfig?.running ? "OTLP bridge 在线" : "OTLP bridge 未连接"}
            />
          </div>

          <div className="mt-2.5 flex items-center gap-6 text-[12px]">
            {([
              ["overview", "总览"],
              ["protection", "防护"],
              ["sessions", "会话"],
              ["alerts", "告警"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => switchActiveTab(value)}
                data-window-drag-disabled="true"
                style={NO_DRAG_REGION_STYLE}
                className={`relative flex h-[34px] items-center text-[12px] font-bold uppercase tracking-wider transition ${
                  activeTab === value
                    ? "text-[#2563eb]"
                    : "text-[#94a3b8] hover:text-[#475569]"
                }`}
              >
                {label}
                {activeTab === value && (
                  <div className="absolute inset-x-0 -bottom-[1px] h-[2px] bg-[#2563eb]" />
                )}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-2.5">
          {isOverviewTab ? (
            <div className="mx-auto flex h-full max-w-[1720px] flex-col overflow-hidden">
              <div className="hover-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
                <div className="space-y-2.5 pb-1">
                  <section className="flex items-center divide-x divide-[#eceef1] overflow-hidden rounded-md border border-[#eceef1] bg-white shadow-sm">
                    <DesktopSummaryCard label="当前活跃会话" value={String(overviewSummary.sessions)} />
                    <DesktopSummaryCard label="工具调用总记" value={formatCompactNumber(overviewSummary.toolCalls)} />
                    <DesktopSummaryCard label="工具调用平均耗时" value={formatLatency(overviewSummary.avgToolLatency)} />
                    <DesktopSummaryCard label="拦截异常风险" value={String(overviewSummary.blocked)} total={overviewSummary.alerts} />
                    <DesktopSummaryCard label="运行时活跃节点" value={String(overviewSummary.activeHosts)} />
                  </section>

                  <div className="grid gap-2.5 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
                    <section className="rounded-md border border-[#eceef1] bg-white shadow-sm lg:order-2">
                      <div className="flex items-center justify-between border-b border-[#f1f3f5] px-4 py-2">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Service Status</div>
                          <div className="mt-0.5 text-[12px] font-bold text-[#1e293b]">采集与防护链路</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <RuntimeStatusBadge
                            tone={ingestConfig?.running ? "blue" : "neutral"}
                            label={ingestConfig?.running ? "采集在线" : "采集中断"}
                          />
                          <RuntimeStatusBadge
                            tone={resolveRuntimeGuardTone(guardStatus)}
                            label={formatRuntimeGuardBadge(guardStatus)}
                          />
                        </div>
                      </div>
                      <div className="p-4">
                        <div className="rounded-md border border-[#eceef1] bg-[#fbfcfd]">
                          <div className="border-b border-[#f1f3f5] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                            关键指标
                          </div>
                          <div className="grid divide-y divide-[#f1f3f5]">
                            <div className="flex items-center justify-between px-3 py-2 text-[11px]">
                              <span className="text-[#94a3b8]">成功率</span>
                              <span className="font-bold text-[#1e293b]">{formatPercent(toolInsights.successRate)}</span>
                            </div>
                            <div className="flex items-center justify-between px-3 py-2 text-[11px]">
                              <span className="text-[#94a3b8]">失败工具</span>
                              <span className="font-bold text-[#dc2626]">{toolInsights.failingToolsCount}</span>
                            </div>
                            <div className="flex items-center justify-between px-3 py-2 text-[11px]">
                              <span className="text-[#94a3b8]">慢工具</span>
                              <span className="font-bold text-[#d97706]">{toolInsights.slowToolsCount}</span>
                            </div>
                            <div className="flex items-center justify-between px-3 py-2 text-[11px]">
                              <span className="text-[#94a3b8]">已拦截</span>
                              <span className="font-bold text-[#1e293b]">
                                {overviewSummary.blocked} / {overviewSummary.alerts}
                              </span>
                            </div>
                            <div className="flex items-center justify-between px-3 py-2 text-[11px]">
                              <span className="text-[#94a3b8]">Adapter</span>
                              <span className="font-bold text-[#2563eb]">{formatCodexGuardAdapterBadge(codexGuardAdapterStatus)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </section>

                    <section className="rounded-md border border-[#eceef1] bg-white shadow-sm lg:order-1">
                      <div className="flex items-center justify-between border-b border-[#f1f3f5] px-4 py-2">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Key Observables</div>
                          <div className="mt-0.5 text-[12px] font-bold text-[#1e293b]">极高优先关注信号</div>
                        </div>
                        <div className="text-[10px] font-medium text-[#94a3b8]">热度 / 风险 / 延迟聚焦</div>
                      </div>
                      <div className="grid gap-2.5 p-4 md:grid-cols-2">
                        {toolInsights.slowest ? (
                          <DesktopInsightCard
                            tone="amber"
                            label="慢工具"
                            title={toolInsights.slowest.tool_name}
                            detail={`平均 ${formatLatency(toolInsights.slowest.avg_latency_ms)}`}
                          />
                        ) : null}
                        {toolInsights.busiest ? (
                          <DesktopInsightCard
                            tone="blue"
                            label="最热工具"
                            title={toolInsights.busiest.tool_name}
                            detail={`${toolInsights.busiest.total_calls} 次调用`}
                          />
                        ) : null}
                        {toolInsights.riskiest ? (
                          <DesktopInsightCard
                            tone="red"
                            label="失败热点"
                            title={toolInsights.riskiest.tool_name}
                            detail={`${toolInsights.riskiest.failure_calls} 次失败`}
                          />
                        ) : null}
                        {toolInsights.peakiest ? (
                          <DesktopInsightCard
                            tone="violet"
                            label="峰值最高"
                            title={toolInsights.peakiest.tool_name}
                            detail={`峰值 ${formatLatency(toolInsights.peakiest.max_latency_ms)}`}
                          />
                        ) : null}
                      </div>
                    </section>
                  </div>

                  <section className="rounded-md border border-[#eceef1] bg-white shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f1f3f5] px-4 py-2">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Tool Performance</div>
                        <div className="mt-0.5 text-[12px] font-bold text-[#1e293b]">高密度运行时性能观测表</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <input
                            value={toolSearch}
                            onChange={(event) => setToolSearch(event.target.value)}
                            placeholder="检索工具..."
                            className="h-7 w-[160px] rounded-md border border-[#dfe3e8] bg-[#f8fafc] pl-7 pr-3 text-[11px] text-[#1e293b] outline-none transition focus:border-[#2563eb] focus:bg-white"
                          />
                          <svg className="absolute left-2 top-1.5 h-3.5 w-3.5 text-[#94a3b8]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                          </svg>
                        </div>
                        <RuntimeFilterSelect
                          value={toolHealthFilter}
                          onChange={(event) => setToolHealthFilter(event.target.value as "all" | "healthy" | "needs-review")}
                          className="text-[11px]"
                        >
                          <option value="all">全部展示</option>
                          <option value="healthy">无失败</option>
                          <option value="needs-review">有风险</option>
                        </RuntimeFilterSelect>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[940px] text-left text-[11px]">
                        <thead className="sticky top-0 z-10 bg-[#f8fafc] text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                          <tr className="border-b border-[#eceef1]">
                            <th className="px-5 py-2">工具名称</th>
                            <th className="px-3 py-2">调用量</th>
                            <th className="px-3 py-2">失败数</th>
                            <th className="px-3 py-2">错误率</th>
                            <th className="px-3 py-2">平均耗时</th>
                            <th className="px-3 py-2">峰值耗时</th>
                            <th className="px-3 py-2">会话关联</th>
                            <th className="px-5 py-2 text-right">最后活跃</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#f1f3f5]">
                          {filteredToolStats.length === 0 ? (
                            <tr>
                              <td colSpan={8} className="px-5 py-12 text-center text-[11px] text-[#94a3b8]">
                                无可用运行时监控数据
                              </td>
                            </tr>
                          ) : (
                            pagedToolStats.map((tool) => (
                              <tr key={tool.tool_name} className="bg-white transition-colors hover:bg-slate-50/50">
                                <td className="px-5 py-2.5 font-bold text-[#1e293b]">
                                  <div className="max-w-[280px] truncate" title={tool.tool_name}>
                                    {tool.tool_name}
                                  </div>
                                </td>
                                <td className="px-3 py-2.5 font-medium text-[#4b5563]">{tool.total_calls}</td>
                                <td className={`px-3 py-2.5 font-bold ${tool.failure_calls > 0 ? "text-[#dc2626]" : "text-[#4b5563]"}`}>
                                  {tool.failure_calls}
                                </td>
                                <td className="px-3 py-2.5 font-medium text-[#4b5563]">{formatPercent(toolFailureRate(tool))}</td>
                                <td className="px-3 py-2.5 font-medium text-[#4b5563]">{formatLatency(tool.avg_latency_ms)}</td>
                                <td className="px-3 py-2.5 font-medium text-[#4b5563]">{formatLatency(tool.max_latency_ms)}</td>
                                <td className="px-3 py-2.5 font-medium text-[#4b5563]">{tool.session_count}</td>
                                <td className="px-5 py-2.5 text-right font-medium text-[#94a3b8]">{formatRuntimeTableDateTime(tool.last_called_at)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex items-center justify-between border-t border-[#f1f3f5] bg-white px-5 py-2">
                      <div className="text-[10px] font-medium text-[#94a3b8]">
                        展示 {pagedToolStats.length} / {filteredToolStats.length} 个工具
                      </div>
                      <PaginationControls page={toolPage} pageCount={toolPageCount} onChange={setToolPage} />
                    </div>
                  </section>

                  <div className="grid gap-2.5 lg:grid-cols-2">
                    <section className="rounded-md border border-[#eceef1] bg-white shadow-sm">
                      <div className="flex items-center justify-between border-b border-[#f1f3f5] px-4 py-2">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Suspicious Sessions</div>
                        <div className="text-[10px] font-bold text-[#dc2626]">{highRiskSessions.length} CRITICAL</div>
                      </div>
                      <div className="divide-y divide-[#f1f3f5]">
                        {highRiskSessions.length === 0 ? (
                          <div className="px-4 py-10 text-center text-[11px] text-[#94a3b8]">暂无高风险会话记录</div>
                        ) : (
                          highRiskSessions.map((session) => {
                            const feed = resolveSessionFeed(session.id, "all", observedSessions, guardSessions);
                            return (
                              <button
                                key={`high-risk-${session.id}`}
                                type="button"
                                onClick={() => openSessionDetails(session, feed)}
                                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-slate-50/50"
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-[12px] font-bold text-[#1e293b]">
                                    {runtimeSessionHeadline(session, feed)}
                                  </div>
                                  <div className="mt-0.5 text-[10px] font-medium text-[#94a3b8]">{formatSessionTimestamp(session)}</div>
                                </div>
                                <span className="rounded-sm border border-[#fecaca] bg-[#fff1f2] px-1.5 py-0.5 text-[9px] font-bold text-[#dc2626]">
                                  {formatRiskLevelLabel(session.risk_level)}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </section>

                    <section className="rounded-md border border-[#eceef1] bg-white shadow-sm">
                      <div className="flex items-center justify-between border-b border-[#f1f3f5] px-4 py-2">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Protection Events</div>
                        <div className="text-[10px] font-bold text-[#2563eb]">{recentProtectionEvents.length} TOTAL</div>
                      </div>
                      <div className="divide-y divide-[#f1f3f5]">
                        {recentProtectionEvents.length === 0 ? (
                          <div className="px-4 py-10 text-center text-[11px] text-[#94a3b8]">暂无拦截记录</div>
                        ) : (
                          recentProtectionEvents.map((alert) => (
                            <button
                              key={`recent-${alert.id}`}
                              type="button"
                              onClick={() => openAlertDetails(alert, alert.blocked ? "blocked" : "all")}
                              className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-slate-50/50"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-[12px] font-bold text-[#1e293b]">{alert.title}</div>
                                <div className="mt-0.5 truncate text-[10px] font-medium text-[#94a3b8]">{guardAlertReason(alert)}</div>
                              </div>
                              <span
                                className={`rounded-sm border px-1.5 py-0.5 text-[9px] font-bold ${
                                  alert.blocked
                                    ? "border-[#fecaca] bg-[#fff1f2] text-[#b91c1c]"
                                    : "border-[#dfe3e8] bg-[#f8fafc] text-[#64748b]"
                                }`}
                              >
                                {alert.blocked ? "BLOCKED" : formatAlertSeverityLabel(alert.severity).toUpperCase()}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            </div>
          ) : isProtectionTab ? (
            <div className="mx-auto flex h-full max-w-[1720px] flex-col overflow-hidden">
              <div className="hover-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
                <div className="space-y-2.5 pb-1">
                  <section className="rounded-md border border-[#eceef1] bg-white shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f1f3f5] px-4 py-2">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Protection Center</div>
                        <div className="mt-0.5 text-[12px] font-bold text-[#1e293b]">防护服务状态与运行诊断</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <RuntimeStatusBadge
                          tone={resolveRuntimeGuardTone(guardStatus)}
                          label={formatRuntimeGuardBadge(guardStatus)}
                        />
                        <RuntimeStatusBadge
                          tone={codexGuardAdapterStatus?.detected ? "blue" : "neutral"}
                          label={formatCodexGuardStatusCompact(codexGuardAdapterStatus)}
                        />
                        <RuntimeStatusBadge
                          tone={mergedAlerts.some((alert) => alert.blocked) ? "amber" : "neutral"}
                          label={mergedAlerts.some((alert) => alert.blocked) ? "存在拦截" : "无拦截"}
                        />
                      </div>
                    </div>
                    <div className="grid gap-px bg-[#eceef1] md:grid-cols-4">
                      <DesktopSummaryCard label="Guard 状态" value={formatRuntimeGuardStateValue(guardStatus)} />
                      <DesktopSummaryCard label="风险事件" value={String(alertSummary.alerts)} />
                      <DesktopSummaryCard label="已拦截" value={String(alertSummary.blocked)} />
                      <DesktopSummaryCard label="活跃宿主" value={String(overviewSummary.activeHosts)} />
                    </div>
                  </section>

                  {guardError ? (
                    <div className="rounded-md border border-[#fecaca] bg-[#fff6f6] px-4 py-3 text-[11px] font-medium text-[#b42318]">
                      {guardError}
                    </div>
                  ) : null}

                  <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_360px]">
                    <section className="rounded-md border border-[#eceef1] bg-white shadow-sm">
                      <div className="flex items-center justify-between border-b border-[#f1f3f5] px-4 py-2">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Service Center</div>
                          <div className="mt-0.5 text-[12px] font-bold text-[#1e293b]">服务中心与适配器诊断</div>
                        </div>
                        <RuntimeStatusBadge
                          tone={resolveRuntimeGuardTone(guardStatus)}
                          label={formatRuntimeGuardAvailability(guardStatus)}
                        />
                      </div>
                      <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                        <div className="space-y-3">
                          <div className="rounded-md border border-[#eceef1] bg-[#fbfcfd] p-3">
                            <div className="text-[12px] font-bold text-[#1e293b]">
                              {formatRuntimeGuardDescription(guardStatus)}
                            </div>
                            <div className="mt-1.5 text-[11px] leading-5 text-[#64748b]">
                              服务启停、Soft Stop 和实验性防护开关仍在设置页统一管理；此处只呈现运行态诊断、适配器状态和宿主矩阵。
                            </div>
                          </div>

                          <div className="grid gap-2 md:grid-cols-3">
                            <div className="rounded-md border border-[#eceef1] bg-white px-3 py-3">
                              <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Adapter</div>
                              <div className="mt-1 text-[12px] font-bold text-[#1e293b]">{formatCodexGuardAdapterBadge(codexGuardAdapterStatus)}</div>
                            </div>
                            <div className="rounded-md border border-[#eceef1] bg-white px-3 py-3">
                              <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Soft Stop</div>
                              <div className="mt-1 text-[12px] font-bold text-[#1e293b]">
                                {codexGuardAdapterStatus?.experimental_soft_stop_enabled ? "已开启" : "未开启"}
                              </div>
                            </div>
                            <div className="rounded-md border border-[#eceef1] bg-white px-3 py-3">
                              <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">最近同步</div>
                              <div className="mt-1 text-[12px] font-bold text-[#1e293b]">
                                {formatOptionalDateTime(codexGuardAdapterStatus?.last_synced_at)}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-md border border-[#eceef1] bg-[#fbfcfd]">
                          <div className="border-b border-[#f1f3f5] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                            配置摘要
                          </div>
                          <div className="divide-y divide-[#f1f3f5] px-3 py-1">
                            <DesktopPropertyRow
                              label="Guard"
                              value={formatRuntimeGuardStateValue(guardStatus)}
                              highlight={!guardStatus?.reachable && guardStatus?.pending_action !== "starting"}
                            />
                            <DesktopPropertyRow label="Adapter" value={formatCodexGuardStatusCompact(codexGuardAdapterStatus)} />
                            <DesktopPropertyRow
                              label="Soft Stop"
                              value={codexGuardAdapterStatus?.experimental_soft_stop_enabled ? "已开启" : "未开启"}
                            />
                            <DesktopPropertyRow label="Processed" value={String(codexGuardAdapterStatus?.processed_events_total ?? 0)} />
                            <DesktopPropertyRow label="Blocked" value={String(codexGuardAdapterStatus?.blocked_events_total ?? 0)} />
                            <DesktopPropertyRow label="Logs" value={ingestConfig?.otlp_logs_endpoint || "未配置"} />
                            <DesktopPropertyRow label="Traces" value={ingestConfig?.otlp_traces_endpoint || "未配置"} />
                          </div>
                        </div>
                      </div>
                    </section>

                    <section className="rounded-md border border-[#eceef1] bg-white shadow-sm">
                      <div className="border-b border-[#f1f3f5] px-4 py-2">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Recent Signals</div>
                        <div className="mt-0.5 text-[12px] font-bold text-[#1e293b]">最近防护信号</div>
                      </div>
                      <div className="divide-y divide-[#f1f3f5]">
                        {recentProtectionEvents.length === 0 ? (
                          <div className="px-4 py-10 text-center text-[11px] text-[#94a3b8]">当前还没有新的防护事件。</div>
                        ) : (
                          recentProtectionEvents.map((alert) => (
                            <button
                              key={`protection-${alert.id}`}
                              type="button"
                              onClick={() => openAlertDetails(alert, alert.blocked ? "blocked" : "all")}
                              className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50/50"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-[12px] font-bold text-[#1e293b]">{alert.title}</div>
                                <div className="mt-0.5 line-clamp-2 text-[10px] font-medium leading-5 text-[#94a3b8]">
                                  {guardAlertReason(alert)}
                                </div>
                              </div>
                              <span
                                className={`rounded-sm px-1.5 py-0.5 text-[9px] font-bold ${
                                  alert.blocked ? "bg-[#fff1f2] text-[#b91c1c]" : "bg-[#fff7ed] text-[#c2410c]"
                                }`}
                              >
                                {alert.blocked ? "BLOCKED" : formatAlertSeverityLabel(alert.severity)}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </section>
                  </div>

                  <section className="rounded-md border border-[#eceef1] bg-white shadow-sm">
                    <div className="flex items-center justify-between border-b border-[#f1f3f5] px-4 py-2">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Host Matrix</div>
                        <div className="mt-0.5 text-[12px] font-bold text-[#1e293b]">宿主支持矩阵</div>
                      </div>
                      <div className="text-[10px] font-bold text-[#94a3b8]">{hostStatuses.length} HOSTS</div>
                    </div>
                    <div className="overflow-auto">
                      <table className="w-full min-w-[920px] text-left text-[11px]">
                        <thead className="bg-[#f8fafc] text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                          <tr className="border-b border-[#eceef1]">
                            <th className="px-4 py-2">宿主</th>
                            <th className="px-3 py-2">能力级别</th>
                            <th className="px-3 py-2">运行状态</th>
                            <th className="px-4 py-2">说明</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#f1f3f5]">
                          {hostStatuses.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="px-4 py-12 text-center text-[11px] text-[#94a3b8]">
                                暂无宿主状态数据。
                              </td>
                            </tr>
                          ) : (
                            hostStatuses.map((host) => (
                              <tr key={`matrix-${host.key}`} className="bg-white transition-colors hover:bg-slate-50/50">
                                <td className="px-4 py-2.5 font-bold text-[#1e293b]">{host.label}</td>
                                <td className="px-3 py-2.5">
                                  <span className={`rounded-sm px-1.5 py-0.5 text-[9px] font-bold ${hostCapabilityBadgeClass(host.capability_level)}`}>
                                    {formatCapabilityLevelLabel(host.capability_level)}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 font-medium text-[#4b5563]">{formatHostRuntimeStatus(host.status, host.detected)}</td>
                                <td className="px-4 py-2.5 font-medium text-[#64748b]">{host.detail || "—"}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              </div>
            </div>
          ) : isSessionTab ? (
            <div className="flex h-full flex-col overflow-hidden">
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <input
                      value={sessionSearch}
                      onChange={(event) => setSessionSearch(event.target.value)}
                      placeholder="检索会话 ID / 工作区 / 摘要..."
                      className="h-7 w-[240px] rounded-md border border-[#dfe3e8] bg-white pl-7 pr-3 text-[11px] text-[#1e293b] outline-none transition focus:border-[#2563eb] focus:ring-1 focus:ring-[#2563eb]/10"
                    />
                    <svg className="absolute left-2 top-1.5 h-3.5 w-3.5 text-[#94a3b8]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  {sessionFeed === "guard" ? (
                    <div className="inline-flex h-7 items-center gap-2 rounded-md border border-[#fecaca] bg-[#fff5f5] px-2.5 text-[10px] font-bold text-[#b42318]">
                      <span>告警定位视图</span>
                      <button
                        type="button"
                        onClick={() => {
                          setSessionFeed("all");
                          setTargetedEventId(null);
                        }}
                        className="text-[#dc2626] transition hover:text-[#b42318]"
                      >
                        返回会话
                      </button>
                    </div>
                  ) : null}
                  <RuntimeFilterSelect
                    value={sourceFilter}
                    onChange={(event) => setSourceFilter(event.target.value)}
                    className="text-[10px]"
                  >
                    <option value="all">来源: 全部</option>
                    {availableSources.map((source) => (
                      <option key={source} value={source}>
                        {formatRuntimeSourceLabel(source)}
                      </option>
                    ))}
                  </RuntimeFilterSelect>
                  <RuntimeFilterSelect
                    value={riskFilter}
                    onChange={(event) => setRiskFilter(event.target.value as "all" | "low" | "medium" | "high")}
                    className="text-[10px]"
                  >
                    <option value="all">风险: 全部</option>
                    <option value="high">高风险</option>
                    <option value="medium">中风险</option>
                    <option value="low">低风险</option>
                  </RuntimeFilterSelect>
                </div>

                <div className="flex items-center gap-4 text-[10px] font-bold text-[#94a3b8]">
                  <div className="flex items-center gap-1.5">
                    <span className="uppercase tracking-wider">Metrics</span>
                    <span className="h-3 w-px bg-[#eceef1]" />
                    <span className="text-[#1e293b]">{runtimeSummary.sessions} Sessions</span>
                    <span className="text-[#64748b]">{formatCompactNumber(runtimeSummary.tokens)} Tokens</span>
                    <span className="text-[#64748b]">{runtimeSummary.toolCalls} Tools</span>
                    <span className="text-[#dc2626]">{runtimeSummary.alerts} Alerts</span>
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-[#eceef1] bg-white shadow-sm">
                <div className="flex h-full divide-x divide-[#f1f3f5]">
                  <aside className="flex w-[320px] shrink-0 flex-col bg-[#f8fafc]">
                    <div className="border-b border-[#f1f3f5] bg-white px-4 py-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Session Stream</div>
                    </div>
                    <div className="hover-scrollbar flex-1 overflow-y-auto">
                      {runtimeLoading ? (
                        <div className="px-5 py-20 text-center text-[11px] text-[#94a3b8]">加载会话列表中...</div>
                      ) : runtimeError ? (
                        <div className="m-4 rounded-md border border-[#fecaca] bg-[#fff6f6] px-4 py-4 text-[11px] font-medium text-[#b42318]">
                          {runtimeError}
                        </div>
                      ) : filteredSessions.length === 0 ? (
                        <div className="px-5 py-20 text-center">
                          <div className="text-[12px] font-bold text-[#1e293b]">未找到会话</div>
                          <div className="mt-1 text-[11px] text-[#94a3b8]">尝试调整筛选条件</div>
                        </div>
                      ) : (
                        <div className="divide-y divide-[#f1f3f5]">
                          {filteredSessions.map((session) => {
                            const itemFeed = resolveSessionFeed(session.id, sessionFeed, observedSessions, guardSessions);
                            const headline = runtimeSessionHeadline(session, itemFeed);
                            const active = session.id === selectedSessionId;
                            return (
                              <button
                                key={session.id}
                                type="button"
                                onClick={() => {
                                  setSelectedSessionId(session.id);
                                  setTargetedEventId(null);
                                }}
                                className={`group flex w-full flex-col gap-1.5 px-4 py-3 text-left transition ${
                                  active ? "bg-white shadow-[inset_3px_0_0_#2563eb]" : "hover:bg-white"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className={`truncate text-[12px] font-bold ${active ? "text-[#2563eb]" : "text-[#1e293b]"}`}>
                                    {headline}
                                  </div>
                                  <span className={`shrink-0 rounded-sm px-1 py-0.5 text-[8px] font-black uppercase tracking-tight ${
                                    session.risk_level === "high" || session.risk_level === "critical"
                                      ? "bg-[#fff1f2] text-[#dc2626]"
                                      : "bg-slate-100 text-[#94a3b8]"
                                  }`}>
                                    {formatRiskLevelLabel(session.risk_level)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between text-[10px] font-medium text-[#94a3b8]">
                                  <div className="flex items-center gap-2">
                                    <span className="flex h-1 w-1 rounded-full bg-[#cbd5e1]" />
                                    {formatRuntimeSourceShortLabel(session.source)}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {session.tool_calls > 0 ? <span>{session.tool_calls} Tools</span> : null}
                                    <span>{formatSessionTimestamp(session)}</span>
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </aside>

                  <section className="flex min-w-0 flex-1 flex-col bg-white">
                    {selectedSession ? (
                      <>
                        <header className="border-b border-[#f1f3f5] bg-[#fbfcfd] px-5 py-3">
                          <div className="flex items-start justify-between gap-5">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Session Details</div>
                                <span className="h-1 w-1 rounded-full bg-[#cbd5e1]" />
                                <div className="truncate font-mono text-[10px] text-[#64748b]">{selectedSession.id}</div>
                              </div>
                              <h2 className="mt-1 truncate text-[16px] font-bold tracking-tight text-[#1e293b]">
                                {runtimeSessionHeadline(selectedSession, selectedSessionFeed)}
                              </h2>
                              <div className="mt-1 flex items-center gap-4 text-[11px] font-medium text-[#64748b]">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[#94a3b8]">源系统</span>
                                  <span className="text-[#1e293b]">{formatRuntimeSourceLabel(selectedSession.source)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[#94a3b8]">运行时长</span>
                                  <span className="text-[#1e293b]">{formatLatency(selectedSession.duration_ms ?? 0)}</span>
                                </div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setSelectedSessionId(null)}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-[#94a3b8] hover:bg-slate-100 hover:text-[#1e293b]"
                              >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          </div>

                          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
                            <RuntimeSummaryCard label="模型调用" value={String(selectedSession.model_calls)} />
                            <RuntimeSummaryCard label="工具调用" value={String(selectedSession.tool_calls)} />
                            <RuntimeSummaryCard
                              label="TOKEN 数"
                              value={formatCompactNumber(selectedSession.total_input_tokens + selectedSession.total_output_tokens)}
                            />
                            <RuntimeSummaryCard label="平均延迟" value={formatLatency(selectedSession.avg_latency_ms)} />
                          </div>
                        </header>

                        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f1f3f5] bg-white px-5 py-2">
                            <div className="flex flex-wrap items-center gap-1">
                              {(["all", "model", "tool", "security"] as const).map((cat) => (
                                <button
                                  key={cat}
                                  type="button"
                                  onClick={() => setEventTypeFilter(cat)}
                                  className={`h-6 rounded-md px-2.5 text-[10px] font-bold transition ${
                                    eventTypeFilter === cat
                                      ? "bg-[#2563eb] text-white"
                                      : "text-[#94a3b8] hover:bg-slate-100 hover:text-[#64748b]"
                                  }`}
                                >
                                  {cat.toUpperCase()}
                                </button>
                              ))}
                              <div className="relative ml-2">
                                <input
                                  value={eventSearch}
                                  onChange={(event) => setEventSearch(event.target.value)}
                                  placeholder="搜索时间线..."
                                  className="h-6 w-[180px] rounded-md border border-[#dfe3e8] bg-[#f8fafc] pl-7 pr-2 text-[10px] text-[#1e293b] outline-none transition focus:border-[#2563eb]"
                                />
                                <svg className="absolute left-2 top-1.5 h-3 w-3 text-[#94a3b8]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                </svg>
                              </div>
                            </div>

                            <div className="inline-flex h-6 rounded-md border border-[#dfe3e8] bg-[#f8fafc] p-0.5">
                              <button
                                type="button"
                                onClick={() => setEventViewMode("summary")}
                                className={`rounded-[4px] px-2.5 text-[10px] font-bold transition ${
                                  eventViewMode === "summary" ? "bg-white text-[#1e293b] shadow-sm" : "text-[#64748b] hover:text-[#1e293b]"
                                }`}
                              >
                                摘要
                              </button>
                              <button
                                type="button"
                                onClick={() => setEventViewMode("list")}
                                className={`rounded-[4px] px-2.5 text-[10px] font-bold transition ${
                                  eventViewMode === "list" ? "bg-white text-[#2563eb] shadow-sm" : "text-[#64748b] hover:text-[#2563eb]"
                                }`}
                              >
                                控制台
                              </button>
                            </div>
                          </div>

                          <div className="hover-scrollbar flex-1 overflow-y-auto bg-[#fafafa]">
                            {eventsLoading ? (
                              <div className="flex h-40 items-center justify-center gap-3">
                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#2563eb] border-t-transparent" />
                                <span className="text-[12px] font-medium text-[#94a3b8]">正在同步时间线...</span>
                              </div>
                            ) : deferredFilteredEvents.length === 0 ? (
                              <div className="px-5 py-20 text-center">
                                <div className="text-[12px] font-bold text-[#1e293b]">无可见事件</div>
                                <div className="mt-1 text-[11px] text-[#94a3b8]">该会话没有符合当前过滤条件的运行时数据</div>
                              </div>
                            ) : (
                              <div className="space-y-3 p-5">
                                {pagedEvents.map((event, index) => (
                                  <div
                                    key={event.id}
                                    id={runtimeEventAnchorId(event.id)}
                                    className="relative flex gap-4"
                                  >
                                    <div className="flex flex-col items-center">
                                      <div className={`z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 bg-white ${
                                        targetedEventId === event.id ? "border-[#2563eb]" : "border-[#cbd5e1]"
                                      }`}>
                                        <div
                                          className={`h-1.5 w-1.5 rounded-full ${
                                            event.severity === "critical" ? "bg-[#dc2626]" : "bg-[#2563eb]"
                                          }`}
                                        />
                                      </div>
                                      {index !== pagedEvents.length - 1 ? <div className="w-[2px] grow bg-[#eceef1]" /> : null}
                                    </div>

                                    <div className="min-w-0 flex-1 pb-6">
                                      <div
                                        className={`rounded-md border p-3 shadow-sm transition ${
                                          targetedEventId === event.id
                                            ? "border-[#fdba74] bg-[#fff7ed]"
                                            : "border-[#eceef1] bg-white hover:border-[#dfe3e8]"
                                        }`}
                                      >
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                              <span className="text-[10px] font-black uppercase tracking-wider text-[#94a3b8]">
                                                {formatRuntimeEventTypeLabel(event.event_type)}
                                              </span>
                                              <span className="h-1 w-1 rounded-full bg-[#cbd5e1]" />
                                              <span className="text-[10px] font-medium text-[#94a3b8]">
                                                {formatRuntimeTableDateTime(event.event_time)}
                                              </span>
                                            </div>
                                            <div className="mt-1 text-[13px] font-bold text-[#1e293b]">
                                              {formatRuntimeEventTitle(event.title)}
                                            </div>
                                          </div>
                                          <div className="flex shrink-0 items-center gap-2">
                                            {(eventViewMode === "list"
                                              ? event.details_json.trim().length > 0
                                              : hasRuntimeStructuredSummary(event.event_type, event.details_json)) ? (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  setEventDetailsExpanded((current) => ({
                                                    ...current,
                                                    [event.id]: !current[event.id],
                                                  }))
                                                }
                                                className="rounded-md border border-[#dfe3e8] bg-white px-2 py-1 text-[10px] font-bold text-[#64748b] transition hover:border-[#cbd5e1] hover:text-[#1e293b]"
                                              >
                                                {eventDetailsExpanded[event.id] ? "收起详情" : "展开详情"}
                                              </button>
                                            ) : null}
                                            {event.severity === "critical" ? (
                                              <span className="rounded-sm bg-[#fff1f2] px-1.5 py-0.5 text-[9px] font-bold text-[#dc2626]">
                                                CRITICAL
                                              </span>
                                            ) : null}
                                          </div>
                                        </div>

                                        <RuntimeEventDetails
                                          eventType={event.event_type}
                                          detailsJson={event.details_json}
                                          expanded={Boolean(eventDetailsExpanded[event.id])}
                                          viewMode={eventViewMode}
                                          onToggle={() =>
                                            setEventDetailsExpanded((current) => ({
                                              ...current,
                                              [event.id]: !current[event.id],
                                            }))
                                          }
                                        />
                                      </div>
                                    </div>
                                  </div>
                                ))}
                                {eventPageCount > 1 ? (
                                  <div className="mt-4 flex items-center justify-between border-t border-[#f1f3f5] pt-4">
                                    <div className="text-[10px] font-medium text-[#94a3b8]">
                                      Page {eventPage} of {eventPageCount}
                                    </div>
                                    <PaginationControls page={eventPage} pageCount={eventPageCount} onChange={setEventPage} />
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
                        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#f8fafc] text-[#cbd5e1]">
                          <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                          </svg>
                        </div>
                        <h3 className="mt-4 text-[14px] font-bold text-[#1e293b]">选择会话查看详情</h3>
                        <p className="mt-1.5 max-w-[280px] text-[12px] leading-relaxed text-[#94a3b8]">
                          从左侧列表选择一个运行时会话，即可查看完整的事件流、安全审计详情。
                        </p>
                      </div>
                    )}
                  </section>
                </div>
              </div>
            </div>
          ) : isAlertsTab ? (
            <div className="flex h-full flex-col overflow-hidden">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="relative">
                  <input
                    value={alertSearch}
                    onChange={(event) => setAlertSearch(event.target.value)}
                    placeholder="搜索标题 / 类型 / 资源..."
                    className="h-7 w-[220px] rounded-md border border-[#dfe3e8] bg-white pl-7 pr-3 text-[11px] text-[#1e293b] outline-none transition focus:border-[#2563eb] focus:ring-1 focus:ring-[#2563eb]/10"
                  />
                  <svg className="absolute left-2 top-1.5 h-3.5 w-3.5 text-[#94a3b8]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>

                <div className="inline-flex h-7 rounded-md border border-[#dfe3e8] bg-[#f8fafc] p-0.5">
                  <button
                    type="button"
                    onClick={() => setAlertBlockedFilter("all")}
                    className={`rounded-[4px] px-2.5 text-[10px] font-bold transition ${
                      alertBlockedFilter === "all" ? "bg-white text-[#1e293b] shadow-sm" : "text-[#64748b] hover:text-[#1e293b]"
                    }`}
                  >
                    全部
                  </button>
                  <button
                    type="button"
                    onClick={() => setAlertBlockedFilter("blocked")}
                    className={`rounded-[4px] px-2.5 text-[10px] font-bold transition ${
                      alertBlockedFilter === "blocked" ? "bg-white text-[#dc2626] shadow-sm" : "text-[#64748b] hover:text-[#dc2626]"
                    }`}
                  >
                    已拦截
                  </button>
                  <button
                    type="button"
                    onClick={() => setAlertBlockedFilter("unblocked")}
                    className={`rounded-[4px] px-2.5 text-[10px] font-bold transition ${
                      alertBlockedFilter === "unblocked" ? "bg-white text-[#ea580c] shadow-sm" : "text-[#64748b] hover:text-[#ea580c]"
                    }`}
                  >
                    观察中
                  </button>
                </div>

                <RuntimeFilterSelect
                  value={sourceFilter}
                  onChange={(event) => setSourceFilter(event.target.value)}
                  className="text-[10px]"
                >
                  <option value="all">来源: 全部</option>
                  {availableSources.map((source) => (
                    <option key={source} value={source}>
                      {formatRuntimeSourceLabel(source)}
                    </option>
                  ))}
                </RuntimeFilterSelect>

                <RuntimeFilterSelect
                  value={riskFilter}
                  onChange={(event) => setRiskFilter(event.target.value as "all" | "low" | "medium" | "high")}
                  className="text-[10px]"
                >
                  <option value="all">风险: 全部</option>
                  <option value="high">高危</option>
                  <option value="medium">警告</option>
                  <option value="low">提示</option>
                </RuntimeFilterSelect>

                <div className="ml-auto text-[10px] font-medium text-[#94a3b8]">{alertFilterLabel}</div>
              </div>

              <section className="mb-2 overflow-hidden rounded-md border border-[#eceef1] bg-white shadow-sm">
                <div className="grid gap-px bg-[#eceef1] md:grid-cols-4">
                  <RuntimeSummaryCard label="Total" value={String(alertSummary.alerts)} />
                  <RuntimeSummaryCard label="Critical" value={String(alertSummary.critical)} />
                  <RuntimeSummaryCard label="Blocked" value={String(alertSummary.blocked)} />
                  <RuntimeSummaryCard label="Sources" value={String(alertSummary.sources)} />
                </div>
              </section>

              <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-[#eceef1] bg-white shadow-sm">
                <div className="flex h-full divide-x divide-[#f1f3f5]">
                  <aside className="flex w-[320px] shrink-0 flex-col bg-[#f8fafc]">
                    <div className="border-b border-[#f1f3f5] bg-white px-4 py-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Alert Vector</div>
                    </div>
                    <div className="hover-scrollbar flex-1 overflow-y-auto">
                      {alertFeed.length === 0 ? (
                        <div className="px-5 py-20 text-center">
                          <div className="text-[12px] font-bold text-[#1e293b]">未找到风险事件</div>
                          <div className="mt-1 text-[11px] text-[#94a3b8]">尝试调整搜索或筛选条件</div>
                        </div>
                      ) : (
                        pagedAlertFeed.map((alert) => (
                          <DesktopAlertItem
                            key={alert.id}
                            alert={alert}
                            isActive={selectedAlert?.id === alert.id}
                            onClick={() => setSelectedAlertId(alert.id)}
                          />
                        ))
                      )}
                    </div>
                    <div className="flex items-center justify-between border-t border-[#f1f3f5] bg-white px-4 py-2">
                      <div className="text-[10px] font-medium text-[#94a3b8]">
                        {alertFeed.length} 条匹配
                      </div>
                      <PaginationControls page={alertPage} pageCount={alertPageCount} onChange={setAlertPage} />
                    </div>
                  </aside>

                  <section className="flex min-w-0 flex-1 flex-col bg-white">
                    {alertFeed.length === 0 || !selectedAlert ? (
                      <div className="flex flex-1 flex-col items-center justify-center p-12 text-center text-[#94a3b8]">
                        <svg className="h-12 w-12 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <h3 className="mt-4 text-[14px] font-bold text-[#1e293b]">选择风险事件查看详情</h3>
                        <p className="mt-1 text-[11px]">点击左侧列表中的条目，即可提取全量元数据与运行上下文。</p>
                      </div>
                    ) : (
                      <>
                        <header className="border-b border-[#f1f3f5] bg-[#fbfcfd] px-5 py-3">
                          <div className="flex items-start justify-between gap-5">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`rounded-sm px-1.5 py-0.5 text-[9px] font-bold ${
                                    selectedAlert.blocked ? "bg-[#fff1f2] text-[#dc2626]" : "bg-[#fff7ed] text-[#ea580c]"
                                  }`}
                                >
                                  {selectedAlert.blocked ? "BLOCKED" : "OBSERVED"}
                                </span>
                                <span className="rounded-sm bg-[#f1f5f9] px-1.5 py-0.5 text-[9px] font-bold text-[#475569]">
                                  {formatAlertSeverityLabel(selectedAlert.severity)}
                                </span>
                                <span className="h-1 w-1 rounded-full bg-[#cbd5e1]" />
                                <div className="text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">Alert Detail</div>
                              </div>
                              <h2 className="mt-1 truncate text-[16px] font-bold tracking-tight text-[#1e293b]">
                                {selectedAlert.title}
                              </h2>
                              <div className="mt-1 text-[11px] font-medium text-[#64748b]">
                                {guardAlertReason(selectedAlert)}
                              </div>
                            </div>
                            <div className="shrink-0 text-[10px] font-medium text-[#94a3b8]">
                              {formatRuntimeTableDateTime(selectedAlert.event_time)}
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {selectedAlertSupportsIntervention ? (
                              <button
                                type="button"
                                onClick={() => void handleManualIntervention(selectedAlert)}
                                disabled={interventionPending}
                                className="flex h-7 items-center rounded-md border border-[#fecaca] bg-white px-3 text-[11px] font-bold text-[#dc2626] transition hover:bg-red-50 disabled:opacity-50"
                              >
                                {interventionPending ? "中..." : "中断"}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => void handleOpenAlertTimeline(selectedAlert)}
                              className="flex h-7 items-center rounded-md border border-[#dfe3e8] bg-white px-3 text-[11px] font-bold text-[#64748b] transition hover:bg-slate-50 hover:text-[#1e293b]"
                            >
                              定位会话
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleCopyAlertSummary(selectedAlert)}
                              className="flex h-7 items-center rounded-md border border-[#dfe3e8] bg-white px-3 text-[11px] font-bold text-[#64748b] transition hover:bg-slate-50 hover:text-[#1e293b]"
                            >
                              {copiedAlertId === selectedAlert.id ? "已复制" : "复制摘要"}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setAlertDetailsExpanded((current) => ({
                                  ...current,
                                  [selectedAlert.id]: !current[selectedAlert.id],
                                }))
                              }
                              className="flex h-7 items-center rounded-md border border-[#dfe3e8] bg-white px-3 text-[11px] font-bold text-[#64748b] transition hover:bg-slate-50"
                            >
                              {alertDetailsExpanded[selectedAlert.id] ? "收起元数据" : "展开元数据"}
                            </button>
                          </div>

                          {interventionResult ? (
                            <div
                              className={`mt-3 rounded-md border px-3 py-2 text-[11px] font-medium ${
                                interventionResult.success
                                  ? "border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]"
                                  : "border-[#fed7aa] bg-[#fff7ed] text-[#c2410c]"
                              }`}
                            >
                              {interventionResult.detail}
                            </div>
                          ) : null}
                        </header>

                        <div className="hover-scrollbar flex-1 overflow-y-auto bg-[#fafafa] p-5">
                          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
                            <div className="space-y-4">
                              <section className="overflow-hidden rounded-md border border-[#eceef1] bg-white shadow-sm">
                                <div className="border-b border-[#f1f3f5] bg-[#fbfcfd] px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                                  属性面板
                                </div>
                                <div className="divide-y divide-[#f1f3f5] px-4 py-1">
                                  <DesktopPropertyRow label="状态" value={selectedAlert.blocked ? "已拦截" : "已观察"} highlight={selectedAlert.blocked} />
                                  <DesktopPropertyRow label="严重级别" value={formatAlertSeverityLabel(selectedAlert.severity)} highlight={selectedAlert.severity === "critical"} />
                                  <DesktopPropertyRow label="来源" value={formatRuntimeSourceLabel(selectedAlert.source)} />
                                  <DesktopPropertyRow label="类型" value={formatAlertTypeLabel(selectedAlert.alert_type)} />
                                  <DesktopPropertyRow label="资源" value={selectedAlert.resource || "—"} />
                                  <DesktopPropertyRow label="动作" value={selectedAlert.action || "—"} />
                                  <DesktopPropertyRow label="会话 ID" value={selectedAlert.session_id} />
                                  <DesktopPropertyRow label="工作区" value={selectedAlert.workspace_path || "—"} />
                                </div>
                              </section>

                              <section className="overflow-hidden rounded-md border border-[#eceef1] bg-white shadow-sm">
                                <div className="border-b border-[#f1f3f5] bg-[#fbfcfd] px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                                  原因与证据
                                </div>
                                <div className="space-y-3 p-4">
                                  <div className="text-[12px] font-medium leading-relaxed text-[#1e293b]">{guardAlertReason(selectedAlert)}</div>
                                  {guardAlertEvidence(selectedAlert).length > 0 ? (
                                    <div className="flex flex-wrap gap-2">
                                      {guardAlertEvidence(selectedAlert).map((item) => (
                                        <span key={`${selectedAlert.id}-${item}`} className="rounded-sm border border-[#fecaca] bg-[#fff1f2] px-2 py-1 text-[9px] font-black text-[#dc2626]">
                                          {item}
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              </section>

                              {alertDetailsExpanded[selectedAlert.id] ? (
                                <section className="overflow-hidden rounded-md border border-[#eceef1] bg-white shadow-sm">
                                  <div className="border-b border-[#f1f3f5] bg-[#fbfcfd] px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                                    扩展元数据
                                  </div>
                                  <div className="divide-y divide-[#f1f3f5] px-4 py-1">
                                    <DesktopPropertyRow label="Channel" value={guardAlertChannel(selectedAlert) || "—"} />
                                    <DesktopPropertyRow label="Requester" value={guardAlertRequester(selectedAlert) || "—"} />
                                    <DesktopPropertyRow label="Policy" value={String(selectedAlert.alert_type || "—")} />
                                    <DesktopPropertyRow label="Time" value={formatRuntimeTableDateTime(selectedAlert.event_time)} />
                                  </div>
                                </section>
                              ) : null}
                            </div>

                            <div className="space-y-4">
                              <section className="overflow-hidden rounded-md border border-[#dbe4ee] bg-[#f8fafc] shadow-sm">
                                <div className="border-b border-[#e2e8f0] bg-[#fbfcfe] px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                                  Raw Payload
                                </div>
                                <pre className="hover-scrollbar max-h-[360px] overflow-auto p-4 font-mono text-[11px] leading-relaxed text-[#475569] whitespace-pre-wrap break-all">
                                  {formatRuntimeDetails(selectedAlert.details_json)}
                                </pre>
                              </section>

                              {guardAlertPreview(selectedAlert) ? (
                                <section className="overflow-hidden rounded-md border border-[#eceef1] bg-[#f8fafc] shadow-sm">
                                  <div className="border-b border-[#f1f3f5] px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                                    Preview
                                  </div>
                                  <pre className="hover-scrollbar max-h-[180px] overflow-auto p-4 font-mono text-[11px] leading-relaxed text-[#475569] whitespace-pre-wrap break-all">
                                    {guardAlertPreview(selectedAlert)}
                                  </pre>
                                </section>
                              ) : null}

                              {guardAlertRedactedOutput(selectedAlert) ? (
                                <section className="overflow-hidden rounded-md border border-[#eceef1] bg-[#f8fafc] shadow-sm">
                                  <div className="border-b border-[#f1f3f5] px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-[#94a3b8]">
                                    Redacted Output
                                  </div>
                                  <pre className="hover-scrollbar max-h-[180px] overflow-auto p-4 font-mono text-[11px] leading-relaxed text-[#475569] whitespace-pre-wrap break-all">
                                    {guardAlertRedactedOutput(selectedAlert)}
                                  </pre>
                                </section>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </section>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function GuardActionLoadingOverlay({ action }: { action: GuardActionIntent }) {
  if (!action) return null;

  const title = action === "start" ? "正在启动实时防护" : "正在停止实时防护";
  const description =
    action === "start"
      ? "正在连接 desktop Guard sidecar、同步防护状态并准备拦截链路。"
      : "正在关闭防护服务并清理当前防护状态。";

  return (
    <div className="pointer-events-none absolute bottom-6 right-6 z-40">
      <div className="w-[340px] rounded-[24px] border border-[rgba(181,71,8,0.14)] bg-white/96 p-4 shadow-[0_18px_60px_rgba(15,23,42,0.14)]">
        <div className="flex items-center gap-3">
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center">
            <span className="absolute inset-0 rounded-full bg-[#fff7ed] animate-ping opacity-60" />
            <span className="absolute inset-[5px] rounded-full border-2 border-[#fed7aa]" />
            <span className="h-6 w-6 rounded-full border-[3px] border-[#fdba74] border-t-[#b54708] animate-spin" />
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold tracking-[-0.02em] text-[#243042]">{title}</div>
            <div className="mt-0.5 text-[11px] leading-5 text-[#667085]">{description}</div>
          </div>
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#fff3e8]">
          <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-[#f59e0b] via-[#fb923c] to-[#b54708] animate-[pulse_1.2s_ease-in-out_infinite]" />
        </div>
      </div>
    </div>
  );
}

function RuntimeStatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "blue" | "green" | "amber" | "red" | "neutral";
}) {
  const toneClass =
    tone === "green"
      ? "bg-[#e9f9ef] text-[#166534]"
      : tone === "amber"
        ? "bg-[#fff7e8] text-[#b54708]"
        : tone === "red"
          ? "bg-[#fdecec] text-[#b42318]"
          : tone === "blue"
            ? "bg-[#eef5ff] text-[#175cd3]"
            : "bg-[#f3f4f6] text-[#526071]";
  const dotClass =
    tone === "green"
      ? "bg-[#22c55e]"
      : tone === "amber"
        ? "bg-[#f59e0b]"
        : tone === "red"
          ? "bg-[#d92d20]"
          : tone === "blue"
            ? "bg-[#2f76e9]"
            : "bg-[#98a2b3]";

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${toneClass}`}>
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      {label}
    </span>
  );
}

function RuntimeSignalCard({
  title,
  detail,
  tone,
}: {
  title: string;
  detail: string;
  tone: "blue" | "green" | "red" | "neutral";
}) {
  const toneClass =
    tone === "green"
      ? "border-[#d4f1dd] bg-[#f3fcf6]"
      : tone === "red"
        ? "border-[#f6d8d8] bg-[#fff8f8]"
        : tone === "blue"
          ? "border-[#dbe8ff] bg-[#f8fbff]"
          : "border-[#e7edf5] bg-white";

  return (
    <div className={`rounded-xl border px-3 py-3 ${toneClass}`}>
      <div className="text-[12px] font-semibold text-[#243042]">{title}</div>
      <div className="mt-1 text-[11px] leading-5 text-[#667085]">{detail}</div>
    </div>
  );
}

function RuntimeInlineNote({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone: "blue" | "amber" | "red";
}) {
  const toneClass =
    tone === "red"
      ? "border-[#f6d8d8] bg-[#fff8f8]"
      : tone === "amber"
        ? "border-[#f6e0b8] bg-[#fffaf3]"
        : "border-[#dbe8ff] bg-[#f8fbff]";
  const titleClass =
    tone === "red"
      ? "text-[#b42318]"
      : tone === "amber"
        ? "text-[#9a6700]"
        : "text-[#175cd3]";

  return (
    <div className={`rounded-xl border px-3 py-3 ${toneClass}`}>
      <div className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${titleClass}`}>{title}</div>
      <div className="mt-1 text-[12px] font-medium text-[#243042]">{body}</div>
    </div>
  );
}

function RuntimeSummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">{label}</div>
      <div className="mt-1 text-[15px] font-semibold leading-5 text-[#0f172a]">{value}</div>
    </div>
  );
}

function RuntimeFilterSelect({
  children,
  className = "",
  containerClassName = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  children: ReactNode;
  containerClassName?: string;
}) {
  return (
    <div className={`relative inline-flex shrink-0 ${containerClassName}`.trim()}>
      <select
        {...props}
        className={`h-7 appearance-none rounded-md border border-[#dfe3e8] bg-[#f8fafc] pl-2 pr-7 font-bold text-[#64748b] outline-none transition hover:bg-white focus:border-[#2563eb] focus:bg-white ${className}`.trim()}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[#94a3b8]">
        <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8">
          <path d="m5 7 5 5 5-5" />
        </svg>
      </span>
    </div>
  );
}

function ToolInsightPanel({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: Array<{ key: string; label: string; detail: string }>;
  emptyText: string;
}) {
  return (
    <section className="rounded-2xl border border-[#e7edf5] bg-white px-4 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8ea0b6]">{title}</div>
      <div className="mt-3 space-y-2">
        {items.length === 0 ? (
          <div className="rounded-lg bg-[#fbfcfe] px-3 py-3 text-[12px] text-[#8ea0b6]">{emptyText}</div>
        ) : (
          items.map((item, index) => (
            <div key={item.key} className="flex items-start justify-between gap-3 rounded-lg bg-[#fbfcfe] px-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-white px-1.5 text-[10px] font-semibold text-[#8ea0b6]">
                    {index + 1}
                  </span>
                  <div className="truncate text-[12px] font-semibold text-[#243042]">{item.label}</div>
                </div>
                <div className="mt-1 text-[11px] text-[#8a94a6]">{item.detail}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function PaginationControls({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number | ((current: number) => number)) => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onChange((current) => Math.max(1, current - 1))}
        className="rounded-md border border-[#cbd5e1] bg-white px-2 py-1 text-[11px] font-medium text-[#475569] transition hover:border-[#94a3b8] hover:text-[#0f172a] disabled:cursor-not-allowed disabled:opacity-50"
      >
        上一页
      </button>
      <span className="text-[11px] text-[#94a3b8]">
        {page} / {pageCount}
      </span>
      <button
        type="button"
        disabled={page >= pageCount}
        onClick={() => onChange((current) => Math.min(pageCount, current + 1))}
        className="rounded-md border border-[#cbd5e1] bg-white px-2 py-1 text-[11px] font-medium text-[#475569] transition hover:border-[#94a3b8] hover:text-[#0f172a] disabled:cursor-not-allowed disabled:opacity-50"
      >
        下一页
      </button>
    </div>
  );
}

function RuntimeEventDetails({
  eventType,
  detailsJson,
  expanded,
  onToggle,
  viewMode,
}: {
  eventType: string;
  detailsJson: string;
  expanded: boolean;
  onToggle: () => void;
  viewMode: "summary" | "list";
}) {
  const [copiedPayload, setCopiedPayload] = useState(false);
  const summary = useMemo(
    () => (viewMode === "summary" ? summarizeRuntimeEventDetails(eventType, detailsJson) : EMPTY_RUNTIME_EVENT_SUMMARY),
    [detailsJson, eventType, viewMode],
  );
  const hasSummaryContent = summary.items.length > 0 || Boolean(summary.body);
  const detailView = useMemo(() => {
    const formattedDetails = formatRuntimeDetails(detailsJson);
    const lines = formattedDetails.split("\n");
    return {
      canCollapse: lines.length > 8 || formattedDetails.length > 480,
      formattedDetails,
      hasDetails: formattedDetails.trim().length > 0,
      preview: lines.slice(0, 8).join("\n"),
    };
  }, [detailsJson]);
  useEffect(() => {
    if (!copiedPayload) return;
    const timeoutId = window.setTimeout(() => setCopiedPayload(false), 1200);
    return () => window.clearTimeout(timeoutId);
  }, [copiedPayload]);

  const handleCopyPayload = async () => {
    await navigator.clipboard.writeText(detailView.formattedDetails);
    setCopiedPayload(true);
  };

  if (viewMode === "list") {
    if (!expanded) {
      return null;
    }

    return (
      <div className="mt-3 overflow-hidden rounded-md border border-[#dbe4ee] bg-[#f8fafc]">
        <div className="flex items-center justify-between gap-3 border-b border-[#e2e8f0] bg-[#fbfcfe] px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">
            原始载荷
          </div>
          <button
            type="button"
            onClick={() => void handleCopyPayload()}
            className="rounded-md border border-[#dbe4ee] bg-white px-2 py-1 text-[10px] font-bold text-[#64748b] transition hover:border-[#cbd5e1] hover:text-[#1e293b]"
          >
            {copiedPayload ? "已复制" : "复制"}
          </button>
        </div>
        <pre className="hover-scrollbar max-h-[280px] overflow-auto px-3 py-3 font-mono text-[11px] leading-5 text-[#475569] whitespace-pre-wrap break-all">
          {detailView.formattedDetails}
        </pre>
      </div>
    );
  }

  if (viewMode === "summary") {
    if (!expanded || !hasSummaryContent) {
      return null;
    }

    return (
      <div className="mt-3 space-y-3">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {summary.items.map((item) => (
            <div key={item.label} className="rounded-md border border-[#dbe4ee] bg-white px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">{item.label}</div>
              <div className="mt-1 text-[12px] font-medium leading-5 text-[#0f172a] break-all">{item.value}</div>
            </div>
          ))}
        </div>
        {summary.body ? (
          <div className="rounded-md border border-[#dbe4ee] bg-[#fbfcfe] px-3 py-3 text-[12px] leading-6 text-[#475569]">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">{formatRuntimeBodyLabel(eventType)}</div>
            {summary.body}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      <div className="overflow-hidden rounded-md border border-[#dbe4ee] bg-[#f8fafc]">
        <div className="border-b border-[#e2e8f0] bg-[#fbfcfe] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">
          控制台摘录
        </div>
        <pre className={`px-3 py-3 font-mono text-[11px] leading-5 text-[#475569] whitespace-pre-wrap break-all ${expanded ? "" : "max-h-[220px] overflow-hidden"}`}>
        {expanded || !detailView.canCollapse ? detailView.formattedDetails : detailView.preview}
        </pre>
      </div>
    </div>
  );
}

function formatRuntimeDetails(detailsJson: string) {
  try {
    return JSON.stringify(JSON.parse(detailsJson), null, 2);
  } catch {
    return detailsJson;
  }
}

function summarizeRuntimeEventDetails(eventType: string, detailsJson: string) {
  try {
    const parsed = JSON.parse(detailsJson) as Record<string, unknown>;
    const attrs = isRecord(parsed.attributes) ? parsed.attributes : null;
    const items: Array<{ label: string; value: string }> = [];

    const push = (label: string, value: unknown) => {
      const normalized = formatRuntimeSummaryValue(value);
      if (!normalized) return;
      if (!items.some((item) => item.label === label && item.value === normalized)) {
        items.push({ label, value: normalized });
      }
    };

    if (eventType === "model_response") {
      push("提供方", parsed.provider);
      push("模型", parsed.model);
      push("输入 Token", parsed.input_tokens);
      push("输出 Token", parsed.output_tokens);
      push("缓存 Token", parsed.cached_input_tokens);
      push("思考 Token", parsed.thought_tokens);
      push("工具 Token", parsed.tool_tokens);
      push("延迟", formatLatencyValue(parsed.latency_ms));
      push("成本", formatCostValue(parsed.estimated_cost_usd));
    } else if (eventType.endsWith("_guard")) {
      push("策略", parsed.policy);
      push("动作", parsed.action);
      push("评分", parsed.score);
      push("资源", parsed.resource);
      push("渠道", parsed.channel);
      push("请求方", parsed.requester_id);
      push("是否阻断", parsed.blocked);
    } else if (eventType === "tool_finished") {
      push("工具", parsed.tool_name);
      push("状态", parsed.status);
      push("决策", parsed.decision);
      push("延迟", formatLatencyValue(parsed.latency_ms));
      push("Span", parsed.span_name);
    } else if (eventType === "security_alert") {
      push("策略", attrs?.policy);
      push("风险", attrs?.risk_level);
      push("来源", parsed.service_name ?? parsed.scope_name);
    } else {
      push("来源", parsed.source);
      push("服务", parsed.service_name);
      push("范围", parsed.scope_name);
      push("延迟", formatLatencyValue(parsed.latency_ms));
    }

    push("来源", parsed.source);
    push("服务", parsed.service_name);
    push("范围", parsed.scope_name);
    push("开始时间", parsed.span_started_at);
    push("提示 ID", parsed.prompt_id);
    push("提示长度", parsed.prompt_length);
    push("HTTP 状态", attrs?.["http.status_code"]);
    push("认证方式", attrs?.auth_type);

    return {
      items: items.slice(0, 9),
      body: firstNonEmptyText([parsed.body, parsed.prompt, parsed.preview, parsed.redacted_output]),
    };
  } catch {
    return { items: [], body: "" };
  }
}

function hasRuntimeStructuredSummary(eventType: string, detailsJson: string) {
  const summary = summarizeRuntimeEventDetails(eventType, detailsJson);
  return summary.items.length > 0 || Boolean(summary.body);
}

function areRuntimeSessionsEqual(left: RuntimeSession[], right: RuntimeSession[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((session, index) => {
    const next = right[index];
    return (
      Boolean(next) &&
      session.id === next.id &&
      session.source_updated_at === next.source_updated_at &&
      session.ended_at === next.ended_at &&
      session.status === next.status &&
      session.risk_level === next.risk_level &&
      session.summary === next.summary &&
      session.duration_ms === next.duration_ms &&
      session.total_events === next.total_events &&
      session.security_events === next.security_events &&
      session.findings_count === next.findings_count &&
      session.model_calls === next.model_calls &&
      session.tool_calls === next.tool_calls &&
      session.total_input_tokens === next.total_input_tokens &&
      session.total_output_tokens === next.total_output_tokens &&
      session.total_cost_usd === next.total_cost_usd &&
      session.avg_latency_ms === next.avg_latency_ms
    );
  });
}

function areRuntimeAlertsEqual(left: RuntimeSecurityAlert[], right: RuntimeSecurityAlert[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((alert, index) => {
    const next = right[index];
    return (
      Boolean(next) &&
      alert.id === next.id &&
      alert.session_id === next.session_id &&
      alert.event_time === next.event_time &&
      alert.severity === next.severity &&
      alert.title === next.title &&
      alert.alert_type === next.alert_type &&
      alert.resource === next.resource &&
      alert.action === next.action &&
      alert.blocked === next.blocked &&
      alert.reason === next.reason &&
      alert.details_json === next.details_json
    );
  });
}

function areRuntimeToolStatsEqual(left: RuntimeToolStat[], right: RuntimeToolStat[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((tool, index) => {
    const next = right[index];
    return (
      Boolean(next) &&
      tool.tool_name === next.tool_name &&
      tool.total_calls === next.total_calls &&
      tool.success_calls === next.success_calls &&
      tool.failure_calls === next.failure_calls &&
      tool.avg_latency_ms === next.avg_latency_ms &&
      tool.max_latency_ms === next.max_latency_ms &&
      tool.last_called_at === next.last_called_at &&
      tool.session_count === next.session_count
    );
  });
}

function areRuntimeHostStatusesEqual(
  left: RuntimeHostStatus[],
  right: RuntimeHostStatus[],
  detail: RuntimeRefreshDetailLevel = "full",
) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((host, index) => {
    const next = right[index];
    if (detail === "summary") {
      return Boolean(next) && host.key === next.key && host.detected === next.detected;
    }
    return (
      Boolean(next) &&
      host.key === next.key &&
      host.label === next.label &&
      host.capability_level === next.capability_level &&
      host.status === next.status &&
      host.detected === next.detected &&
      host.detail === next.detail
    );
  });
}

function areRuntimeGuardStatusesEqual(
  left: RuntimeGuardStatus | null,
  right: RuntimeGuardStatus | null,
  detail: RuntimeRefreshDetailLevel = "full",
) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (detail === "summary") {
    return left.reachable === right.reachable && left.pending_action === right.pending_action;
  }
  return (
    left.reachable === right.reachable &&
    left.managed_by_desktop === right.managed_by_desktop &&
    left.pending_action === right.pending_action &&
    left.error === right.error
  );
}

function isRuntimeGuardStarting(status: RuntimeGuardStatus | null) {
  return status?.pending_action === "starting";
}

function resolveRuntimeGuardTone(status: RuntimeGuardStatus | null) {
  if (isRuntimeGuardStarting(status)) {
    return "blue" as const;
  }
  return status?.reachable ? "green" as const : "red" as const;
}

function formatRuntimeGuardBadge(status: RuntimeGuardStatus | null) {
  if (isRuntimeGuardStarting(status)) {
    return "Guard 启动中";
  }
  return status?.reachable ? "Guard 在线" : "Guard 离线";
}

function formatRuntimeGuardStateValue(status: RuntimeGuardStatus | null) {
  if (isRuntimeGuardStarting(status)) {
    return "启动中";
  }
  return status?.reachable ? "在线" : "离线";
}

function formatRuntimeGuardAvailability(status: RuntimeGuardStatus | null) {
  if (isRuntimeGuardStarting(status)) {
    return "服务启动中";
  }
  return status?.reachable ? "服务可达" : "服务不可达";
}

function formatRuntimeGuardDescription(status: RuntimeGuardStatus | null) {
  if (isRuntimeGuardStarting(status)) {
    return "防护服务启动中，桌面正在等待 Guard 服务就绪。";
  }
  return status?.reachable
    ? "防护服务在线，正在接收并裁决运行时请求。"
    : "防护服务离线，当前无法执行拦截。";
}

function areCodexGuardAdapterStatusesEqual(
  left: CodexGuardAdapterStatus | null,
  right: CodexGuardAdapterStatus | null,
  detail: RuntimeRefreshDetailLevel = "full",
) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (detail === "summary") {
    return left.detected === right.detected && left.status === right.status;
  }
  return (
    left.detected === right.detected &&
    left.support_level === right.support_level &&
    left.status === right.status &&
    left.experimental_soft_stop_enabled === right.experimental_soft_stop_enabled &&
    left.processed_events_total === right.processed_events_total &&
    left.blocked_events_total === right.blocked_events_total &&
    left.last_synced_at === right.last_synced_at &&
    left.last_error === right.last_error
  );
}

function areRuntimeIngestConfigsEqual(left: RuntimeIngestConfig | null, right: RuntimeIngestConfig | null) {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.health_url === right.health_url &&
    left.running === right.running &&
    left.otlp_logs_endpoint === right.otlp_logs_endpoint &&
    left.otlp_traces_endpoint === right.otlp_traces_endpoint &&
    left.otlp_metrics_endpoint === right.otlp_metrics_endpoint
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatRuntimeSummaryValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "是" : "否";
  return "";
}

function formatLatencyValue(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  return `${Math.round(value)}ms`;
}

function formatCostValue(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  return formatUsd(value);
}

function firstNonEmptyText(values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function formatRuntimeBodyLabel(eventType: string) {
  if (eventType === "model_response") return "模型响应";
  if (eventType === "user_message") return "用户输入";
  if (eventType === "tool_finished") return "工具输出";
  if (eventType === "security_alert") return "事件详情";
  if (eventType.endsWith("_guard")) return "Guard Payload";
  return "补充信息";
}

function formatCompactNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function formatLatency(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "暂无";
  return `${Math.round(value)}ms`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(value * 100)}%`;
}

function compareRuntimeTimestamps(left: string, right: string) {
  const leftValue = Date.parse(left);
  const rightValue = Date.parse(right);
  if (Number.isNaN(leftValue) || Number.isNaN(rightValue)) {
    return left.localeCompare(right);
  }
  return leftValue - rightValue;
}

function resolveInitialRuntimeTab(initialMode: string | null, initialTab: string | null): RuntimeTab {
  if (initialTab === "telemetry_sessions") return "sessions";
  if (initialTab === "alerts" || initialTab === "blocked") return "alerts";
  if (initialTab === "guard_overview") return "protection";
  if (initialTab === "tools") return "overview";
  if (initialMode === "guard") return "alerts";
  return "overview";
}

function mergeRuntimeSessions(
  observedSessions: RuntimeSession[],
  guardSessions: RuntimeSession[],
) {
  const merged = new Map<string, RuntimeSession>();

  for (const session of observedSessions) {
    merged.set(session.id, { ...session });
  }

  for (const guardSession of guardSessions) {
    const existing = merged.get(guardSession.id);
    if (!existing) {
      merged.set(guardSession.id, { ...guardSession });
      continue;
    }

    merged.set(guardSession.id, {
      ...existing,
      workspace_path: existing.workspace_path || guardSession.workspace_path,
      started_at:
        compareRuntimeTimestamps(existing.started_at, guardSession.started_at) <= 0
          ? existing.started_at
          : guardSession.started_at,
      ended_at: latestOptionalTimestamp(existing.ended_at, guardSession.ended_at),
      source_updated_at: latestOptionalTimestamp(existing.source_updated_at, guardSession.source_updated_at),
      status: mergeRuntimeStatus(existing.status, guardSession.status),
      risk_level: maxRiskLevel(existing.risk_level, guardSession.risk_level),
      summary: existing.summary || guardSession.summary,
      duration_ms: maxOptionalNumber(existing.duration_ms, guardSession.duration_ms),
      total_events: existing.total_events + guardSession.total_events,
      security_events: existing.security_events + guardSession.security_events,
      findings_count: existing.findings_count + guardSession.findings_count,
      model_calls: existing.model_calls,
      tool_calls: existing.tool_calls,
      total_input_tokens: existing.total_input_tokens,
      total_output_tokens: existing.total_output_tokens,
      total_cost_usd: existing.total_cost_usd,
      avg_latency_ms: existing.avg_latency_ms > 0 ? existing.avg_latency_ms : guardSession.avg_latency_ms,
    });
  }

  return [...merged.values()].sort((left, right) =>
    compareRuntimeTimestamps(runtimeSessionSortTimestamp(right), runtimeSessionSortTimestamp(left)),
  );
}

function mergeRuntimeAlerts(
  alerts: RuntimeSecurityAlert[],
  blockedAlerts: RuntimeSecurityAlert[],
) {
  const merged = new Map<number, RuntimeSecurityAlert>();

  for (const alert of alerts) {
    merged.set(alert.id, { ...alert, blocked: alert.blocked || blockedAlerts.some((item) => item.id === alert.id) });
  }

  for (const blockedAlert of blockedAlerts) {
    const existing = merged.get(blockedAlert.id);
    merged.set(blockedAlert.id, {
      ...(existing ?? blockedAlert),
      ...blockedAlert,
      blocked: true,
    });
  }

  return [...merged.values()].sort((left, right) => compareRuntimeTimestamps(right.event_time, left.event_time));
}

function latestOptionalTimestamp(left: string | null | undefined, right: string | null | undefined) {
  if (!left) return right ?? null;
  if (!right) return left;
  return compareRuntimeTimestamps(left, right) >= 0 ? left : right;
}

function maxOptionalNumber(left: number | null | undefined, right: number | null | undefined) {
  if (typeof left !== "number") return typeof right === "number" ? right : null;
  if (typeof right !== "number") return left;
  return Math.max(left, right);
}

function mergeRuntimeStatus(left: string, right: string) {
  if (left === "active" || right === "active") return "active";
  return right || left;
}

function maxRiskLevel(left: string, right: string) {
  const weight = (value: string) => {
    if (value === "high" || value === "critical") return 3;
    if (value === "medium" || value === "warning") return 2;
    return 1;
  };
  return weight(left) >= weight(right) ? left : right;
}

function resolveSessionFeed(
  sessionId: string,
  preferredFeed: RuntimeSessionFeed,
  observedSessions: RuntimeSession[],
  guardSessions: RuntimeSession[],
): Exclude<RuntimeSessionFeed, "all"> {
  if (preferredFeed === "observed" || preferredFeed === "guard") {
    return preferredFeed;
  }
  if (observedSessions.some((session) => session.id === sessionId)) {
    return "observed";
  }
  if (guardSessions.some((session) => session.id === sessionId)) {
    return "guard";
  }
  return "observed";
}

function toolFailureRate(tool: RuntimeToolStat) {
  if (!tool.total_calls || tool.total_calls <= 0) return 0;
  return tool.failure_calls / tool.total_calls;
}

function formatSessionTimestamp(session: RuntimeSession) {
  const updatedAt = session.source_updated_at ? new Date(session.source_updated_at) : null;
  if (updatedAt && !Number.isNaN(updatedAt.getTime())) {
    return `最近活跃 ${updatedAt.toLocaleString([], {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }

  const startedAt = new Date(session.started_at);
  const startedLabel = startedAt.toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (!session.ended_at) return startedLabel;
  const endedAt = new Date(session.ended_at);
  const endedLabel = endedAt.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${startedLabel} - ${endedLabel}`;
}

function runtimeSessionSortTimestamp(session: RuntimeSession) {
  return session.source_updated_at || session.ended_at || session.started_at;
}

function formatRuntimeTableDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatOptionalDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return formatRuntimeTableDateTime(value);
}

function parseOptionalInt(value: string | null) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function waitForNextPaint() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function safeParseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function guardAlertDetails(alert: RuntimeSecurityAlert) {
  return safeParseJsonObject(alert.details_json);
}

function guardAlertReason(alert: RuntimeSecurityAlert) {
  const details = guardAlertDetails(alert);
  const reason = details?.reason;
  if (typeof reason === "string" && reason.trim()) return reason;
  if (alert.reason.trim()) return alert.reason.trim();
  return "暂无详细原因。";
}

function guardAlertEvidence(alert: RuntimeSecurityAlert) {
  const details = guardAlertDetails(alert);
  const evidence = details?.evidence;
  if (!Array.isArray(evidence)) return [] as string[];
  return evidence
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);
}

function guardAlertChannel(alert: RuntimeSecurityAlert) {
  const details = guardAlertDetails(alert);
  return typeof details?.channel === "string" ? details.channel : "";
}

function guardAlertRequester(alert: RuntimeSecurityAlert) {
  const details = guardAlertDetails(alert);
  return typeof details?.requester_id === "string" ? details.requester_id : "";
}

function guardAlertPreview(alert: RuntimeSecurityAlert) {
  const details = guardAlertDetails(alert);
  return typeof details?.preview === "string" ? details.preview : "";
}

function guardAlertRedactedOutput(alert: RuntimeSecurityAlert) {
  const details = guardAlertDetails(alert);
  return typeof details?.redacted_output === "string" ? details.redacted_output : "";
}

function guardAlertSupportsManualIntervention(alert: RuntimeSecurityAlert) {
  if (!alert.blocked || alert.source !== "codex") return false;
  const details = guardAlertDetails(alert);
  const extra = details?.extra;
  if (!extra || typeof extra !== "object") return false;
  const toolName = (extra as Record<string, unknown>).tool_name;
  return toolName === "exec" || toolName === "exec_command" || toolName === "shell_command";
}

function buildGuardAuditSummary(alert: RuntimeSecurityAlert) {
  const parts = [
    `Title: ${alert.title}`,
    `Time: ${formatRuntimeTableDateTime(alert.event_time)}`,
    `Source: ${formatRuntimeSourceLabel(alert.source)}`,
    `Session: ${alert.session_id}`,
    `Severity: ${formatAlertSeverityLabel(alert.severity)}`,
    `Action: ${alert.action || "-"}`,
    `Blocked: ${alert.blocked ? "Yes" : "No"}`,
    `Policy: ${alert.alert_type || "-"}`,
    `Resource: ${alert.resource || "-"}`,
    `Workspace: ${alert.workspace_path || "-"}`,
    `Reason: ${guardAlertReason(alert)}`,
  ];
  const evidence = guardAlertEvidence(alert);
  if (evidence.length > 0) {
    parts.push(`Evidence: ${evidence.join(", ")}`);
  }
  const channel = guardAlertChannel(alert);
  if (channel) {
    parts.push(`Channel: ${channel}`);
  }
  const requester = guardAlertRequester(alert);
  if (requester) {
    parts.push(`Requester: ${requester}`);
  }
  const preview = guardAlertPreview(alert);
  if (preview) {
    parts.push(`Preview: ${preview}`);
  }
  const redactedOutput = guardAlertRedactedOutput(alert);
  if (redactedOutput) {
    parts.push(`Redacted Output: ${redactedOutput}`);
  }
  return parts.join("\n");
}

function runtimeEventCategory(event: RuntimeEvent) {
  if (event.event_type.endsWith("_guard")) return "security";
  if (event.event_type === "security_alert" || event.severity === "critical") return "security";
  if (event.event_type.startsWith("tool_")) return "tool";
  if (event.event_type.startsWith("model_")) return "model";
  return "all";
}

function formatRuntimeSourceLabel(source: string) {
  if (source === "tma1") return "TMA 运行时会话";
  if (source === "otlp") return "OTLP 运行时会话";
  if (source === "codex") return "Codex 运行时会话";
  if (source === "claude") return "Claude 运行时会话";
  if (source === "gemini") return "Gemini 运行时会话";
  if (source === "qwen") return "Qwen 运行时会话";
  if (source === "opencode") return "OpenCode 运行时会话";
  if (source === "openclaw") return "OpenClaw 运行时会话";
  return source ? `${source} 运行时会话` : "运行时会话";
}

function formatRuntimeSourceShortLabel(source: string) {
  if (source === "tma1") return "TMA";
  if (source === "otlp") return "OTLP";
  if (source === "codex") return "Codex";
  if (source === "claude") return "Claude";
  if (source === "gemini") return "Gemini";
  if (source === "qwen") return "Qwen";
  if (source === "opencode") return "OpenCode";
  if (source === "openclaw") return "OpenClaw";
  return source || "Agent";
}

function formatRuntimeSummaryText(summary: string) {
  const trimmed = summary.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "llm_call") return "模型调用";
  return formatRuntimeEventTitle(trimmed);
}

function formatRuntimeWorkspaceLabel(workspacePath: string) {
  const trimmed = workspacePath.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : "";
}

function runtimeSessionHeadline(
  session: RuntimeSession,
  feed: Exclude<RuntimeSessionFeed, "all">,
) {
  const summary =
    feed === "guard"
      ? session.summary.trim()
      : formatRuntimeSummaryText(session.summary).trim();
  if (summary) return summary;

  const workspaceLabel = formatRuntimeWorkspaceLabel(session.workspace_path);
  if (feed === "guard") {
    return workspaceLabel ? `${workspaceLabel} 防护事件` : "未命名防护事件";
  }

  return workspaceLabel ? `${workspaceLabel} 会话` : "未命名运行时会话";
}

function formatRuntimeEventTypeLabel(eventType: string) {
  if (eventType === "model_response") return "模型响应";
  if (eventType === "user_message") return "用户输入";
  if (eventType === "tool_finished") return "工具完成";
  if (eventType === "security_alert") return "安全告警";
  if (eventType === "prompt_guard") return "Prompt Guard";
  if (eventType === "tool_call_guard") return "Tool Call Guard";
  if (eventType === "output_guard") return "Output Guard";
  if (eventType === "runtime_log") return "运行日志";
  if (eventType === "trace_span") return "链路 Span";
  return eventType;
}

function formatRuntimeEventTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return trimmed;

  const prefixed = [
    [/^Model span:\s*(.+)$/i, "模型调用：$1"],
    [/^Model response:\s*(.+)$/i, "模型响应：$1"],
    [/^Tool span:\s*(.+)$/i, "工具调用：$1"],
    [/^Tool call:\s*(.+)$/i, "工具调用：$1"],
    [/^Runtime log:\s*(.+)$/i, "运行日志：$1"],
  ] as const;

  for (const [pattern, replacement] of prefixed) {
    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, replacement);
    }
  }

  if (trimmed === "Security event") return "安全事件";
  if (trimmed === "User prompt") return "用户输入";
  return trimmed;
}

function formatRiskLevelLabel(value: unknown) {
  if (value === "high" || value === "critical") return "高危";
  if (value === "medium" || value === "warning") return "中风险";
  if (value === "low" || value === "info") return "低风险";
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function formatAlertSeverityLabel(value: string) {
  if (value === "critical") return "高危";
  if (value === "warning") return "警告";
  if (value === "info") return "提示";
  return value;
}

function formatAlertTypeLabel(value: unknown) {
  if (value === "security_alert" || value === null || value === undefined || value === "") return "安全告警";
  if (typeof value === "string") return value;
  return "安全告警";
}

function formatCodexGuardAdapterStatus(status: CodexGuardAdapterStatus | null) {
  if (!status) return "状态不可用";
  if (!status.detected) return "未检测到可用的 Codex 本地会话";
  if (status.status === "healthy") return "Codex session adapter 正常运行";
  if (status.status === "syncing") return "Codex session adapter 正在同步 Guard Decisions";
  if (status.status === "waiting_for_guard") return "Codex session adapter 等待 desktop Guard 可用";
  if (status.status === "error") return "Codex session adapter 运行异常";
  if (status.status === "idle") return "Codex session adapter 已就绪";
  return status.status || "状态未知";
}

function formatCodexGuardAdapterBadge(status: CodexGuardAdapterStatus | null) {
  if (!status) return "Unavailable";
  if (!status.detected) return "Not Detected";
  if (status.status === "healthy") return "Healthy";
  if (status.status === "syncing") return "Syncing";
  if (status.status === "waiting_for_guard") return "Waiting for Guard";
  if (status.status === "error") return "Error";
  if (status.status === "idle") return "Ready";
  return status.status || "Unknown";
}

function formatCodexGuardStatusCompact(status: CodexGuardAdapterStatus | null) {
  if (!status) return "未知";
  if (!status.detected) return "未检测";
  if (status.status === "healthy") return "正常";
  if (status.status === "syncing") return "同步中";
  if (status.status === "waiting_for_guard") return "等待 Guard";
  if (status.status === "error") return "异常";
  if (status.status === "idle") return "就绪";
  return status.status || "未知";
}

function formatHostCapabilityLevel(value: string) {
  if (value === "enforced") return "Enforced";
  if (value === "soft_enforcement") return "Soft Enforcement";
  if (value === "observed") return "Observed";
  return value || "Unknown";
}

function hostCapabilityBadgeClass(value: string) {
  if (value === "enforced") return "bg-[#e6f7eb] text-[#166534]";
  if (value === "soft_enforcement") return "bg-[#fff7e8] text-[#b54708]";
  if (value === "observed") return "bg-[#eef4ff] text-[#2f76e9]";
  return "bg-[#eef2f6] text-[#516072]";
}

function formatHostRuntimeStatus(status: string, detected: boolean) {
  if (!detected) return "未检测到本机宿主";
  if (status === "healthy") return "运行正常";
  if (status === "syncing") return "正在同步";
  if (status === "observed") return "已连接观测链路";
  if (status === "waiting_for_guard") return "等待 desktop Guard";
  if (status === "waiting_for_bridge") return "等待 OTLP bridge";
  if (status === "idle") return "已就绪";
  if (status === "error") return "运行异常";
  if (status === "unavailable") return "不可用";
  return status || "状态未知";
}

function formatCapabilityLevelLabel(value: string) {
  return formatHostCapabilityLevel(value);
}

function runtimeEventAnchorId(eventId: number) {
  return `runtime-event-${eventId}`;
}

function DesktopSummaryCard({ label, value, total }: { label: string; value: string; total?: number }) {
  return (
    <div className="bg-white px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <div className="text-[20px] font-semibold tracking-[-0.03em] text-[#0f172a]">{value}</div>
        {total !== undefined ? <div className="text-[11px] font-medium text-[#94a3b8]">/ {total}</div> : null}
      </div>
    </div>
  );
}

function DesktopInsightCard({
  tone,
  label,
  title,
  detail,
}: {
  tone: "blue" | "amber" | "red" | "violet";
  label: string;
  title: string;
  detail: string;
}) {
  const toneStyles = {
    blue: {
      border: "border-blue-100",
      bg: "bg-blue-50/50",
      hoverBg: "hover:bg-blue-50",
      text: "text-blue-700",
      dot: "bg-blue-500",
    },
    amber: {
      border: "border-amber-100",
      bg: "bg-amber-50/50",
      hoverBg: "hover:bg-amber-50",
      text: "text-amber-700",
      dot: "bg-amber-500",
    },
    red: {
      border: "border-red-100",
      bg: "bg-red-50/50",
      hoverBg: "hover:bg-red-50",
      text: "text-red-700",
      dot: "bg-red-500",
    },
    violet: {
      border: "border-violet-100",
      bg: "bg-violet-50/50",
      hoverBg: "hover:bg-violet-50",
      text: "text-violet-700",
      dot: "bg-violet-500",
    },
  }[tone];

  return (
    <div className={`rounded-md border ${toneStyles.border} ${toneStyles.bg} ${toneStyles.hoverBg} p-3 transition-colors`}>
      <div className="flex items-center gap-2">
        <div className={`h-1.5 w-1.5 rounded-full ${toneStyles.dot}`} />
        <div className="text-[10px] font-bold uppercase tracking-wider text-[#64748b]">{label}</div>
      </div>
      <div className={`mt-1.5 truncate text-[13px] font-bold ${toneStyles.text}`} title={title}>
        {title}
      </div>
      <div className="mt-0.5 text-[11px] font-medium text-[#94a3b8]">{detail}</div>
    </div>
  );
}

function DesktopEventItem({ event, isTargeted, category }: { event: any; isTargeted: boolean; category: string }) {
  const categoryStyles = {
    security: "border-red-100 bg-red-50/30 text-red-700",
    tool: "border-blue-100 bg-blue-50/30 text-blue-700",
    model: "border-purple-100 bg-purple-50/30 text-purple-700",
    all: "border-[#e2e8f0] bg-white text-[#475569]",
  }[category] || "border-[#e2e8f0] bg-white text-[#475569]";

  return (
    <div
      id={runtimeEventAnchorId(event.id)}
      className={`rounded-md border p-3 transition-all ${
        isTargeted ? "border-orange-300 bg-orange-50 ring-1 ring-orange-200" : categoryStyles
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">
              {formatRuntimeEventTypeLabel(event.event_type)}
            </span>
            <h4 className="text-[13px] font-bold truncate">
              {formatRuntimeEventTitle(event.title)}
            </h4>
          </div>
          <div className="mt-1 text-[11px] opacity-60">
            {new Date(event.event_time).toLocaleString()}
          </div>
        </div>
      </div>
      <div className="mt-2 overflow-hidden rounded border border-[#dbe4ee] bg-[#f8fafc] p-2 font-mono text-[11px] leading-relaxed text-[#475569]">
         <div className="whitespace-pre-wrap break-all">
            {event.details_json}
         </div>
      </div>
    </div>
  );
}

function DesktopAlertItem({ alert, isActive, onClick }: { alert: any; isActive: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-b border-[#eef2f7] px-4 py-3 text-left transition last:border-b-0 ${
        isActive ? "bg-[#fff7ed]" : "bg-white hover:bg-[#f8fafc]"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${alert.blocked ? "bg-[#dc2626]" : "bg-[#ea580c]"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold ${
              alert.blocked ? "bg-[#fff1f2] text-[#b91c1c]" : "bg-[#fff7ed] text-[#c2410c]"
            }`}>
              {alert.blocked ? "BLOCKED" : "OBSERVED"}
            </span>
            <span className="rounded-sm bg-[#f1f5f9] px-1.5 py-0.5 text-[10px] font-semibold text-[#475569]">
              {formatAlertSeverityLabel(alert.severity)}
            </span>
            <span className="text-[10px] font-medium text-[#94a3b8]">{formatRuntimeTableDateTime(alert.event_time)}</span>
          </div>
          <div className={`mt-1.5 line-clamp-2 text-[12px] font-medium leading-5 ${isActive ? "text-[#9a3412]" : "text-[#0f172a]"}`}>
            {alert.title}
          </div>
          <div className="mt-1 truncate text-[11px] text-[#64748b]">
            {guardAlertReason(alert)}
          </div>
          <div className="mt-1 text-[10px] text-[#94a3b8]">
            {formatRuntimeSourceShortLabel(alert.source)} · {formatAlertTypeLabel(alert.alert_type)}
          </div>
        </div>
      </div>
    </button>
  );
}

function DesktopPropertyRow({ label, value, highlight }: { label: string; value: string | React.ReactNode; highlight?: boolean }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">{label}</div>
      <div className={`text-[12px] font-medium break-all ${highlight ? "text-[#b91c1c]" : "text-[#0f172a]"}`}>
        {value}
      </div>
    </div>
  );
}
