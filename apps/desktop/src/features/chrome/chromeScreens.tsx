import { useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import cargoLockRaw from "../../../../../Cargo.lock?raw";
import desktopPackageJson from "../../../package.json";
import type {
  CodexGuardAdapterStatus,
  DesktopShellPreferences,
  RuntimeGuardStatus,
  SkillReport,
} from "../../types";
import type { AppSettings, NavView } from "../../shared/appTypes";
import { DashboardScoreMetric, FooterMetric } from "../../shared/sharedUi";
import {
  DRAG_REGION_STYLE,
  NO_DRAG_REGION_STYLE,
  DEFAULT_SETTINGS,
  basename,
  CloseCircleIcon,
  ExpandSidebarIcon,
  HomeIcon,
  InfoCircleIcon,
  RuntimeIcon,
  SettingsIcon,
  ShieldHeroIcon,
  SidebarAppIcon,
  SkillsIcon,
  ToolboxIcon,
  ToolQuarantineIcon,
  isTauriRuntime,
} from "../../shared/shared";

const APP_VERSION = `v${desktopPackageJson.version}`;
const SECURITY_ENGINE = resolveSecurityEngineMetadata(cargoLockRaw);
const SECURITY_ENGINE_DISPLAY_VERSION = `${SECURITY_ENGINE.version}${SECURITY_ENGINE.revision ? ` · ${SECURITY_ENGINE.revision}` : ""}`;
const METRIC_NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN");
type SettingsSectionKey = "protection" | "desktop" | "paths" | "about";
type PathsConfigTab = "skills" | "mcps";
type GuardActionIntent = "start" | "stop" | null;
type SoftStopIntent = boolean | null;
type NotificationPermissionStatus = "default" | "denied" | "granted" | "unsupported";

export function Sidebar({
  expanded,
  onChange,
  onOpenSettings,
  onToggle,
  view,
}: {
  expanded: boolean;
  onChange: (view: NavView) => void;
  onOpenSettings: () => void;
  onToggle: () => void;
  view: NavView;
}) {
  const width = expanded ? "w-[180px]" : "w-[72px]";
  const labelClass = `overflow-hidden whitespace-nowrap text-sm font-medium transition-all duration-200 ease-in-out ${
    expanded ? "ml-3 max-w-[120px] opacity-100" : "ml-0 max-w-0 opacity-0"
  }`;
  const titleClass = `pointer-events-none overflow-hidden whitespace-nowrap text-xs font-semibold text-[#7b8491] transition-all duration-200 ease-in-out ${
    expanded ? "ml-3 max-w-[120px] opacity-100" : "ml-0 max-w-0 opacity-0"
  }`;
  const subtitleClass = `pointer-events-none overflow-hidden whitespace-nowrap text-[10px] font-medium text-[#a0a8b4] transition-all duration-200 ease-in-out ${
    expanded ? "ml-3 mt-0.5 max-w-[120px] opacity-100" : "ml-0 mt-0 max-w-0 opacity-0"
  }`;
  const items: Array<{ key: NavView; icon: ReactNode; label: string }> = [
    { key: "dashboard", icon: <HomeIcon />, label: "安全概览" },
    { key: "assets", icon: <SkillsIcon />, label: "资产管理" },
    { key: "runtime", icon: <RuntimeIcon />, label: "运行时安全" },
    { key: "toolbox", icon: <ToolboxIcon />, label: "工具箱" },
  ];

  return (
    <aside
      className={`flex ${width} shrink-0 flex-col border-r border-[#eceff3] bg-[#fafafa] py-5 transition-[width] duration-200 ease-in-out`}
    >
      <div
        data-tauri-drag-region
        style={DRAG_REGION_STYLE}
        className={`mb-8 mt-4 flex items-center ${expanded ? "justify-start px-4" : "justify-center"}`}
      >
        <div className="pointer-events-none flex h-11 w-11 items-center justify-center text-[#2f76e9]">
          <SidebarAppIcon />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className={titleClass}>Aegis</span>
          <span className={subtitleClass}>Powered by AOS</span>
        </div>
      </div>

      <nav className={`flex flex-1 flex-col gap-4 ${expanded ? "px-3" : "items-center"}`}>
        {items.map((item) => {
          const active = view === item.key;
          return (
            <button
              key={item.key}
              type="button"
              title={item.label}
              onClick={() => onChange(item.key)}
              className={`flex items-center rounded-xl transition ${
                expanded ? "w-full justify-start px-4 py-3 text-left" : "h-12 w-12 justify-center"
              } ${
                active
                  ? "bg-[#eef5ff] text-[#2f76e9]"
                  : "text-[#9aa4b2] hover:bg-[#f1f5f9] hover:text-[#2f76e9]"
              }`}
            >
              {item.icon}
              <span className={labelClass}>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className={`mt-auto flex flex-col gap-3 ${expanded ? "px-3" : "items-center"}`}>
        <button
          type="button"
          onClick={onOpenSettings}
          className={`flex items-center text-[#a7b0bc] transition hover:text-[#2f76e9] ${
            expanded ? "w-full justify-start rounded-xl px-4 py-3 text-left hover:bg-[#f1f5f9]" : "h-12 w-12 justify-center rounded-xl hover:bg-[#f1f5f9]"
          } ${view === "settings" ? "bg-[#eef5ff] text-[#2f76e9]" : ""}`}
          title="设置"
        >
          <SettingsIcon />
          <span className={labelClass}>设置</span>
        </button>

        <button
          type="button"
          onClick={onToggle}
          className={`flex items-center text-[#a7b0bc] transition hover:text-[#2f76e9] ${
            expanded ? "w-full justify-start rounded-xl px-4 py-3 text-left hover:bg-[#f1f5f9]" : "h-12 w-12 justify-center rounded-xl hover:bg-[#f1f5f9]"
          }`}
          title={expanded ? "收起菜单" : "展开菜单"}
        >
          <ExpandSidebarIcon expanded={expanded} />
          <span className={labelClass}>收起菜单</span>
        </button>
      </div>
    </aside>
  );
}

export function DashboardScreen({
  blockedThreats,
  detectedAgentRuntimes,
  hasLastScan,
  lastScanText,
  loading,
  onOpenActivity,
  onOpenLastScan,
  onScan,
  score,
}: {
  blockedThreats: number;
  detectedAgentRuntimes: number;
  hasLastScan: boolean;
  lastScanText: string;
  loading: boolean;
  onOpenActivity: () => void;
  onOpenLastScan: () => void;
  onScan: () => Promise<void>;
  score: number | null;
}) {
  return (
    <>
      <header
        data-tauri-drag-region
        style={DRAG_REGION_STYLE}
        className="flex h-14 items-center border-b border-[#eef1f4] px-6"
      >
        <div className="flex flex-col">
          <h1 className="text-sm font-semibold uppercase tracking-[0.04em] text-[#7b8491]">
            Aegis
          </h1>
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[#a0a8b4]">
            Powered by AOS
          </div>
        </div>
        <div className="min-h-[40px] flex-1" data-tauri-drag-region style={DRAG_REGION_STYLE} />
      </header>

      <section className="flex flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center px-8 py-10">
          <div className="flex flex-col items-center justify-center">
            <div className="relative mb-6">
              <div className="absolute inset-[-28px] rounded-full bg-[#f3f7ff]" />
              <div className="relative rounded-full border border-[#eef2f6] bg-white p-6 shadow-[0_4px_16px_rgba(16,24,40,0.04)]">
                <ShieldHeroIcon />
              </div>
            </div>
            <h2 className="text-[20px] font-normal text-[#4b5563]">系统已受保护</h2>
            <p className="mt-2 text-sm text-[#a1a9b3]">
              {hasLastScan ? `最近一次完整扫描于 ${lastScanText} 执行。` : "暂未发现完整扫描记录。"}
            </p>
            <button
              type="button"
              onClick={() => void onScan()}
              disabled={loading}
              className="mt-10 rounded-full bg-[#2f76e9] px-12 py-3 text-sm font-medium text-white shadow-[0_10px_24px_rgba(47,118,233,0.18)] transition hover:bg-[#2567d2] disabled:cursor-wait disabled:opacity-70"
            >
              {loading ? "扫描中..." : "执行完整扫描"}
            </button>
            <button
              type="button"
              onClick={onOpenLastScan}
              disabled={!hasLastScan || loading}
              className={`mt-3 text-xs font-medium transition ${
                hasLastScan && !loading
                  ? "text-[#7f8a98] hover:text-[#2f76e9]"
                  : "cursor-not-allowed text-[#c1c9d2]"
              }`}
            >
              {hasLastScan ? "查看上次扫描结果" : "暂无上次扫描结果"}
            </button>
          </div>
        </div>

        <footer className="grid h-28 grid-cols-5 border-t border-[#eef1f4] bg-[#fafafa]">
          <DashboardScoreMetric value={score} />
          <FooterMetric label="实时防护" value="已开启" dot onClick={onOpenActivity} interactive />
          <FooterMetric label="已拦截威胁" value={METRIC_NUMBER_FORMATTER.format(blockedThreats)} />
          <FooterMetric label="Agent 运行时" value={`${METRIC_NUMBER_FORMATTER.format(detectedAgentRuntimes)} 个环境`} />
          <FooterMetric label="引擎版本" value={SECURITY_ENGINE_DISPLAY_VERSION} />
        </footer>
      </section>
    </>
  );
}

export function QuarantineWindowScreen({
  latestScanText,
  onClose,
  quarantined,
}: {
  latestScanText: string;
  onClose: () => void;
  quarantined: SkillReport[];
}) {
  const rows = quarantined.slice(0, 12);

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[#f6f8fb]">
      <div
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-20 h-10 select-none"
        style={DRAG_REGION_STYLE}
      />
      <header
        data-tauri-drag-region
        className="relative border-b border-[#e6ebf2] bg-white pl-20 pr-6 pb-5 pt-4"
        style={DRAG_REGION_STYLE}
      >
        <div className="flex items-start justify-between gap-5">
          <div data-tauri-drag-region className="flex-1" style={DRAG_REGION_STYLE}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">隔离区</div>
            <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#243042]">隔离区</h1>
            <p className="mt-2 text-[14px] text-[#7d8c9f]">
              最近一次扫描时间 {latestScanText}。这里集中处理被判定为高风险的 Skills。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-[#fff5f5] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#ef4444]">
              {rows.length} 个高风险
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-[#dbe3ee] bg-white px-4 py-2.5 text-sm font-medium text-[#516072] transition hover:border-[#c9d6e6] hover:text-[#2f76e9]"
            >
              关闭
            </button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        {rows.length === 0 ? (
          <section className="rounded-[28px] border border-dashed border-[#d8e1eb] bg-white px-8 py-20 text-center shadow-[0_10px_24px_rgba(18,32,56,0.04)]">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[20px] border border-[#e4e9f0] bg-[#fafbfd] text-[#6f7782]">
              <ToolQuarantineIcon />
            </div>
            <h2 className="mt-5 text-[22px] font-semibold tracking-[-0.03em] text-[#243042]">当前没有隔离中的 skills</h2>
            <p className="mt-2 text-[14px] leading-7 text-[#8ea0b6]">
              当 full scan 命中高风险行为时，相关 skills 会出现在这里，方便你统一恢复或删除。
            </p>
          </section>
        ) : (
          <section className="overflow-hidden rounded-[28px] border border-[#dde5ef] bg-white shadow-[0_12px_28px_rgba(18,32,56,0.04)]">
            <div className="flex items-center justify-between border-b border-[#eef2f6] px-6 py-5">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">高风险列表</div>
                <h2 className="mt-2 text-[22px] font-semibold tracking-[-0.03em] text-[#243042]">已隔离 Skills</h2>
              </div>
              <div className="text-[13px] text-[#7d8c9f]">{rows.length} 条记录</div>
            </div>

            <table className="w-full text-left">
              <thead className="bg-[#f8fafc] text-[12px] uppercase tracking-[0.08em] text-[#8694a7]">
                <tr>
                  <th className="px-6 py-4 font-medium">Skill</th>
                  <th className="px-5 py-4 font-medium">风险</th>
                  <th className="px-5 py-4 font-medium">原因</th>
                  <th className="px-6 py-4 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((skill, index) => (
                  <tr key={skill.path} className="border-t border-[#edf1f5]">
                    <td className="px-6 py-5">
                      <div className="text-[15px] font-semibold text-[#344256]">{skill.name}</div>
                      <div className="mt-1 text-[12px] text-[#99a5b5]">
                        {basename(skill.path)} · v{versionStub(index)}
                      </div>
                    </td>
                    <td className="px-5 py-5">
                      <div className="inline-flex items-center gap-2 rounded-full bg-[#fff5f5] px-3 py-1 text-[13px] font-semibold text-[#ef4444]">
                        <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444]" />
                        {skill.risk_score}
                      </div>
                    </td>
                    <td className="px-5 py-5 text-[14px] text-[#657487]">
                      {skill.flags[0] ?? "Detected risky behavior during scan"}
                    </td>
                    <td className="px-6 py-5">
                      <div className="flex items-center justify-end gap-4 text-[13px] font-semibold">
                        <button type="button" className="text-[#2f76e9] transition hover:text-[#215fbc]">
                          恢复
                        </button>
                        <button type="button" className="text-[#ef4444] transition hover:text-[#d83b3b]">
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </main>
  );
}

export function SettingsScreen({
  desktopShellLoading,
  desktopShellPreferences,
  notificationPermission,
  onChange,
  onDesktopShellPreferenceChange,
  onRequestNotificationPermission,
  settings,
}: {
  desktopShellLoading: boolean;
  desktopShellPreferences: DesktopShellPreferences | null;
  notificationPermission: NotificationPermissionStatus;
  onChange: Dispatch<SetStateAction<AppSettings>>;
  onDesktopShellPreferenceChange: (update: Partial<DesktopShellPreferences>) => void;
  onRequestNotificationPermission: () => Promise<void>;
  settings: AppSettings;
}) {
  const [newPath, setNewPath] = useState("");
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>("protection");
  const [pathsTab, setPathsTab] = useState<PathsConfigTab>("skills");
  const [guardStatus, setGuardStatus] = useState<RuntimeGuardStatus | null>(null);
  const [codexGuardAdapterStatus, setCodexGuardAdapterStatus] = useState<CodexGuardAdapterStatus | null>(null);
  const [runtimeControlRefreshing, setRuntimeControlRefreshing] = useState(false);
  const [guardActionPending, setGuardActionPending] = useState(false);
  const [guardActionIntent, setGuardActionIntent] = useState<GuardActionIntent>(null);
  const [softStopPending, setSoftStopPending] = useState(false);
  const [softStopIntent, setSoftStopIntent] = useState<SoftStopIntent>(null);
  const [runtimeControlError, setRuntimeControlError] = useState<string | null>(null);
  const runtimeControlsAvailable = isTauriRuntime();
  const guardReachable = guardStatus?.reachable ?? false;
  const softStopEnabled = codexGuardAdapterStatus?.experimental_soft_stop_enabled ?? false;
  const backendGuardPendingAction = guardStatus?.pending_action ?? null;
  const displayedGuardPendingAction = guardActionPending
    ? guardActionIntent
    : backendGuardPendingAction === "starting"
      ? "start"
      : null;
  const displayedGuardReachable = displayedGuardPendingAction
    ? displayedGuardPendingAction === "start"
    : guardReachable;
  const displayedSoftStopEnabled = softStopPending
    ? softStopIntent ?? softStopEnabled
    : softStopEnabled;
  const runtimeControlsBusy =
    runtimeControlRefreshing || guardActionPending || softStopPending || backendGuardPendingAction !== null;
  const configuredPaths = pathsTab === "skills" ? settings.scanPaths : settings.mcpScanPaths;
  const pendingOverlay = displayedGuardPendingAction
    ? {
        title: displayedGuardPendingAction === "stop" ? "正在停止防护服务" : "正在启动防护服务",
        description:
          displayedGuardPendingAction === "stop"
            ? "正在关闭 Guard 服务并同步运行时状态。"
            : "正在后台拉起本机 Guard 服务，完成后会自动刷新状态。",
      }
    : softStopPending
      ? {
          title: displayedSoftStopEnabled ? "正在开启 Soft Stop" : "正在关闭 Soft Stop",
          description: displayedSoftStopEnabled
            ? "正在为 Codex adapter 启用 Soft Stop，完成后会自动同步状态。"
            : "正在为 Codex adapter 关闭 Soft Stop，完成后会自动同步状态。",
        }
      : null;
  const guardSourceLabel = guardActionPending
    ? guardActionIntent === "start"
      ? "启动中"
      : "停止中"
    : displayedGuardPendingAction === "start"
      ? "启动中"
    : guardStatus?.managed_by_desktop
      ? "桌面托管"
      : displayedGuardReachable
        ? "外部实例"
        : "未启动";
  const guardDescription = displayedGuardPendingAction
    ? displayedGuardPendingAction === "start"
      ? "Guard 启动中，桌面正在等待本机防护服务就绪。"
      : "Guard 停止中，当前会暂时阻止重复操作。"
    : displayedGuardReachable
      ? "Guard 在线，当前可以接收并裁决运行时请求。"
      : "Guard 离线，开启后桌面会尝试拉起本机防护服务。";
  const guardDetail = displayedGuardPendingAction
    ? displayedGuardPendingAction === "start"
      ? "启动请求已提交，正在后台等待 Guard 服务响应"
      : "停止请求已提交，正在关闭 Guard 服务"
    : guardStatus
      ? guardStatus.managed_by_desktop
        ? "当前实例由桌面托管"
        : displayedGuardReachable
          ? "当前实例由外部进程托管"
          : "当前实例未启动"
      : runtimeControlRefreshing
        ? "正在读取服务状态"
        : "当前实例未启动";
  const guardStatusLabel = displayedGuardPendingAction
    ? displayedGuardPendingAction === "start"
      ? "启动中"
      : "停止中"
    : displayedGuardReachable
      ? "在线"
      : "离线";
  const guardStatusTone = displayedGuardPendingAction ? "blue" : displayedGuardReachable ? "green" : "red";
  const softStopDetail = softStopPending
    ? displayedSoftStopEnabled
      ? "正在为 Codex adapter 启用 Soft Stop"
      : "正在为 Codex adapter 关闭 Soft Stop"
    : codexGuardAdapterStatus
      ? displayedGuardReachable
        ? "Adapter 已连接 Guard"
        : "Adapter 当前等待 Guard 可用"
      : runtimeControlRefreshing
        ? "正在读取 Adapter 状态"
        : "Adapter 状态待同步";
  const softStopLabel = softStopPending
    ? displayedSoftStopEnabled
      ? "开启中"
      : "关闭中"
    : displayedSoftStopEnabled
      ? "已开启"
      : "未开启";
  const softStopTone = softStopPending ? "blue" : displayedSoftStopEnabled ? "blue" : "neutral";
  const runtimeMetadata = [
    { label: "Guard 地址", value: guardStatus?.bind_address ?? "127.0.0.1:47358" },
    { label: "服务来源", value: guardSourceLabel },
    { label: "最近同步", value: formatOptionalDateTime(codexGuardAdapterStatus?.last_synced_at) },
    { label: "最近 Soft Stop", value: formatOptionalDateTime(codexGuardAdapterStatus?.last_soft_stop_at) },
  ];
  const shellPreferences = desktopShellPreferences ?? {
    enableSystemNotifications: true,
    enableForegroundRiskCard: true,
    hideToMenuBarOnClose: true,
  };
  const notificationPermissionLabel =
    notificationPermission === "granted"
      ? "已授权"
      : notificationPermission === "denied"
        ? "已拒绝"
        : notificationPermission === "default"
          ? "未决定"
          : "当前环境不支持";
  const notificationPermissionDescription =
    notificationPermission === "granted"
      ? "系统通知可以正常发送，点击通知后会回到应用详情。"
      : notificationPermission === "denied"
        ? "系统通知权限被拒绝，风险仍会保留在菜单栏与应用内提示中。"
        : notificationPermission === "default"
          ? "尚未授予通知权限，开启系统通知后仍需在系统弹框中允许。"
          : "当前环境无法读取通知权限状态。";
  const aboutItems = [
    { label: "应用版本", value: APP_VERSION },
    { label: "安全引擎版本", value: SECURITY_ENGINE_DISPLAY_VERSION },
    { label: "菜单栏常驻", value: shellPreferences.hideToMenuBarOnClose ? "已启用" : "未启用" },
    { label: "通知权限", value: notificationPermissionLabel },
  ];
  const settingsSections: Array<{
    key: SettingsSectionKey;
    label: string;
    description: string;
    icon: ReactNode;
  }> = [
    {
      key: "protection",
      label: "运行时防护",
      description: "Guard 与 Soft Stop",
      icon: <RuntimeIcon />,
    },
    {
      key: "desktop",
      label: "通知与后台运行",
      description: "菜单栏、通知与关闭行为",
      icon: <SettingsIcon />,
    },
    {
      key: "paths",
      label: "扫描路径",
      description: "目录与发现范围",
      icon: <SkillsIcon />,
    },
    {
      key: "about",
      label: "关于",
      description: "版本、引擎与设备信息",
      icon: <InfoCircleIcon />,
    },
  ];

  const refreshRuntimeControls = async (showLoading = true) => {
    if (!runtimeControlsAvailable) {
      return;
    }

    if (showLoading) {
      setRuntimeControlRefreshing(true);
    }

    try {
      const [nextGuardStatus, nextCodexGuardAdapterStatus] = await Promise.all([
        invoke<RuntimeGuardStatus>("get_runtime_guard_status"),
        invoke<CodexGuardAdapterStatus>("get_codex_guard_adapter_status"),
      ]);
      setGuardStatus(nextGuardStatus);
      setCodexGuardAdapterStatus(nextCodexGuardAdapterStatus);
      setRuntimeControlError(resolveRuntimeControlError(nextGuardStatus, nextCodexGuardAdapterStatus));
    } catch (error) {
      setRuntimeControlError(describeDesktopInvokeError(error, "读取运行时防护控制状态失败"));
    } finally {
      if (showLoading) {
        setRuntimeControlRefreshing(false);
      }
    }
  };

  const addPath = () => {
    const path = newPath.trim();
    if (!path) {
      return;
    }

    if (pathsTab === "skills") {
      onChange((current) => ({
        ...current,
        scanPaths: current.scanPaths.includes(path) ? current.scanPaths : [...current.scanPaths, path],
      }));
    } else {
      onChange((current) => ({
        ...current,
        mcpScanPaths: current.mcpScanPaths.includes(path) ? current.mcpScanPaths : [...current.mcpScanPaths, path],
      }));
    }

    setNewPath("");
  };

  const removePath = (path: string) => {
    if (pathsTab === "skills") {
      onChange((current) => ({
        ...current,
        scanPaths: current.scanPaths.filter((item) => item !== path),
      }));
    } else {
      onChange((current) => ({
        ...current,
        mcpScanPaths: current.mcpScanPaths.filter((item) => item !== path),
      }));
    }
  };

  const handleGuardToggle = (enabled: boolean) => {
    if (!runtimeControlsAvailable) {
      return;
    }

    const pendingStartedAt = Date.now();
    flushSync(() => {
      setGuardActionPending(true);
      setGuardActionIntent(enabled ? "start" : "stop");
      setRuntimeControlError(null);
    });

    void (async () => {
      try {
        await waitForNextPaint();
        const nextGuardStatus = enabled
          ? await invoke<RuntimeGuardStatus>("start_runtime_guard")
          : await invoke<RuntimeGuardStatus>("stop_runtime_guard");
        setGuardStatus(nextGuardStatus);
        setRuntimeControlError(enabled ? nextGuardStatus.error ?? null : null);
        if (!nextGuardStatus.pending_action) {
          await refreshRuntimeControls(false);
        }
      } catch (error) {
        setRuntimeControlError(
          describeDesktopInvokeError(error, enabled ? "启动防护服务失败" : "停止防护服务失败"),
        );
      } finally {
        await waitForMinimumPendingDuration(pendingStartedAt);
        setGuardActionPending(false);
        setGuardActionIntent(null);
      }
    })();
  };

  const handleSoftStopToggle = async (enabled: boolean) => {
    if (!runtimeControlsAvailable) {
      return;
    }

    const pendingStartedAt = Date.now();
    flushSync(() => {
      setSoftStopPending(true);
      setSoftStopIntent(enabled);
      setRuntimeControlError(null);
    });
    try {
      await waitForNextPaint();
      const nextCodexGuardAdapterStatus = await invoke<CodexGuardAdapterStatus>("set_codex_guard_soft_stop_enabled", {
        enabled,
      });
      setCodexGuardAdapterStatus(nextCodexGuardAdapterStatus);
      setRuntimeControlError(nextCodexGuardAdapterStatus.last_error ?? null);
      await refreshRuntimeControls(false);
    } catch (error) {
      setRuntimeControlError(describeDesktopInvokeError(error, "更新 Soft Stop 状态失败"));
    } finally {
      await waitForMinimumPendingDuration(pendingStartedAt);
      setSoftStopPending(false);
      setSoftStopIntent(null);
    }
  };

  useEffect(() => {
    void refreshRuntimeControls();
  }, []);

  useEffect(() => {
    if (!runtimeControlsAvailable || backendGuardPendingAction === null) {
      return;
    }

    void refreshRuntimeControls(false);
    const timer = window.setInterval(() => {
      void refreshRuntimeControls(false);
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [backendGuardPendingAction, runtimeControlsAvailable]);

  let settingsPanel: ReactNode;
  if (activeSection === "protection") {
    settingsPanel = (
      <SettingsSection
        title="运行时防护控制"
        description="统一管理 Guard 服务启停与 Codex adapter 的 Soft Stop 开关。"
        action={
          runtimeControlsAvailable ? (
            <button
              type="button"
              onClick={() => void refreshRuntimeControls()}
              className="rounded-lg border border-[#e2e8f0] bg-white px-3 py-1.5 text-[12px] font-bold text-[#475569] shadow-sm transition-all hover:bg-slate-50 hover:shadow-md active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={runtimeControlsBusy}
            >
              {runtimeControlRefreshing ? (
                <span className="flex items-center gap-2">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#2563eb] border-t-transparent" />
                  刷新中
                </span>
              ) : (
                "刷新状态"
              )}
            </button>
          ) : null
        }
      >
        {!runtimeControlsAvailable ? (
          <SettingsInlineNotice tone="neutral">
            当前环境不支持桌面运行时服务控制，请在 Tauri 桌面端使用该功能。
          </SettingsInlineNotice>
        ) : (
          <div className="flex flex-col gap-6">
            {runtimeControlError ? (
              <SettingsInlineNotice tone="red">{runtimeControlError}</SettingsInlineNotice>
            ) : null}

            <div className="grid gap-4">
              <SettingsToggleRow
                title="防护服务"
                description={guardDescription}
                detail={guardDetail}
                checked={displayedGuardReachable}
                disabled={runtimeControlsBusy}
                pending={displayedGuardPendingAction !== null}
                label={guardStatusLabel}
                tone={guardStatusTone}
                onChange={handleGuardToggle}
              />

              <SettingsToggleRow
                title="Soft Stop"
                description="为 Codex adapter 启用实验性 Soft Stop，命中高风险操作时优先尝试温和终止。"
                detail={softStopDetail}
                checked={displayedSoftStopEnabled}
                disabled={runtimeControlsBusy}
                pending={softStopPending}
                label={softStopLabel}
                tone={softStopTone}
                onChange={handleSoftStopToggle}
              />
            </div>

            <div className="rounded-xl border border-[#f1f5f9] bg-slate-50/50 p-4">
              <div className="mb-4 text-[12px] font-bold uppercase tracking-widest text-[#94a3b8]">运行时元数据</div>
              <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {runtimeMetadata.map((item) => (
                  <SettingsSummary
                    key={item.label}
                    label={item.label}
                    value={item.value}
                    variant="stacked"
                    className="rounded-lg border border-white bg-white/50 p-3 shadow-sm"
                  />
                ))}
              </dl>
            </div>
          </div>
        )}
      </SettingsSection>
    );
  } else if (activeSection === "desktop") {
    settingsPanel = (
      <SettingsSection
        title="通知与后台运行"
        description="控制系统通知、前台风险卡，以及关闭主窗口后的后台运行行为。"
        action={
          notificationPermission !== "granted" && notificationPermission !== "unsupported" ? (
            <button
              type="button"
              onClick={() => void onRequestNotificationPermission()}
              className="rounded-lg border border-[#dbeafe] bg-[#eff6ff] px-3 py-1.5 text-[12px] font-bold text-[#1d4ed8] transition hover:bg-[#dbeafe]"
            >
              请求通知权限
            </button>
          ) : null
        }
      >
        <div className="flex flex-col gap-6">
          <SettingsInlineNotice tone={notificationPermission === "denied" ? "red" : "neutral"}>
            {notificationPermissionDescription}
          </SettingsInlineNotice>

          <div className="grid gap-4">
            <SettingsToggleRow
              title="系统通知"
              description="命中新风险时发送操作系统通知；点击通知后返回应用内详情。"
              detail={notificationPermission === "granted" ? "已具备发送能力" : "未授权时不会发送系统通知"}
              checked={shellPreferences.enableSystemNotifications}
              disabled={desktopShellLoading}
              pending={false}
              label={shellPreferences.enableSystemNotifications ? "已启用" : "已关闭"}
              tone={shellPreferences.enableSystemNotifications ? "blue" : "neutral"}
              onChange={(enableSystemNotifications) =>
                onDesktopShellPreferenceChange({ enableSystemNotifications })
              }
            />

            <SettingsToggleRow
              title="前台风险卡"
              description="主窗口当前在前台时，在右下角显示最新风险卡片，并保留未处理计数。"
              detail="忽略卡片不会清空未处理风险数"
              checked={shellPreferences.enableForegroundRiskCard}
              disabled={desktopShellLoading}
              pending={false}
              label={shellPreferences.enableForegroundRiskCard ? "已启用" : "已关闭"}
              tone={shellPreferences.enableForegroundRiskCard ? "green" : "neutral"}
              onChange={(enableForegroundRiskCard) =>
                onDesktopShellPreferenceChange({ enableForegroundRiskCard })
              }
            />

            <SettingsToggleRow
              title="关闭窗口隐藏到菜单栏"
              description="只拦截主窗口关闭动作，应用会继续在菜单栏后台运行，其他独立窗口仍按正常关闭处理。"
              detail="菜单栏中的“退出”仍会真正结束应用进程"
              checked={shellPreferences.hideToMenuBarOnClose}
              disabled={desktopShellLoading}
              pending={false}
              label={shellPreferences.hideToMenuBarOnClose ? "后台运行" : "直接关闭"}
              tone={shellPreferences.hideToMenuBarOnClose ? "green" : "neutral"}
              onChange={(hideToMenuBarOnClose) =>
                onDesktopShellPreferenceChange({ hideToMenuBarOnClose })
              }
            />
          </div>
        </div>
      </SettingsSection>
    );
  } else if (activeSection === "paths") {
    settingsPanel = (
      <SettingsSection
        title="扫描路径"
        description="在这里管理需要扫描的目录，方便查看本地功能与扩展工具的安全范围。"
      >
        <div className="flex flex-col gap-8">
          <div>
            <div className="inline-flex rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => {
                  setPathsTab("skills");
                  setNewPath("");
                }}
                className={`rounded-lg px-4 py-2 text-[12px] font-bold transition-all ${
                  pathsTab === "skills"
                    ? "bg-white text-[#175cd3] shadow-sm"
                    : "text-[#667085] hover:text-[#175cd3]"
                }`}
              >
                Skills 目录
              </button>
              <button
                type="button"
                onClick={() => {
                  setPathsTab("mcps");
                  setNewPath("");
                }}
                className={`rounded-lg px-4 py-2 text-[12px] font-bold transition-all ${
                  pathsTab === "mcps"
                    ? "bg-white text-[#175cd3] shadow-sm"
                    : "text-[#667085] hover:text-[#175cd3]"
                }`}
              >
                MCP 目录
              </button>
            </div>
          </div>

          <div>
            <div className="grid gap-2">
              {configuredPaths.map((path) => (
                <div key={`${pathsTab}:${path}`} className="flex items-center justify-between gap-4 rounded-xl border border-[#f1f5f9] bg-white p-3 shadow-sm transition-all hover:border-[#e2e8f0]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-[#1e293b]">{path}</div>
                    <div className="mt-0.5 text-[11px] text-[#94a3b8]">
                      {pathsTab === "skills" ? "本地 Skills 扫描根目录" : "工作区 MCP 配置扫描根目录"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removePath(path)}
                    className="shrink-0 rounded-lg bg-[#fef2f2] px-3 py-1.5 text-[12px] font-bold text-[#dc2626] transition-all hover:bg-[#fee2e2] active:scale-95"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>

            {configuredPaths.length === 0 ? (
              <div className="mt-3 text-[12px] text-[#94a3b8]">
                {pathsTab === "skills" ? "当前还没有配置 Skills 扫描目录。" : "当前还没有配置工作区 MCP 扫描目录。"}
              </div>
            ) : null}

            <div className="mt-4 flex gap-2 rounded-xl bg-slate-100/50 p-2 ring-1 ring-[#f1f5f9]">
              <input
                value={newPath}
                onChange={(event) => setNewPath(event.target.value)}
                className="h-9 flex-1 bg-transparent px-3 text-[13px] font-medium text-[#1e293b] outline-none placeholder:text-[#94a3b8]"
                placeholder={pathsTab === "skills" ? "添加自定义 Skills 路径..." : "添加自定义 MCP 路径..."}
              />
              <button
                type="button"
                onClick={addPath}
                className="inline-flex h-9 items-center justify-center rounded-lg bg-[#2563eb] px-5 text-[12px] font-bold text-white shadow-sm transition-all hover:bg-[#1d4ed8] hover:shadow-md active:scale-95"
              >
                添加路径
              </button>
            </div>
          </div>
        </div>
      </SettingsSection>
    );
  } else {
    settingsPanel = (
      <div className="flex flex-col gap-6">
        <div className="rounded-2xl border border-[#e6eef8] bg-[linear-gradient(135deg,#f8fbff_0%,#ffffff_68%)] p-5 shadow-sm">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div>
              <h3 className="text-[24px] font-semibold tracking-tight text-[#1e293b]">Aegis</h3>
              <div className="mt-1 text-[12px] font-medium uppercase tracking-[0.1em] text-[#7f8ea3]">
                Powered by AOS
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="rounded-full border border-[#dbeafe] bg-white px-3 py-1 text-[11px] font-semibold text-[#2563eb]">
                  桌面伴随应用
                </span>
                <span className="rounded-full border border-[#e2e8f0] bg-white px-3 py-1 text-[11px] font-semibold text-[#64748b]">
                  Agent Runtime
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-[#dbeafe] bg-white px-4 py-3 text-right shadow-sm">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8aa2c5]">应用版本</div>
              <div className="mt-1 text-[20px] font-semibold tracking-tight text-[#1e293b]">{APP_VERSION}</div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#f1f5f9] bg-white p-2 shadow-sm">
          <dl className="grid gap-1">
            {aboutItems.map((item) => (
              <SettingsSummary
                key={item.label}
                label={item.label}
                value={item.value}
                className="rounded-lg px-4 py-3 transition-colors hover:bg-slate-50"
              />
            ))}
          </dl>
        </div>

        <div className="rounded-2xl border border-[#f1f5f9] bg-slate-50/60 p-5">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#94a3b8]">版本说明</div>
          <div className="mt-3 grid gap-3">
            <SettingsSummary
              label="安全引擎版本"
              value={SECURITY_ENGINE_DISPLAY_VERSION}
              variant="stacked"
              className="rounded-xl border border-white bg-white px-4 py-3 shadow-sm"
            />
            <div className="rounded-xl border border-white bg-white px-4 py-3 text-[12px] leading-7 text-[#64748b] shadow-sm">
              安全引擎版本对应当前内置的本地检测引擎版本，用于扫描、风险判定和运行时策略基础能力。
              应用版本用于标识当前桌面端壳层与前端界面的发布版本。
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="flex h-full flex-col overflow-hidden bg-white">
      <header
        data-tauri-drag-region
        style={DRAG_REGION_STYLE}
        className="flex h-14 shrink-0 items-center border-b border-[#eef1f4] bg-white px-6"
      >
        <h1 className="text-sm font-semibold uppercase tracking-[0.04em] text-[#7b8491]">设置</h1>
        <div className="min-h-[40px] flex-1" data-tauri-drag-region style={DRAG_REGION_STYLE} />
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full">
          <aside className="flex w-[220px] shrink-0 flex-col border-r border-[#f1f5f9] bg-[#f9fafb]">
            <div className="mb-4 px-6 pt-6">
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94a3b8]">PREFERENCES</div>
              <div className="mt-1 text-[13px] font-black tracking-tight text-[#1e293b]">Aegis 设置</div>
              <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[#a0a8b4]">Powered by AOS</div>
            </div>
            <nav className="flex flex-1 flex-col gap-0.5 px-3">
              {settingsSections.map((section) => (
                <SettingsNavItem
                  key={section.key}
                  active={activeSection === section.key}
                  description={section.description}
                  icon={section.icon}
                  label={section.label}
                  onClick={() => setActiveSection(section.key)}
                />
              ))}
            </nav>
          </aside>

          <section className="hover-scrollbar min-w-0 flex-1 overflow-auto bg-white p-10 lg:p-14">
            <div className="mx-auto max-w-[720px]">
              {settingsPanel}
            </div>
          </section>
        </div>
      </div>
      {pendingOverlay ? (
        <SettingsPendingOverlay
          title={pendingOverlay.title}
          description={pendingOverlay.description}
        />
      ) : null}
    </main>
  );
}

function SettingsSection({
  action,
  className = "",
  children,
  contentClassName = "",
  description,
  title,
}: {
  action?: ReactNode;
  className?: string;
  children: ReactNode;
  contentClassName?: string;
  description: string;
  title: string;
}) {
  return (
    <section className={className}>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-[#1e293b]">{title}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[#64748b]">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={contentClassName}>{children}</div>
    </section>
  );
}

function SettingsNavItem({
  active,
  description,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${
        active
          ? "bg-white text-[#2563eb] shadow-sm ring-1 ring-[#000000]/05"
          : "text-[#64748b] hover:bg-slate-200/40 hover:text-[#1e293b]"
      }`}
    >
      <span className={`shrink-0 transition-colors ${active ? "text-[#2563eb]" : "text-[#94a3b8] group-hover:text-[#64748b]"}`}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-bold leading-tight">{label}</div>
        <div className={`mt-0.5 truncate text-[10px] leading-tight ${active ? "text-[#60a5fa]" : "text-[#94a3b8]"}`}>
          {description}
        </div>
      </div>
      {active && (
        <div className="absolute left-1.5 h-3.5 w-1 rounded-full bg-[#2563eb]" />
      )}
    </button>
  );
}

function SettingsInlineNotice({
  children,
  className = "",
  tone,
}: {
  children: ReactNode;
  className?: string;
  tone: "neutral" | "red";
}) {
  const toneClass =
    tone === "red"
      ? "bg-[#fff5f5] text-[#dc2626] border-[#fee2e2]"
      : "bg-[#f8fafc] text-[#64748b] border-[#f1f5f9]";

  return (
    <div className={`rounded-lg border px-4 py-3 text-[12px] leading-relaxed ${toneClass} ${className}`}>
      {children}
    </div>
  );
}

function SettingsSummary({
  className = "",
  label,
  value,
  variant = "row",
}: {
  className?: string;
  label: string;
  value: string;
  variant?: "row" | "stacked";
}) {
  if (variant === "stacked") {
    return (
      <div className={className}>
        <dt className="text-[11px] font-bold uppercase tracking-wider text-[#94a3b8]">{label}</dt>
        <dd className="mt-1.5 break-all text-[13px] font-semibold text-[#1e293b]">{value}</dd>
      </div>
    );
  }

  return (
    <div className={`flex items-center justify-between gap-4 ${className}`}>
      <dt className="text-[13px] font-medium text-[#64748b]">{label}</dt>
      <dd className="break-all text-right text-[13px] font-semibold text-[#1e293b]">{value}</dd>
    </div>
  );
}

function SettingsToggleRow({
  checked,
  description,
  detail,
  disabled,
  label,
  onChange,
  pending,
  title,
  tone,
}: {
  checked: boolean;
  description: string;
  detail: string;
  disabled: boolean;
  label: string;
  onChange: (nextChecked: boolean) => void;
  pending: boolean;
  title: string;
  tone: "blue" | "green" | "red" | "neutral";
}) {
  return (
    <div className="group flex items-start justify-between gap-6 overflow-hidden rounded-xl bg-white p-4 transition-all hover:bg-slate-50/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <div className="text-[14px] font-bold tracking-tight text-[#1e293b] ml-0.5">{title}</div>
          <SettingsStatusBadge tone={tone} label={label} />
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-[#64748b] ml-0.5">{description}</p>
        <div className="mt-2 flex items-center gap-2 text-[11px] font-medium text-[#94a3b8] ml-0.5">
          <span className="h-1 w-1 rounded-full bg-[#cbd5e1]" />
          {detail}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">
        <SettingsToggle
          checked={checked}
          disabled={disabled}
          pending={pending}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

function SettingsToggle({
  checked,
  disabled,
  onChange,
  pending,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (nextChecked: boolean) => void;
  pending: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? "关闭开关" : "开启开关"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-10 shrink-0 items-center rounded-full transition-all duration-300 ease-in-out focus:outline-none focus:ring-2 focus:ring-[#3b82f6] focus:ring-offset-2 ${
        checked ? "bg-[#2563eb]" : "bg-[#e2e8f0]"
      } ${disabled ? "cursor-not-allowed opacity-50" : "hover:brightness-105 active:scale-95"}`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full bg-white shadow-md transition-transform duration-300 ease-in-out ${
          checked ? "translate-x-5" : "translate-x-1"
        }`}
      >
        {pending ? (
          <span className="h-2 w-2 animate-spin rounded-full border border-[#2563eb] border-t-transparent" />
        ) : null}
      </span>
    </button>
  );
}

function SettingsPendingOverlay({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="pointer-events-none fixed bottom-8 right-8 z-50 flex justify-end">
      <style>{`
        @keyframes slideInUp {
          from { transform: translateY(12px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .animate-slide-in-up {
          animation: slideInUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
      <div className="animate-slide-in-up flex max-w-[360px] items-center gap-4 rounded-2xl border border-[#d8e6ff] bg-white/95 px-5 py-4 shadow-[0_24px_56px_rgba(15,23,42,0.2)] ring-1 ring-[#eef4ff] backdrop-blur-md">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f3f8ff]">
          <span className="h-6 w-6 animate-spin rounded-full border-[3px] border-[#2563eb] border-t-transparent" />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-bold text-[#1d3557] tracking-tight">{title}</div>
          <div className="mt-1 text-[12px] leading-relaxed text-[#5b6b81]">{description}</div>
        </div>
      </div>
    </div>
  );
}

function SettingsStatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "blue" | "green" | "red" | "neutral";
}) {
  const styles = {
    green: "bg-[#f0fdf4] text-[#16a34a] ring-[#bbf7d0]",
    red: "bg-[#fef2f2] text-[#dc2626] ring-[#fecaca]",
    blue: "bg-[#eff6ff] text-[#2563eb] ring-[#bfdbfe]",
    neutral: "bg-[#f8fafc] text-[#64748b] ring-[#e2e8f0]",
  };
  const dotStyles = {
    green: "bg-[#16a34a]",
    red: "bg-[#dc2626]",
    blue: "bg-[#2563eb]",
    neutral: "bg-[#94a3b8]",
  };

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ring-1 ring-inset ${styles[tone]}`}>
      <span className={`h-1 w-1 rounded-full ${dotStyles[tone]}`} />
      {label}
    </span>
  );
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

async function waitForMinimumPendingDuration(startedAt: number, minimumMs = 350) {
  const elapsed = Date.now() - startedAt;
  const remaining = minimumMs - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, remaining));
  }
}

async function waitForNextPaint() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function describeDesktopInvokeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return fallback;
}

function formatOptionalDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return formatRuntimeTableDateTime(value);
}

function resolveRuntimeControlError(
  guardStatus: RuntimeGuardStatus,
  codexGuardAdapterStatus: CodexGuardAdapterStatus,
) {
  if (codexGuardAdapterStatus.last_error) {
    return codexGuardAdapterStatus.last_error;
  }

  if (guardStatus.managed_by_desktop && guardStatus.error) {
    return guardStatus.error;
  }

  return null;
}

function versionStub(index: number) {
  return `1.${(index % 5) + 1}.${(index * 2) % 9}`;
}

function resolveSecurityEngineMetadata(cargoLock: string) {
  const match = cargoLock.match(
    /\[\[package\]\]\s+name = "discovery-engine"\s+version = "([^"]+)"\s+source = "git\+https:\/\/github\.com\/AOS-HZ\/agentguard-core\.git\?rev=([0-9a-f]+)#/m,
  );

  if (!match) {
    return {
      version: "未知",
      revision: "",
    };
  }

  return {
    version: `v${match[1]}`,
    revision: match[2] ? `rev ${match[2].slice(0, 7)}` : "",
  };
}
