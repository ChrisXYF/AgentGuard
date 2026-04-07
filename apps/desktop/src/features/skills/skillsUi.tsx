import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { emit } from "@tauri-apps/api/event";
import type { ManagedSkillDetailAction } from "../../shared/appTypes";
import type { ManagedSkill, RiskCategory, ToolInfo } from "../../types";
import {
  CloseCircleIcon,
  DownloadTinyIcon,
  DRAG_REGION_STYLE,
  InfoIcon,
  WINDOW_DRAG_BLOCK_SELECTOR,
  PackageTinyIcon,
  StarTinyIcon,
  SuccessIcon,
  UsersTinyIcon,
  WarningIcon,
  basename,
  formatAbsoluteTimestamp,
  formatConfidence,
  formatIsoTimestamp,
  formatRelativeTimestamp,
  isTauriRuntime,
  managedSourceDescription,
  managedSourceTone,
  managedSourceTypeLabel,
  openExternalUrl,
  SKILL_ANALYSIS_UPDATED_EVENT,
  sanitizeEvidenceSnippet,
  toolLabel,
  uniqueStrings,
} from "../../shared/shared";


export function ManagedSkillCard({
  busy,
  index,
  onDelete,
  onOpenDetail,
  onUpdate,
  skill,
  toolInfos,
}: {
  busy: boolean;
  index: number;
  onDelete: (skillId: string) => Promise<void>;
  onOpenDetail: (skill: ManagedSkill) => Promise<void>;
  onUpdate: (skillId: string) => Promise<void>;
  skill: ManagedSkill;
  toolInfos: ToolInfo[];
}) {
  const syncedTargets = skill.targets;

  return (
    <article className="rounded-[20px] border border-[#dde5ef] bg-[linear-gradient(180deg,#ffffff_0%,#fbfcfe_100%)] p-5 shadow-[0_10px_28px_rgba(18,32,56,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div className={`mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-sm font-bold ${avatarColor(index)}`}>
            {initials(skill.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[18px] font-semibold tracking-[-0.03em] text-[#243042]">{skill.name}</h3>
              <span className={`inline-flex rounded-full px-3 py-1 text-[12px] font-semibold ${managedSourceTone(skill.source_type)}`}>
                {managedSourceTypeLabel(skill.source_type)}
              </span>
              <span className="rounded-full border border-[#e2e9f3] bg-[#f8fbff] px-3 py-1 text-[12px] font-medium text-[#6c7d92]">
                {syncedTargets.length > 0 ? `已在 ${syncedTargets.length} 个应用中启用` : "尚未启用"}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[#97a5b8]">
              <span>更新于 {formatRelativeTimestamp(skill.updated_at)}</span>
              <span>创建于 {formatRelativeTimestamp(skill.created_at)}</span>
              {skill.last_sync_at ? <span>最近同步 {formatRelativeTimestamp(skill.last_sync_at)}</span> : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void onOpenDetail(skill)}
            disabled={busy}
            className="rounded-xl border border-[#d7e3f6] bg-white px-4 py-2.5 text-sm font-semibold text-[#516072] transition hover:border-[#bfd2f3] hover:bg-[#f8fbff] hover:text-[#2f76e9] disabled:opacity-60"
          >
            查看详情
          </button>
          <button
            type="button"
            onClick={() => void onUpdate(skill.id)}
            disabled={busy}
            className="rounded-xl bg-[#eef4ff] px-3.5 py-2.5 text-sm font-semibold text-[#1069d2] transition hover:bg-[#e4eeff] hover:text-[#0e5db9] disabled:opacity-60"
          >
            更新
          </button>
          <button
            type="button"
            onClick={() => void onDelete(skill.id)}
            disabled={busy}
            className="rounded-xl bg-[#fff1f1] px-3.5 py-2.5 text-sm font-semibold text-[#cf2e2e] transition hover:bg-[#ffe3e3] disabled:opacity-60"
          >
            删除
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[1.05fr,0.95fr]">
        <div className="rounded-[16px] border border-[#e7edf5] bg-[#f8fbff] px-4 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#90a0b5]">
            安装信息
          </div>
          <div className="mt-3 text-[14px] font-medium text-[#344256]">
            {managedSourceTypeLabel(skill.source_type)}
          </div>
          <div className="mt-2 text-[13px] leading-6 text-[#7f8ea3]">
            {managedSourceDescription(skill)}
          </div>
          {skill.source_ref ? (
            <div className="mt-3 text-[12px] text-[#8ea0b6]">
              来源：<span className="text-[#6f7f94]">{basename(skill.source_ref)}</span>
            </div>
          ) : null}
        </div>

        <div className="rounded-[16px] border border-[#e7edf5] bg-white px-4 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#90a0b5]">
            使用状态
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {syncedTargets.length > 0 ? (
              syncedTargets.map((target) => (
                <span
                  key={`${skill.id}-${target.tool}`}
                  className="rounded-full bg-[#eef4ff] px-3 py-1 text-[12px] font-medium text-[#1069d2]"
                >
                  {toolLabel(toolInfos, target.tool)}
                </span>
              ))
            ) : (
              <span className="rounded-full bg-[#f5f7fb] px-3 py-1 text-[12px] text-[#97a5b8]">
                还没有在任何应用中启用，可在详情里选择要启用的应用
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

const DESKTOP_FONT =
  "\"SF Pro Display\",\"SF Pro Text\",\"PingFang SC\",\"Helvetica Neue\",\"Segoe UI\",sans-serif";

function startManagedSkillWindowDrag(event: ReactMouseEvent<HTMLElement>) {
  if (!isTauriRuntime() || event.button !== 0) {
    return;
  }

  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.closest(WINDOW_DRAG_BLOCK_SELECTOR)) {
    return;
  }

  void getCurrentWindow().startDragging().catch(() => {
    // Ignore native drag failures outside standalone desktop windows.
  });
}

function managedSkillRiskTone(level?: string | null) {
  const normalized = level?.trim().toLowerCase();

  if (normalized === "critical" || normalized === "high") {
    return {
      badgeClass: "border-[#ffd8df] bg-[#fff1f4] text-[#cf2e5c]",
      indicatorClass: "border-[#f3d6de] text-[#cf2e5c]",
      metricValueClass: "text-[#c53d5f]",
      panelClass: "bg-[#fffafb]",
    };
  }

  if (normalized === "medium" || normalized === "moderate") {
    return {
      badgeClass: "border-[#ffe1b7] bg-[#fff6ea] text-[#b96a00]",
      indicatorClass: "border-[#f3dfc4] text-[#c47a10]",
      metricValueClass: "text-[#c97a00]",
      panelClass: "bg-[#fffdfa]",
    };
  }

  return {
    badgeClass: "border-[#d8eadf] bg-[#eef7f1] text-[#18824c]",
    indicatorClass: "border-[#d4e8da] text-[#18824c]",
    metricValueClass: "text-[#18824c]",
    panelClass: "bg-[#fafdfb]",
  };
}

function managedSkillCompactTimestamp(value?: string | number | null) {
  if (!value) {
    return "暂无";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return typeof value === "string" ? formatIsoTimestamp(value) : String(value);
  }

  return parsed.toLocaleString("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}


export function ManagedSkillDetailWindowScreen({
  initialAction,
  loading,
  managedSkill,
  onClose,
}: {
  initialAction: ManagedSkillDetailAction;
  loading: boolean;
  managedSkill: ManagedSkill | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (initialAction === "analyze") {
      emit(SKILL_ANALYSIS_UPDATED_EVENT, { id: managedSkill?.id });
    }
  }, [initialAction, managedSkill?.id]);

  if (loading) {
    return (
      <main className="flex h-screen items-center justify-center bg-[#f8fafc]">
        <div className="flex items-center gap-2 text-sm text-[#8b97aa]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#d0d8e4] border-t-[#4b8bf5]" />
          正在加载插件信息…
        </div>
      </main>
    );
  }

  if (!managedSkill) {
    return (
      <main className="flex h-screen flex-col items-center justify-center bg-[#f8fafc] text-center">
        <div className="text-[28px] text-[#c4d0df]">📦</div>
        <p className="mt-3 text-sm text-[#6b7a90]">未找到指定插件信息</p>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-[#f8fafc]">
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center justify-between border-b border-[#e2e8f0] bg-white px-5 py-4 select-none"
        style={DRAG_REGION_STYLE}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f1f5f9] text-[#64748b]">
            <PackageTinyIcon />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-[#1e293b]">{managedSkill.name}</h1>
            <p className="truncate text-xs text-[#64748b]">{managedSkill.id}</p>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          <section className="rounded-2xl border border-[#e2e8f0] bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-[#334155]">基本信息</h2>
            <dl className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs text-[#64748b]">ID</dt>
                <dd className="mt-1 text-sm font-medium text-[#1e293b]">{managedSkill.id || "未知"}</dd>
              </div>
              <div>
                <dt className="text-xs text-[#64748b]">名称</dt>
                <dd className="mt-1 text-sm font-medium text-[#1e293b]">{managedSkill.name || "未知"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-[#64748b]">来源类型</dt>
                <dd className="mt-1 text-sm text-[#334155]">{managedSkill.source_type || "未知"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-[#64748b]">本地路径</dt>
                <dd className="mt-1 font-mono text-xs text-[#334155] break-all">{managedSkill.central_path || "未知"}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </main>
  );
}
function ManagedSkillStatusPill({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span className={`inline-flex h-7 items-center rounded-md border px-2.5 text-[11px] font-semibold ${className}`}>
      {children}
    </span>
  );
}

function ManagedSkillWindowButton({
  children,
  disabled = false,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 items-center rounded-lg border px-3 text-[12px] font-medium transition disabled:opacity-60 ${
        primary
          ? "border-[#2f76e9] bg-[#2f76e9] text-white hover:bg-[#265fc5]"
          : "border-[#d8e0ea] bg-white text-[#516072] hover:border-[#c8d5e4] hover:text-[#2f76e9]"
      }`}
    >
      {children}
    </button>
  );
}

export function ManagedSkillDetailPanel({
  children,
  childrenClassName = "",
  className = "",
  eyebrow,
  title,
}: {
  children: ReactNode;
  childrenClassName?: string;
  className?: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-lg border border-[#e4eaf2] bg-white ${className}`}>
      <div className="border-b border-[#edf1f5] px-4 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8ea0b6]">{eyebrow}</div>
        <h2 className="mt-1 text-[14px] font-semibold text-[#243042]">{title}</h2>
      </div>
      <div className={`px-4 py-3 ${childrenClassName}`}>{children}</div>
    </section>
  );
}

export function ManagedSkillDetailHeroMetric({
  className = "",
  hint,
  label,
  value,
  valueClassName = "",
}: {
  className?: string;
  hint: string;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className={`min-w-0 px-4 py-4 ${className}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">{label}</div>
      <div className={`mt-1 min-w-0 break-words text-[16px] font-semibold text-[#243042] ${valueClassName}`}>
        {value}
      </div>
      <div className="mt-1 text-[11px] leading-5 text-[#8ea0b6]">{hint}</div>
    </div>
  );
}

export function ManagedSkillDetailStatRow({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-[#edf1f5] py-2 last:border-0 last:pb-0">
      <div className="pt-0.5 text-[11px] font-medium text-[#8ea0b6]">{label}</div>
      <div
        className={`min-w-0 text-[11px] leading-5 text-[#516072] ${mono ? "font-mono text-[10px] [overflow-wrap:anywhere]" : "break-words"}`}
      >
        {value}
      </div>
    </div>
  );
}

export function ManagedSkillTokenGroup({
  emptyLabel,
  items,
  label,
  tone,
}: {
  emptyLabel: string;
  items: string[];
  label: string;
  tone: "neutral" | "warning";
}) {
  const toneClass =
    tone === "warning"
      ? "border-[#f3e0bd] bg-[#fffaf1] text-[#b57917]"
      : "border-[#dbe3ee] bg-[#f8fafc] text-[#516072]";

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">{label}</div>
      {items.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {items.map((item) => (
            <span key={item} className={`rounded-md border px-2.5 py-1 text-[11px] font-medium ${toneClass}`}>
              {item}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-[12px] text-[#8ea0b6]">{emptyLabel}</div>
      )}
    </div>
  );
}

export function ManagedSkillSignalList({
  emptyLabel,
  iconTone,
  items,
}: {
  emptyLabel: string;
  iconTone: "neutral" | "positive" | "warning";
  items: string[];
}) {
  const iconClass =
    iconTone === "positive"
      ? "text-[#18824c]"
      : iconTone === "warning"
        ? "text-[#c97a00]"
        : "text-[#2f76e9]";
  const rowClass =
    iconTone === "positive"
      ? "border-[#e2f0e7] bg-[#fafdfb]"
      : iconTone === "warning"
        ? "border-[#f3e7ce] bg-[#fffdfa]"
        : "border-[#e4eaf2] bg-[#fbfcfe]";

  if (items.length === 0) {
    return <div className="text-[12px] leading-6 text-[#8ea0b6]">{emptyLabel}</div>;
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item} className={`flex items-start gap-3 rounded-md border px-3 py-2.5 ${rowClass}`}>
          <span className={`mt-0.5 shrink-0 ${iconClass}`}>
            {iconTone === "positive" ? <SuccessIcon /> : iconTone === "warning" ? <WarningIcon /> : <InfoIcon />}
          </span>
          <div className="text-[12px] leading-6 text-[#516072]">{item}</div>
        </div>
      ))}
    </div>
  );
}





export function MarketplaceMetricCard({
  icon,
  iconTone,
  label,
  value,
}: {
  icon: ReactNode;
  iconTone: string;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[24px] bg-white px-6 py-6 text-center shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
      <div className={`mx-auto flex h-8 w-8 items-center justify-center ${iconTone}`}>{icon}</div>
      <div className="mt-4 text-[20px] font-semibold tracking-[-0.03em] text-[#20232b]">{value}</div>
      <div className="mt-2 text-[14px] text-[#b0b4bc]">{label}</div>
    </div>
  );
}


export function MarketplaceVerdictBadge({ verdict }: { verdict: "clear" | "review" | "block" }) {
  const styles = {
    clear: "border-[#cdeed8] bg-[#eefaf3] text-[#13804b]",
    review: "border-[#fde4b8] bg-[#fff8ea] text-[#d68a00]",
    block: "border-[#ffd4dd] bg-[#fff1f4] text-[#ef476f]",
  } as const;
  const labels = {
    clear: "已评测 · clear",
    review: "已评测 · review",
    block: "已评测 · block",
  } as const;
  return (
    <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ${styles[verdict]}`}>
      {labels[verdict]}
    </span>
  );
}


export function RiskChip({ category }: { category: RiskCategory }) {
  const styles: Record<RiskCategory, string> = {
    safe: "border-[#bbf7d0] bg-[#dcfce7] text-[#16a34a]",
    suspicious: "border-[#fde68a] bg-[#fef3c7] text-[#d97706]",
    high_risk: "border-[#fecaca] bg-[#fee2e2] text-[#dc2626]",
    malicious: "border-[#fecaca] bg-[#fee2e2] text-[#dc2626]",
  };
  const labels: Record<RiskCategory, string> = {
    safe: "安全",
    suspicious: "可疑",
    high_risk: "高风险",
    malicious: "高风险",
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${styles[category]}`}>
      {labels[category]}
    </span>
  );
}


export function CloudMetricCard({
  label,
  tone,
  value,
}: {
  label: string;
  tone: "neutral" | "positive" | "warning";
  value: number;
}) {
  const toneClass =
    tone === "positive"
      ? "border-[#d6f1e0] bg-[#f2fbf6] text-[#13804b]"
      : tone === "warning"
        ? "border-[#fde7c2] bg-[#fff9ee] text-[#d68a00]"
        : "border-[#e3ebf8] bg-white text-[#243042]";

  return (
    <div className={`rounded-2xl border px-4 py-3 ${toneClass}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8d97a4]">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tracking-[-0.03em]">{value}</div>
    </div>
  );
}


export function initials(name: string) {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}


export function avatarColor(index: number) {
  return [
    "bg-[#ffedd5] text-[#ea580c]",
    "bg-[#dbeafe] text-[#2563eb]",
    "bg-[#f3e8ff] text-[#9333ea]",
    "bg-[#dcfce7] text-[#16a34a]",
    "bg-[#f3f4f6] text-[#6b7280]",
    "bg-[#fee2e2] text-[#dc2626]",
  ][index] ?? "bg-[#eef2ff] text-[#4f46e5]";
}


export function marketplaceVerdictFromRiskLevel(level?: string | null): "clear" | "review" | "block" | null {
  const normalized = level?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "critical" || normalized === "high") {
    return "block";
  }
  if (normalized === "medium") {
    return "review";
  }
  return "clear";
}


export function marketplaceVerdictLabel(verdict?: "clear" | "review" | "block" | null) {
  if (verdict === "block") {
    return "建议阻断";
  }
  if (verdict === "review") {
    return "建议复核";
  }
  if (verdict === "clear") {
    return "可继续使用";
  }
  return "待分析";
}

function compactCountZh(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (value >= 100000000) {
    return `${(value / 100000000).toFixed(1)}亿`;
  }
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}万`;
  }
  return `${Math.round(value)}`;
}
