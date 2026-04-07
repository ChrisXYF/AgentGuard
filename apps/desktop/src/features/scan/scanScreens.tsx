import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { CheckState } from "../../shared/appTypes";
import { CloudMetricCard, RiskChip } from "../skills/skillsUi";
import { RepositoryScanWorkbench as RepositoryScanWorkbenchView } from "./repositoryScanWorkbench";
import {
  AlertRingIcon,
  ChevronDownTinyIcon,
  CloseCircleIcon,
  DRAG_REGION_STYLE,
  IdeaScanIcon,
  NO_DRAG_REGION_STYLE,
  PulseBoltIcon,
  SpinnerIcon,
  SuccessIcon,
  WaitingDotIcon,
  WarningIcon,
  WINDOW_DRAG_BLOCK_SELECTOR,
  isTauriRuntime,
} from "../../shared/shared";
import type {
  ComponentReport,
  Finding,
  RiskCategory,
  RepositoryScanJobStatus,
  SkillReport,
} from "../../types";

type CheckMatchSource = "skill" | "mcp" | "agent";

type CheckMatch = {
  source: CheckMatchSource;
  owner: string;
  ownerPath: string;
  filePath: string;
  fileCategory: RiskCategory;
  fileRiskScore: number;
  componentCategory: RiskCategory;
  riskScore: number;
  finding: Finding;
};

type ScanCheck = {
  label: string;
  summary: string;
  scopeLabel: string;
  state: CheckState;
  detail: string;
  matches: CheckMatch[];
};

const SCAN_CHECK_WINDOW_STORAGE_PREFIX = "agents-of-shield.scan-check-window";

function clampProgress(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function scaleProgress(value: number, inputMax: number, outputStart: number, outputEnd: number) {
  const normalized = clampProgress(value, 0, inputMax) / inputMax;
  return Math.round(outputStart + normalized * (outputEnd - outputStart));
}

function flattenFindingText(finding: Finding) {
  return `${finding.rule_id} ${finding.title} ${finding.description} ${finding.snippet}`.toLowerCase();
}

function flattenComponentText(component: ComponentReport) {
  return [
    component.name,
    component.path,
    component.component_type,
    ...component.flags,
    ...component.files.map((file) => file.path),
    ...component.files.flatMap((file) => file.findings.map(flattenFindingText)),
  ]
    .join(" ")
    .toLowerCase();
}

function buildFindingSearchText(finding: Finding) {
  return [
    finding.rule_id,
    finding.title,
    finding.description,
    finding.snippet,
  ]
    .join(" ")
    .toLowerCase();
}

function hasPattern(corpus: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(corpus));
}

function sortAndDedupeMatches(matches: CheckMatch[]) {
  const seen = new Set<string>();
  return matches
    .slice()
    .sort(
      (left, right) =>
        right.finding.severity - left.finding.severity ||
        right.riskScore - left.riskScore ||
        left.filePath.localeCompare(right.filePath),
    )
    .filter((item) => {
      const key = [
        item.source,
        item.ownerPath,
        item.filePath,
        item.finding.rule_id,
        item.finding.line,
        item.finding.title,
        item.finding.snippet,
      ].join("::");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function collectCheckMatches<T extends SkillReport | ComponentReport>(
  reports: T[],
  source: CheckMatchSource,
  matcher: (finding: Finding, filePath: string, report: T) => boolean,
) {
  return sortAndDedupeMatches(
    reports.flatMap((report) =>
      report.files.flatMap((file) =>
        file.findings
          .filter((finding) => matcher(finding, file.path, report))
          .map((finding) => ({
            source,
            owner: report.name,
            ownerPath: report.path,
            filePath: file.path,
            fileCategory: file.category,
            fileRiskScore: file.risk_score,
            componentCategory: report.category,
            riskScore: report.risk_score,
            finding,
          })),
      ),
    ),
  );
}

function resolveCheckState(issue: boolean, loading: boolean, progress: number, activeAt: number, doneAt: number): CheckState {
  if (loading) {
    if (issue && progress >= activeAt) {
      return "issue";
    }

    if (progress >= doneAt) {
      return "done";
    }

    if (progress >= activeAt) {
      return "working";
    }

    return "waiting";
  }

  return issue ? "issue" : "done";
}

function detailForState(state: CheckState, finalVerdictReady = false, pendingCloudReview = false) {
  if (state === "done") {
    if (pendingCloudReview) {
      return "云端验证中";
    }
    return finalVerdictReady ? "正常" : "已完成检查";
  }
  if (state === "issue") return "已命中";
  if (state === "working") return "分析中";
  return "等待中";
}

function getCheckStateToneClass(state: CheckState, finalVerdictReady = false) {
  if (state === "done") {
    return finalVerdictReady ? "text-[#22a86a]" : "text-[#2f76e9]";
  }

  if (state === "issue") {
    return "text-[#ef476f]";
  }

  if (state === "working") {
    return "text-[#2f76e9]";
  }

  return "text-[#c7d0dc]";
}

function getSectionStatusBadge(reviewCount: number, checkLoading: boolean, pendingCloudReview = false) {
  if (checkLoading) {
    return {
      className: "bg-[#eef5ff] text-[#2f76e9]",
      label: "扫描中",
    };
  }

  if (pendingCloudReview) {
    if (reviewCount > 0) {
      return {
        className: "bg-[#fff4e8] text-[#c97a00]",
        label: "本地命中",
      };
    }

    return {
      className: "bg-[#eef5ff] text-[#2f76e9]",
      label: "待云端复核",
    };
  }

  return reviewCount > 0
    ? {
        className: "bg-[#fff1f4] text-[#ef476f]",
        label: "需关注",
      }
    : {
        className: "bg-[#ebf7f1] text-[#13804b]",
        label: "正常",
      };
}

function buildScanCheck({
  activeAt,
  detailMatches,
  doneAt,
  finalVerdictReady,
  issue,
  label,
  loading,
  pendingCloudReview,
  progress,
  scopeLabel,
  summary,
}: {
  activeAt: number;
  detailMatches: CheckMatch[];
  doneAt: number;
  finalVerdictReady: boolean;
  issue?: boolean;
  label: string;
  loading: boolean;
  pendingCloudReview: boolean;
  progress: number;
  scopeLabel: string;
  summary: string;
}): ScanCheck {
  const checkState = resolveCheckState(issue ?? detailMatches.length > 0, loading, progress, activeAt, doneAt);
  return {
    label,
    summary,
    scopeLabel,
    state: checkState,
    detail: detailForState(checkState, finalVerdictReady, pendingCloudReview),
    matches: detailMatches,
  };
}

function getCheckMatchSourceMeta(source: CheckMatchSource) {
  switch (source) {
    case "mcp":
      return {
        label: "MCP",
        badgeClass: "border-[#ffe3ba] bg-[#fff4e6] text-[#c97a00]",
      };
    case "agent":
      return {
        label: "Agent",
        badgeClass: "border-[#ffd6df] bg-[#fff1f4] text-[#cf2e5c]",
      };
    case "skill":
    default:
      return {
        label: "Skill",
        badgeClass: "border-[#dbe8ff] bg-[#eef5ff] text-[#2f76e9]",
      };
  }
}

function normalizeWindowToken(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "risk-check";
}

function buildScanCheckWindowLabel(check: ScanCheck) {
  return `scan-check-detail-${normalizeWindowToken(check.scopeLabel)}-${normalizeWindowToken(check.label)}-${Date.now().toString(36)}`;
}

function buildScanCheckWindowStorageKey(label: string) {
  return `${SCAN_CHECK_WINDOW_STORAGE_PREFIX}.${label}`;
}

function storeScanCheckWindowPayload(storageKey: string, check: ScanCheck) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(check));
}

function loadScanCheckWindowPayload(storageKey?: string | null) {
  if (!storageKey || typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as ScanCheck) : null;
  } catch {
    return null;
  }
}

function clearScanCheckWindowPayload(storageKey?: string | null) {
  if (!storageKey || typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(storageKey);
}


function CheckStatusAction({
  finalVerdictReady,
  item,
  onOpenWindow,
}: {
  finalVerdictReady: boolean;
  item: ScanCheck;
  onOpenWindow?: (item: ScanCheck) => void;
}) {
  if (item.state === "issue" && item.matches.length > 0 && onOpenWindow) {
    return (
      <button
        type="button"
        onClick={() => void onOpenWindow(item)}
        className="shrink-0 rounded-full border border-[#ffd8e0] bg-[#fff1f4] px-3 py-1 text-[13px] font-semibold text-[#ef476f] transition hover:border-[#ffc2cf] hover:bg-[#ffe7ee]"
      >
        查看
      </button>
    );
  }

  return (
    <span
      className={`shrink-0 text-[14px] font-medium ${getCheckStateToneClass(item.state, finalVerdictReady)}`}
    >
      {item.detail}
    </span>
  );
}

function CheckStateIcon({
  finalVerdictReady,
  item,
  pendingCloudReview,
}: {
  finalVerdictReady: boolean;
  item: ScanCheck;
  pendingCloudReview: boolean;
}) {
  const toneClass = getCheckStateToneClass(item.state, finalVerdictReady);

  if (item.state === "done" && pendingCloudReview) {
    return (
      <span className={toneClass}>
        <SpinnerIcon />
      </span>
    );
  }

  return (
    <span className={toneClass}>
      {item.state === "done" ? (
        <SuccessIcon />
      ) : item.state === "issue" ? (
        <WarningIcon />
      ) : item.state === "working" ? (
        <SpinnerIcon />
      ) : (
        <WaitingDotIcon />
      )}
    </span>
  );
}

function ReviewNotesContent() {
  return (
    <div className="space-y-3 text-[14px] leading-7 text-[#5d6d82]">
      <p>先按 `Severity` 和 `Risk score` 从高到低处理，优先清理能够直接执行、联网或访问敏感文件的命中。</p>
      <p>逐条核对文件路径和代码片段，确认命中是否属于真实业务需求，再决定是收敛权限、删除能力还是补显式授权。</p>
      <p>如果这一类风险对应运行时行为，建议回到活动监控继续追踪完整调用链。</p>
    </div>
  );
}

function buildCheckMatchKey(item: CheckMatch) {
  return [item.source, item.ownerPath, item.filePath, item.finding.rule_id, item.finding.line, item.finding.title].join("::");
}

function basenamePath(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
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

function severityAppearance(severity: number) {
  if (severity >= 25) {
    return {
      badgeClass: "border-[#ffd9de] bg-[#fff1f4] text-[#cf2e5c]",
      panelClass: "border-[#fde3e7] bg-[#fff8fa]",
      textClass: "text-[#cf2e5c]",
      toneLabel: "高危",
    };
  }

  if (severity >= 12) {
    return {
      badgeClass: "border-[#ffe3ba] bg-[#fff4e6] text-[#c97a00]",
      panelClass: "border-[#f6dfbe] bg-[#fffaf0]",
      textClass: "text-[#c97a00]",
      toneLabel: "中危",
    };
  }

  return {
    badgeClass: "border-[#dbe8ff] bg-[#eef5ff] text-[#2f76e9]",
    panelClass: "border-[#dbe8ff] bg-[#f8fbff]",
    textClass: "text-[#2f76e9]",
    toneLabel: "观察",
  };
}

function getSeverityUserSummary(severity: number) {
  if (severity >= 25) {
    return {
      description: "这条命中本身风险较高，建议优先复核。",
      label: "高风险",
      textClass: "text-[#cf2e5c]",
    };
  }

  if (severity >= 12) {
    return {
      description: "这条命中值得留意，建议结合上下文继续确认。",
      label: "需要留意",
      textClass: "text-[#c97a00]",
    };
  }

  return {
    description: "这条命中影响相对较轻，可以排在后面处理。",
    label: "风险较低",
    textClass: "text-[#2f76e9]",
  };
}

function getRiskCategoryUserSummary(category: RiskCategory, scopeLabel: string) {
  switch (category) {
    case "malicious":
      return {
        description: `${scopeLabel}整体已出现明显高危特征，建议尽快处理。`,
        label: "建议立即处理",
        textClass: "text-[#cf2e5c]",
      };
    case "high_risk":
      return {
        description: `${scopeLabel}里存在较强风险信号，建议优先复核。`,
        label: "高风险",
        textClass: "text-[#cf2e5c]",
      };
    case "suspicious":
      return {
        description: `${scopeLabel}里有可疑能力点，建议继续确认用途。`,
        label: "需要留意",
        textClass: "text-[#c97a00]",
      };
    case "safe":
    default:
      return {
        description: `${scopeLabel}整体风险相对较低，但仍建议结合命中继续查看。`,
        label: "风险较低",
        textClass: "text-[#18824c]",
      };
  }
}

function ReviewNotesDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[#0f172a]/18 px-6 py-8 backdrop-blur-[8px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-[28px] border border-[#dce6f3] bg-[linear-gradient(180deg,#fbfdff_0%,#f4f7fc_100%)] shadow-[0_28px_80px_rgba(15,23,42,0.16)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[#e4ecf7] px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8fa0b6]">Review Notes</div>
              <h3 className="mt-2 text-[24px] font-semibold tracking-[-0.04em] text-[#243042]">处理意见</h3>
              <p className="mt-2 text-[13px] leading-6 text-[#7c8ca1]">
                这里给出这一类风险的处理方向，方便在复核明细后快速决定下一步动作。
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#dde6f4] bg-white text-[#7f8a98] transition hover:border-[#c8d5e8] hover:text-[#4f5f73]"
            >
              <CloseCircleIcon />
            </button>
          </div>
        </div>

        <div className="px-6 py-5">
          <ReviewNotesContent />
        </div>
      </div>
    </div>
  );
}

function ScanCheckContent({ check }: { check: ScanCheck }) {
  const [selectedMatchKey, setSelectedMatchKey] = useState<string | null>(
    check.matches[0] ? buildCheckMatchKey(check.matches[0]) : null,
  );

  useEffect(() => {
    setSelectedMatchKey(check.matches[0] ? buildCheckMatchKey(check.matches[0]) : null);
  }, [check]);

  const affectedComponents = new Set(check.matches.map((item) => `${item.source}:${item.ownerPath}`)).size;
  const affectedFiles = new Set(check.matches.map((item) => item.filePath)).size;
  const highestSeverity = check.matches.reduce((max, item) => Math.max(max, item.finding.severity), 0);
  const highlightedOwners = Array.from(new Set(check.matches.map((item) => item.owner))).slice(0, 3);
  const sourceCounts = check.matches.reduce<Record<CheckMatchSource, number>>(
    (acc, item) => {
      acc[item.source] += 1;
      return acc;
    },
    { skill: 0, mcp: 0, agent: 0 },
  );
  const componentList = Array.from(
    new Map(
      check.matches.map((item) => [
        `${item.source}:${item.ownerPath}`,
        {
          source: item.source,
          owner: item.owner,
          ownerPath: item.ownerPath,
        },
      ]),
    ).values(),
  ).slice(0, 8);
  const summarySuffix =
    highlightedOwners.length === 0
      ? "当前没有可展示的明细结果。"
      : `重点涉及 ${highlightedOwners.join("、")}${affectedComponents > highlightedOwners.length ? ` 等 ${affectedComponents} 个组件` : ""}。`;
  const selectedMatch =
    check.matches.find((item) => buildCheckMatchKey(item) === selectedMatchKey) ?? check.matches[0] ?? null;
  const selectedSourceMeta = selectedMatch ? getCheckMatchSourceMeta(selectedMatch.source) : null;
  const selectedSeverity = selectedMatch ? severityAppearance(selectedMatch.finding.severity) : null;
  const selectedSeverityScore = selectedMatch?.finding.severity ?? 0;
  const selectedFileRiskScore = selectedMatch?.fileRiskScore ?? 0;
  const selectedComponentRiskScore = selectedMatch?.riskScore ?? 0;
  const selectedSeveritySummary = getSeverityUserSummary(selectedSeverityScore);
  const selectedFileSummary = selectedMatch
    ? getRiskCategoryUserSummary(selectedMatch.fileCategory, "这个文件")
    : null;
  const selectedComponentSummary = selectedMatch
    ? getRiskCategoryUserSummary(selectedMatch.componentCategory, "这个组件")
    : null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-[18px] border border-[#dde5ef] bg-white shadow-[0_14px_34px_rgba(18,32,56,0.05)]">
      <aside className="flex w-[350px] shrink-0 flex-col border-r border-[#e8edf4] bg-[#f8fafc]">
        <div className="border-b border-[#e8edf4] px-4 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">Risk Inspector</div>
          <h2 className="mt-1 text-[20px] font-semibold tracking-[-0.03em] text-[#243042]">{check.label}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[#eef5ff] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#2f76e9]">
              {check.scopeLabel}
            </span>
            <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6f7f94] ring-1 ring-[#dbe4f0]">
              {check.matches.length} Findings
            </span>
            <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6f7f94] ring-1 ring-[#dbe4f0]">
              最高严重度 {highestSeverity}
            </span>
          </div>
          <p className="mt-3 text-[12px] leading-6 text-[#6f7f94]">
            {summarySuffix}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-px border-b border-[#e8edf4] bg-[#e8edf4]">
          <div className="bg-[#f8fafc] px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8d97a4]">命中项</div>
            <div className="mt-1 text-[22px] font-semibold tracking-[-0.04em] text-[#243042]">{check.matches.length}</div>
          </div>
          <div className="bg-[#f8fafc] px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8d97a4]">组件</div>
            <div className="mt-1 text-[22px] font-semibold tracking-[-0.04em] text-[#243042]">{affectedComponents}</div>
          </div>
          <div className="bg-[#f8fafc] px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8d97a4]">文件</div>
            <div className="mt-1 text-[22px] font-semibold tracking-[-0.04em] text-[#243042]">{affectedFiles}</div>
          </div>
        </div>

        <div className="border-b border-[#e8edf4] px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">命中列表</div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {check.matches.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#d8e3f2] bg-white px-4 py-8 text-[12px] leading-6 text-[#8d97a4]">
              当前没有可展示的风险明细。
            </div>
          ) : (
            <div className="space-y-2">
              {check.matches.map((item, index) => {
                const key = buildCheckMatchKey(item);
                const active = key === selectedMatchKey;
                const sourceMeta = getCheckMatchSourceMeta(item.source);
                const severity = severityAppearance(item.finding.severity);

                return (
                  <button
                    key={`${key}-${index}`}
                    type="button"
                    onClick={() => setSelectedMatchKey(key)}
                    className={`w-full rounded-[16px] border px-3 py-3 text-left transition ${
                      active
                        ? "border-[#c7daff] bg-white shadow-[0_10px_22px_rgba(47,118,233,0.1)]"
                        : "border-[#e3e9f2] bg-[#fbfcfe] hover:border-[#d4dfed] hover:bg-white"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <div className="truncate text-[13px] font-semibold text-[#243042]">{item.finding.title}</div>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${severity.badgeClass}`}>
                            {severity.toneLabel}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-[11px] text-[#8a98aa]">
                          {basenamePath(item.filePath)} · {item.owner}
                        </div>
                      </div>
                      <div className="shrink-0 rounded-[14px] border border-[#edf2f7] bg-white px-2.5 py-1.5 text-right">
                        <div className={`text-[18px] font-semibold tracking-[-0.04em] ${severity.textClass}`}>
                          {item.finding.severity}
                        </div>
                        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#a0acbd]">
                          sev
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${sourceMeta.badgeClass}`}>
                        {sourceMeta.label}
                      </span>
                      <span className="rounded-full border border-[#dbe4f0] bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6d7c90]">
                        {item.finding.rule_id}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <section className="min-w-0 flex flex-1 flex-col bg-white">
        {selectedMatch ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Header Area */}
            <header className="shrink-0 border-b border-[#e8edf4] bg-white px-8 py-6">
              <div className="flex flex-wrap items-center gap-2">
                {selectedSourceMeta ? (
                  <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${selectedSourceMeta.badgeClass}`}>
                    {selectedSourceMeta.label}
                  </span>
                ) : null}
                {selectedSeverity ? (
                  <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${selectedSeverity.badgeClass}`}>
                    {selectedSeveritySummary.label} · 内部分 {selectedMatch.finding.severity}
                  </span>
                ) : null}
                <span className="rounded-md border border-[#dbe4f0] bg-[#f8fafc] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#6d7c90]">
                  Rule {selectedMatch.finding.rule_id}
                </span>
              </div>
              <h3 className="mt-3 text-[22px] font-semibold tracking-[-0.03em] text-[#1e293b]">
                {selectedMatch.finding.title}
              </h3>
              <p className="mt-2 text-[13px] leading-6 text-[#64748b]">
                {selectedMatch.finding.description}
              </p>
            </header>

            {/* Scrollable Content */}
            <div className="min-h-0 flex-1 overflow-y-auto bg-[#f8fafc] px-8 py-6">
              <div className="mx-auto grid max-w-[1080px] gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
                {/* Main Left Column (Specs & Code) */}
                <div className="min-w-0 space-y-6">
                  {/* Detail Properties */}
                  <section className="overflow-hidden rounded-xl border border-[#e2e8f0] bg-white shadow-sm">
                    <div className="grid grid-cols-1 divide-y divide-[#e2e8f0] sm:grid-cols-2 sm:divide-x sm:divide-y lg:grid-cols-4 lg:divide-y-0">
                      <div className="px-5 py-3">
                        <div className="text-[10px] font-medium uppercase tracking-wider text-[#94a3b8]">位置</div>
                        <div className="mt-1 text-[13px] font-semibold text-[#334155]">第 {selectedMatch.finding.line} 行</div>
                      </div>
                      <div className="px-5 py-3">
                        <div className="text-[10px] font-medium uppercase tracking-wider text-[#94a3b8]">当前命中</div>
                        <div className={`mt-1 text-[13px] font-semibold ${selectedSeveritySummary.textClass}`}>
                          {selectedSeveritySummary.label}
                        </div>
                        <div className="mt-1 text-[11px] leading-5 text-[#64748b]">{selectedSeveritySummary.description}</div>
                        <div className="mt-1 text-[10px] text-[#94a3b8]">内部分值 {selectedSeverityScore}</div>
                      </div>
                      <div className="px-5 py-3">
                        <div className="text-[10px] font-medium uppercase tracking-wider text-[#94a3b8]">目标文件</div>
                        <div className={`mt-1 text-[13px] font-semibold ${selectedFileSummary?.textClass ?? "text-[#334155]"}`}>
                          {selectedFileSummary?.label ?? "待判断"}
                        </div>
                        <div className="mt-1 text-[11px] leading-5 text-[#64748b]">{selectedFileSummary?.description}</div>
                        <div className="mt-1 text-[10px] text-[#94a3b8]">内部分值 {selectedFileRiskScore}</div>
                      </div>
                      <div className="px-5 py-3">
                        <div className="text-[10px] font-medium uppercase tracking-wider text-[#94a3b8]">所属组件</div>
                        <div className={`mt-1 text-[13px] font-semibold ${selectedComponentSummary?.textClass ?? "text-[#334155]"}`}>
                          {selectedComponentSummary?.label ?? "待判断"}
                        </div>
                        <div className="mt-1 text-[11px] leading-5 text-[#64748b]">{selectedComponentSummary?.description}</div>
                        <div className="mt-1 text-[10px] text-[#94a3b8]">内部分值 {selectedComponentRiskScore}</div>
                      </div>
                    </div>
                    <div className="border-t border-[#e2e8f0] px-5 py-3">
                      <div className="text-[10px] font-medium uppercase tracking-wider text-[#94a3b8]">目标文件</div>
                      <div className="mt-1 break-all font-mono text-[12px] text-[#475569]">{selectedMatch.filePath}</div>
                    </div>
                  </section>

                  {/* Code Snippet */}
                  <section>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#64748b]">代码片段预览</div>
                    {selectedMatch.finding.snippet ? (
                      <div className="overflow-hidden rounded-xl border border-[#e2e8f0] bg-white shadow-sm">
                        <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-4 py-2">
                          <div className="text-[11px] font-medium text-[#64748b]">{basenamePath(selectedMatch.filePath)}</div>
                          <div className="text-[10px] font-medium text-[#94a3b8]">Line {selectedMatch.finding.line}</div>
                        </div>
                        <pre className="max-w-full overflow-x-auto bg-[#f8fafc] p-5 text-[13px] leading-[1.6] text-[#334155] [scrollbar-color:#cbd5e1_transparent]">
                          <code>{selectedMatch.finding.snippet}</code>
                        </pre>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-[#cbd5e1] bg-white px-4 py-8 text-center text-[13px] text-[#94a3b8] shadow-sm">
                        当前命中没有附带代码片段。
                      </div>
                    )}
                  </section>
                </div>

                {/* Right Sidebar (Context & Components) */}
                <aside className="space-y-6">
                  {/* Context */}
                  <section>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#64748b]">检查概览</div>
                    <div className="overflow-hidden rounded-xl border border-[#e2e8f0] bg-white shadow-sm">
                      <div className="border-b border-[#e2e8f0] px-5 py-4">
                        <div className="text-[10px] font-medium uppercase tracking-wider text-[#94a3b8]">说明</div>
                        <div className="mt-1.5 text-[13px] leading-relaxed text-[#475569]">{check.summary}</div>
                      </div>
                      <div className="px-5 py-4">
                        <div className="text-[10px] font-medium uppercase tracking-wider text-[#94a3b8]">概况</div>
                        <div className="mt-1.5 text-[13px] leading-relaxed text-[#475569]">{summarySuffix}</div>
                      </div>
                    </div>
                  </section>

                  {/* Components */}
                  <section>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#64748b]">受影响组件</div>
                    <div className="space-y-2">
                      {componentList.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-[#cbd5e1] bg-white px-4 py-6 text-center text-[13px] text-[#94a3b8] shadow-sm">
                          当前没有组件级明细。
                        </div>
                      ) : (
                        componentList.map((item, index) => {
                          const meta = getCheckMatchSourceMeta(item.source);
                          return (
                            <div key={`${item.ownerPath}-${index}`} className="rounded-xl border border-[#e2e8f0] bg-white p-4 shadow-sm">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[13px] font-semibold text-[#334155]">{item.owner}</div>
                                  <div className="mt-1 truncate font-mono text-[11px] text-[#64748b]">{item.ownerPath}</div>
                                </div>
                                <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${meta.badgeClass}`}>
                                  {meta.label}
                                </span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </section>
                </aside>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center bg-[#f8fafc] px-8 py-10 text-[13px] text-[#94a3b8]">
            当前没有可展示的风险详情。
          </div>
        )}
      </section>
    </div>
  );
}


export function ScanCheckDetailWindowScreen({
  initialTitle,
  storageKey,
}: {
  initialTitle?: string | null;
  storageKey?: string | null;
}) {
  const [check, setCheck] = useState<ScanCheck | null>(() => loadScanCheckWindowPayload(storageKey));
  const [reviewNotesOpen, setReviewNotesOpen] = useState(false);

  useEffect(() => {
    setCheck(loadScanCheckWindowPayload(storageKey));
  }, [storageKey]);

  return (
    <main className="relative flex h-screen min-h-0 flex-col overflow-hidden bg-[#f4f6f9] text-[#1f2a37]">
      <div
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-20 h-10 select-none"
        style={DRAG_REGION_STYLE}
      />
      <header
        data-tauri-drag-region
        onMouseDown={startWindowDrag}
        className="relative z-10 flex h-14 shrink-0 items-center border-b border-[#e5ebf3] bg-white/95 pl-20 pr-4 backdrop-blur"
        style={DRAG_REGION_STYLE}
      >
        <div data-tauri-drag-region className="min-w-0" style={DRAG_REGION_STYLE}>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8ea0b6]">Risk Inspector</div>
          <div className="mt-0.5 truncate text-[14px] font-semibold text-[#243042]">
            {check?.label ?? initialTitle ?? "风险详情"}
          </div>
        </div>

        <div className="min-h-[40px] flex-1" data-tauri-drag-region style={DRAG_REGION_STYLE} />

        <div className="flex items-center gap-2" data-window-drag-disabled="true" style={NO_DRAG_REGION_STYLE}>
          {check ? (
            <span className="rounded-full bg-[#f5f7fb] px-2.5 py-1 text-[11px] font-semibold text-[#6f7f94]">
              {check.matches.length} findings
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setReviewNotesOpen(true)}
            disabled={!check}
            className="rounded-lg border border-[#d7e3f6] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#516072] transition hover:border-[#bfd2f3] hover:bg-[#f8fbff] hover:text-[#2f76e9] disabled:cursor-not-allowed disabled:opacity-50"
          >
            处理意见
          </button>
        </div>
      </header>

      <section className="min-h-0 flex-1 overflow-hidden p-4">
        {check ? (
          <ScanCheckContent check={check} />
        ) : (
          <div className="flex h-full items-center justify-center rounded-[18px] border border-dashed border-[#d8e3f2] bg-white px-6 py-16 text-center text-[15px] leading-8 text-[#8d97a4] shadow-[0_14px_34px_rgba(18,32,56,0.05)]">
            当前无法恢复这条风险详情。请回到扫描结果页重新点击一次“查看”。
          </div>
        )}
      </section>

      {reviewNotesOpen ? <ReviewNotesDialog onClose={() => setReviewNotesOpen(false)} /> : null}
    </main>
  );
}

function openScanCheckWindow(check: ScanCheck) {
  const label = buildScanCheckWindowLabel(check);
  const storageKey = buildScanCheckWindowStorageKey(label);
  const title = `${check.label} · 风险详情`;

  storeScanCheckWindowPayload(storageKey, check);

  if (isTauriRuntime()) {
    return invoke("open_scan_check_window", {
      windowLabel: label,
      title,
      storageKey,
    });
  }

  const route = `/?window=scan-check-detail&label=${encodeURIComponent(label)}&storageKey=${encodeURIComponent(storageKey)}&title=${encodeURIComponent(title)}`;
  window.open(route, "_blank", "noopener,noreferrer,width=1220,height=860");
  return Promise.resolve();
}

export function ScanScreen({
  agentFindings,
  agentResults,
  backend,
  currentRunHasResult,
  errorMessage,
  findingsCount,
  loading,
  mcpResults,
  mcpFindings,
  pickingDirectory,
  onBack,
  onOpenActivity,
  onOpenDetail,
  onQuickFix,
  onScan,
  onStopScan,
  progress,
  results,
  scanInterrupted,
  stopping,
  scannedAgents,
  scannedComponents,
  scannedMcps,
  scannedRoots,
  repositoryScanCurrentFile,
  repositoryScanJob,
  repositoryScanDisplayProgress,
  repositoryScanLoading,
  repositoryScanRevealPending,
  repositoryScanTargetPath,
  standaloneRepositoryWindow,
  skillFindings,
  onOpenRepositoryResult,
}: {
  agentFindings: number;
  agentResults: ComponentReport[];
  backend: string;
  currentRunHasResult: boolean;
  errorMessage: string | null;
  findingsCount: number;
  loading: boolean;
  mcpResults: ComponentReport[];
  mcpFindings: number;
  pickingDirectory: boolean;
  onBack: () => void;
  onOpenActivity: () => void;
  onOpenDetail: (path: string) => void;
  onQuickFix: () => void;
  onScan: () => Promise<void>;
  onStopScan: () => void;
  progress: number;
  results: SkillReport[];
  scanInterrupted: boolean;
  stopping: boolean;
  scannedAgents: number;
  scannedComponents: number;
  scannedMcps: number;
  scannedRoots: string[];
  repositoryScanCurrentFile: string;
  repositoryScanJob: RepositoryScanJobStatus | null;
  repositoryScanDisplayProgress: number;
  repositoryScanLoading: boolean;
  repositoryScanRevealPending: boolean;
  repositoryScanTargetPath: string | null;
  standaloneRepositoryWindow: boolean;
  skillFindings: number;
  onOpenRepositoryResult: () => void;
}) {
  const isRepositoryScan = backend === "repository_audit";
  const postLocalProcessing = false;
  const pendingCloudReview = false;
  const checkLoading = loading && !postLocalProcessing;
  const [analysisExpanded, setAnalysisExpanded] = useState(true);
  const [mcpExpanded, setMcpExpanded] = useState(true);
  const [agentExpanded, setAgentExpanded] = useState(true);
  const [riskPanelOpen, setRiskPanelOpen] = useState(false);
  const focusSkill = results[0] ?? null;
  const focusFile = focusSkill?.files[0];
  const skillScopeLabel = isRepositoryScan ? "代码安全分析" : "AI Skills 安全";
  const mcpScopeLabel = isRepositoryScan ? "MCP 配置检测" : "Tools / MCP 安全";
  const agentScopeLabel = isRepositoryScan ? "检测报告" : "Agent 行为监控";
  const {
    anomalousPatternDetailMatches,
    anomalousPatternFallbackIssue,
    anomalousPatternMatches,
    commandExecutionMatches,
    dataExfilMatches,
    externalApiMatches,
    fileOperationsMatches,
    mcpEndpointMatches,
    networkMatches,
    networkRequestMatches,
    promptInjectionMatches,
    remoteDownloadMatches,
    secretMatches,
    sensitiveMatches,
    shellMatches,
    toolPoisoningMatches,
    toolShadowingMatches,
    unknownToolDetailMatches,
    unknownToolFallbackIssue,
    unknownToolMatches,
  } = useMemo(() => {
    const mcpCorpus = mcpResults.map(flattenComponentText).join(" ");
    const agentCorpus = agentResults.map(flattenComponentText).join(" ");
    const allMcpMatches = collectCheckMatches(mcpResults, "mcp", () => true);
    const allAgentMatches = collectCheckMatches(agentResults, "agent", () => true);
    const shellMatches = collectCheckMatches(results, "skill", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(EXEC|CMD|SHELL)/i, /(shell|command|bash|terminal|execution)/i]),
    );
    const networkMatches = collectCheckMatches(results, "skill", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(NET|HTTP|FETCH)/i, /(network|http|https|fetch|socket|endpoint)/i]),
    );
    const sensitiveMatches = collectCheckMatches(results, "skill", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(FILE|SECRET|CRED|ENV)/i, /(sensitive|credential|secret|token|file|memory)/i]),
    );
    const secretMatches = collectCheckMatches(results, "skill", (finding) =>
      hasPattern(buildFindingSearchText(finding), [
        /(secret|token|api[\s_-]?key|credential|env|access key|private key)/i,
        /(SECRET|TOKEN|KEY|CRED|ENV)/i,
      ]),
    );
    const remoteDownloadMatches = collectCheckMatches(results, "skill", (finding) =>
      hasPattern(buildFindingSearchText(finding), [
        /(download|wget|curl|invoke-webrequest|remote script|bash .*https?:\/\/|sh .*https?:\/\/)/i,
      ]),
    );
    const promptInjectionMatches = collectCheckMatches(results, "skill", (finding) =>
      hasPattern(buildFindingSearchText(finding), [
        /(prompt injection|jailbreak|system prompt|override instructions|instruction override|prompt leak)/i,
      ]),
    );
    const mcpEndpointMatches = collectCheckMatches(mcpResults, "mcp", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(unsafe endpoint|suspicious endpoint|public endpoint|endpoint exposure)/i]),
    );
    const unknownToolMatches = collectCheckMatches(mcpResults, "mcp", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(unknown tool|unrecognized tool|tool not found|unexpected tool)/i]),
    );
    const unknownToolFallbackIssue =
      mcpFindings > 0 && !hasPattern(mcpCorpus, [/(shadow|poison|unknown|api|endpoint)/i]);
    const unknownToolDetailMatches =
      unknownToolMatches.length > 0 ? unknownToolMatches : unknownToolFallbackIssue ? allMcpMatches : [];
    const toolShadowingMatches = collectCheckMatches(mcpResults, "mcp", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(tool shadowing|shadow tool|shadowing)/i]),
    );
    const toolPoisoningMatches = collectCheckMatches(mcpResults, "mcp", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(tool poisoning|poisoned tool|malicious tool)/i]),
    );
    const externalApiMatches = collectCheckMatches(mcpResults, "mcp", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(external api|webhook|outbound api|suspicious api|unsafe api)/i]),
    );
    const commandExecutionMatches = collectCheckMatches(agentResults, "agent", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(command execution|spawn|shell|exec|subprocess|terminal)/i]),
    );
    const fileOperationsMatches = collectCheckMatches(agentResults, "agent", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(file operations|read file|write file|delete file|filesystem|fs\.)/i]),
    );
    const networkRequestMatches = collectCheckMatches(agentResults, "agent", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(network request|fetch|http|https|socket|api call|outbound)/i]),
    );
    const anomalousPatternMatches = collectCheckMatches(agentResults, "agent", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(anomal|suspicious pattern|unexpected pattern|burst|loop|abnormal)/i]),
    );
    const anomalousPatternFallbackIssue =
      agentFindings > 0 && !hasPattern(agentCorpus, [/(command|file|network|exfil|outbound|upload)/i]);
    const anomalousPatternDetailMatches =
      anomalousPatternMatches.length > 0 ? anomalousPatternMatches : anomalousPatternFallbackIssue ? allAgentMatches : [];
    const dataExfilMatches = collectCheckMatches(agentResults, "agent", (finding) =>
      hasPattern(buildFindingSearchText(finding), [/(data exfil|exfiltration|upload data|outbound data|send data externally|leak)/i]),
    );

    return {
      anomalousPatternDetailMatches,
      anomalousPatternFallbackIssue,
      anomalousPatternMatches,
      commandExecutionMatches,
      dataExfilMatches,
      externalApiMatches,
      fileOperationsMatches,
      mcpEndpointMatches,
      networkMatches,
      networkRequestMatches,
      promptInjectionMatches,
      remoteDownloadMatches,
      secretMatches,
      sensitiveMatches,
      shellMatches,
      toolPoisoningMatches,
      toolShadowingMatches,
      unknownToolDetailMatches,
      unknownToolFallbackIssue,
      unknownToolMatches,
    };
  }, [agentFindings, agentResults, mcpFindings, mcpResults, results]);
  const repositoryRunFailed = isRepositoryScan && !loading && Boolean(errorMessage) && !currentRunHasResult;
  const waitingForRepositorySelection =
    isRepositoryScan &&
    !loading &&
    !repositoryScanTargetPath &&
    !repositoryRunFailed &&
    scannedRoots.length === 0 &&
    scannedComponents === 0 &&
    findingsCount === 0;
  const interruptingState = !isRepositoryScan && stopping;
  const interruptedState = !isRepositoryScan && (scanInterrupted || stopping);
  const finalVerdictReady = isRepositoryScan
    ? !loading && !pickingDirectory && !waitingForRepositorySelection && !repositoryRunFailed
    : true;
  const aiChecks: ScanCheck[] = [
    buildScanCheck({
      label: "Shell 命令执行",
      summary: "检测到可能执行 shell 或外部命令的规则命中，建议重点复核命令拼接与运行上下文。",
      scopeLabel: skillScopeLabel,
      detailMatches: shellMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 12,
      doneAt: 26,
    }),
    buildScanCheck({
      label: "网络访问权限",
      summary: "检测到网络访问、HTTP 请求或外部端点调用能力，建议确认是否存在未授权出站访问。",
      scopeLabel: skillScopeLabel,
      detailMatches: networkMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 20,
      doneAt: 38,
    }),
    buildScanCheck({
      label: "敏感文件访问",
      summary: "检测到对敏感文件、凭据或环境数据的访问行为，建议核查访问范围是否必要。",
      scopeLabel: skillScopeLabel,
      detailMatches: sensitiveMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 28,
      doneAt: 48,
    }),
    buildScanCheck({
      label: "Secrets / Token 暴露",
      summary: "检测到疑似密钥、Token 或凭据暴露线索，建议优先确认是否存在硬编码或泄露。",
      scopeLabel: skillScopeLabel,
      detailMatches: secretMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 36,
      doneAt: 58,
    }),
    buildScanCheck({
      label: "远程脚本下载",
      summary: "检测到下载远程脚本或动态获取可执行内容的能力点，建议复核下载来源与执行路径。",
      scopeLabel: skillScopeLabel,
      detailMatches: remoteDownloadMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 44,
      doneAt: 70,
    }),
    buildScanCheck({
      label: "Prompt Injection",
      summary: "检测到提示词注入、越权覆盖或系统提示泄露相关线索，建议确认输入边界与防护策略。",
      scopeLabel: skillScopeLabel,
      detailMatches: promptInjectionMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 56,
      doneAt: 84,
    }),
  ];
  const mcpChecks: ScanCheck[] = [
    buildScanCheck({
      label: "MCP endpoint",
      summary: "检测到 MCP endpoint 暴露或可疑端点配置，建议核查服务暴露范围与访问策略。",
      scopeLabel: mcpScopeLabel,
      detailMatches: mcpEndpointMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 18,
      doneAt: 32,
    }),
    buildScanCheck({
      label: "未知 Tool",
      summary: "检测到未知 Tool、未识别配置或异常工具暴露，建议确认工具来源与声明是否一致。",
      scopeLabel: mcpScopeLabel,
      detailMatches: unknownToolDetailMatches,
      finalVerdictReady,
      issue: unknownToolMatches.length > 0 || unknownToolFallbackIssue,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 30,
      doneAt: 44,
    }),
    buildScanCheck({
      label: "Tool Shadowing",
      summary: "检测到 Tool Shadowing 风险，建议检查是否存在同名工具覆盖或混淆调用链。",
      scopeLabel: mcpScopeLabel,
      detailMatches: toolShadowingMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 42,
      doneAt: 58,
    }),
    buildScanCheck({
      label: "Tool Poisoning",
      summary: "检测到疑似 Tool Poisoning 线索，建议优先确认工具实现与配置是否被污染。",
      scopeLabel: mcpScopeLabel,
      detailMatches: toolPoisoningMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 52,
      doneAt: 72,
    }),
    buildScanCheck({
      label: "外部 API 调用",
      summary: "检测到对外部 API、Webhook 或出站接口的调用，建议确认目标地址与数据外发边界。",
      scopeLabel: mcpScopeLabel,
      detailMatches: externalApiMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 62,
      doneAt: 82,
    }),
  ];
  const agentChecks: ScanCheck[] = [
    buildScanCheck({
      label: "Command execution",
      summary: "检测到命令执行、shell 调用或子进程启动线索，建议确认执行链是否超出预期权限。",
      scopeLabel: agentScopeLabel,
      detailMatches: commandExecutionMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 24,
      doneAt: 38,
    }),
    buildScanCheck({
      label: "File operations",
      summary: "检测到文件读取、写入或删除等操作，建议核查访问范围与落盘行为是否合理。",
      scopeLabel: agentScopeLabel,
      detailMatches: fileOperationsMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 36,
      doneAt: 52,
    }),
    buildScanCheck({
      label: "网络请求",
      summary: "检测到出站网络请求或外部 API 调用，建议确认是否存在未授权联网或数据上传。",
      scopeLabel: agentScopeLabel,
      detailMatches: networkRequestMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 46,
      doneAt: 62,
    }),
    buildScanCheck({
      label: "异常调用模式",
      summary: "检测到异常调用路径、可疑执行模式或无法归类的风险线索，建议结合活动监控继续追查。",
      scopeLabel: agentScopeLabel,
      detailMatches: anomalousPatternDetailMatches,
      finalVerdictReady,
      issue: anomalousPatternMatches.length > 0 || anomalousPatternFallbackIssue,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 58,
      doneAt: 74,
    }),
    buildScanCheck({
      label: "数据外发",
      summary: "检测到疑似数据外发或泄露路径，建议优先确认发送目标、传输内容和授权边界。",
      scopeLabel: agentScopeLabel,
      detailMatches: dataExfilMatches,
      finalVerdictReady,
      loading: checkLoading,
      pendingCloudReview,
      progress,
      activeAt: 68,
      doneAt: 86,
    }),
  ];
  const completedChecks = aiChecks.filter((item) => item.state === "done").length;
  const completedMcpChecks = mcpChecks.filter((item) => item.state === "done").length;
  const completedAgentChecks = agentChecks.filter((item) => item.state === "done").length;
  const mcpReviewCount = mcpChecks.filter((item) => item.state === "issue").length;
  const agentReviewCount = agentChecks.filter((item) => item.state === "issue").length;
  const localReviewCount = [...results, ...mcpResults, ...agentResults].filter((report) =>
    report.files.some((file) => file.findings.length > 0),
  ).length;
  const sessionTitle = isRepositoryScan
    ? pickingDirectory
      ? "正在选择代码仓库"
      : waitingForRepositorySelection
      ? "等待开始代码库扫描"
      : loading
      ? "代码库安全扫描进行中"
      : repositoryRunFailed
      ? "代码库扫描失败"
      : "代码库安全扫描结果"
    : postLocalProcessing
      ? "本地扫描已完成，正在云端验证"
      : loading
        ? "深度系统扫描进行中"
        : interruptingState
        ? "深度系统扫描中断中"
      : interruptedState
        ? "深度系统扫描已中断"
      : "深度系统扫描结果";
  const headline = isRepositoryScan
    ? pickingDirectory
      ? "请选择要扫描的代码仓库"
      : waitingForRepositorySelection
      ? "请选择要扫描的代码仓库"
      : loading
      ? "正在扫描代码仓库"
      : repositoryRunFailed
        ? "代码库扫描失败"
      : findingsCount > 0
        ? "代码库扫描完成，发现风险"
        : "代码库扫描完成"
    : postLocalProcessing
      ? "本地扫描完成，正在同步云端分析"
      : loading
        ? "正在扫描 Agent、MCP 和 Skills"
        : interruptingState
        ? "正在中断扫描"
      : interruptedState
        ? "扫描中断"
      : findingsCount > 0
        ? "扫描完成，发现风险"
        : "扫描完成";
  const coverageText = isRepositoryScan
    ? repositoryRunFailed
      ? "最近一次扫描没有返回结果，请检查错误信息后重新扫描。"
      : scannedRoots.length === 0 && scannedComponents === 0 && findingsCount === 0 && !loading
      ? "等待选择项目目录后开始扫描。"
      : `已分析 ${scannedComponents} 个文件，目标目录 ${scannedRoots[0] ?? "未选择"}${
        scannedAgents > 0 || scannedMcps > 0 ? ` · ${scannedAgents} 个代码文件命中 · ${scannedMcps} 个 MCP 配置命中` : ""
      }`
    : `已分析 ${scannedComponents} 个组件，覆盖 ${scannedRoots.length || 1} 个监控根目录${
        scannedAgents > 0 || scannedMcps > 0 || results.length > 0
          ? ` · ${scannedAgents} 个 Agent · ${scannedMcps} 个 MCP · ${results.length} 个 Skill`
          : ""
      }`;
  const summaryReviewCount = localReviewCount;
  const summaryReviewLabel =
    summaryReviewCount > 0
      ? `${summaryReviewCount} 个${isRepositoryScan ? "文件" : "组件"}需关注`
      : "未发现风险";
  const canOpenRiskPanel = false;
  const summaryFooterText = isRepositoryScan
    ? `${scannedComponents} 个文件 · ${summaryReviewCount} 个需关注`
    : pendingCloudReview
      ? summaryReviewCount > 0
        ? `${scannedComponents} 个组件 · 本地已命中 ${summaryReviewCount} 个需关注`
        : `${scannedComponents} 个组件 · 云端结果待确认`
      : `${scannedComponents} 个组件 · ${summaryReviewCount} 个需关注`;
  const skillStatusBadge = getSectionStatusBadge(skillFindings, checkLoading, pendingCloudReview);
  const mcpStatusBadge = getSectionStatusBadge(mcpReviewCount, checkLoading, pendingCloudReview);
  const agentStatusBadge = getSectionStatusBadge(agentReviewCount, checkLoading, pendingCloudReview);
  const showRepositoryIdleState = isRepositoryScan && (pickingDirectory || waitingForRepositorySelection);
  const displayProgress = progress;
  const progressLabel = showRepositoryIdleState ? (pickingDirectory ? "..." : "等待") : `${displayProgress}%`;
  const progressBarWidth = showRepositoryIdleState ? 0 : displayProgress;
  const scanTarget = isRepositoryScan
    ? pickingDirectory
      ? "正在等待选择代码仓库"
      : waitingForRepositorySelection
        ? "等待选择项目目录"
        : repositoryRunFailed
          ? repositoryScanTargetPath ?? "最近一次扫描失败"
        : loading
          ? scannedRoots[0]
            ? `正在分析目录 ${scannedRoots[0]}`
            : "正在分析代码仓库内容"
          : scannedRoots[0] ?? focusFile?.path ?? "等待选择项目目录"
    : postLocalProcessing
      ? "本地扫描已完成，正在上传 artifact 并等待云端分析"
      : loading
        ? progress < 28
          ? "正在发现本地 Agent / Skills / MCP 组件"
          : progress < 62
            ? "正在扫描 Skills、Prompt、Tool 与 Resource"
            : "正在汇总本地扫描结果"
        : interruptingState
        ? "正在停止本次扫描，请稍候"
      : interruptedState
        ? "本次扫描已由你手动终止"
        : scannedRoots.length > 0
        ? `已覆盖 ${scannedRoots.length} 个监控根目录`
        : "本地 Agent / Skills / MCP 组件";
  const openCheckDetails = async (item: ScanCheck) => {
    setRiskPanelOpen(false);
    await openScanCheckWindow(item);
  };

  useEffect(() => {
    if (loading || findingsCount === 0) {
      setRiskPanelOpen(false);
    }
  }, [findingsCount, loading]);

  if (isRepositoryScan) {
    return (
      <RepositoryScanWorkbenchView
        agentFindings={agentFindings}
        agentResults={agentResults}
        findingsCount={findingsCount}
        focusSkill={focusSkill}
        headline={headline}
        loading={loading}
        mcpFindings={mcpFindings}
        mcpResults={mcpResults}
        onBack={onBack}
        onOpenActivity={onOpenActivity}
        onOpenDetail={onOpenDetail}
        onQuickFix={onQuickFix}
        onScan={onScan}
        pickingDirectory={pickingDirectory}
        progress={progress}
        results={results}
        scannedAgents={scannedAgents}
        scannedComponents={scannedComponents}
        scannedMcps={scannedMcps}
        scannedRoots={scannedRoots}
        sessionTitle={sessionTitle}
        skillChecks={aiChecks}
        skillFindings={skillFindings}
        repositoryScanCurrentFile={repositoryScanCurrentFile}
        repositoryScanJob={repositoryScanJob}
        repositoryScanDisplayProgress={repositoryScanDisplayProgress}
        repositoryScanLoading={repositoryScanLoading}
        repositoryScanRevealPending={repositoryScanRevealPending}
        repositoryScanTargetPath={repositoryScanTargetPath}
        errorMessage={repositoryRunFailed ? errorMessage : null}
        onOpenResult={onOpenRepositoryResult}
        standaloneRepositoryWindow={standaloneRepositoryWindow}
        waitingForRepositorySelection={waitingForRepositorySelection}
        mcpChecks={mcpChecks}
        agentChecks={agentChecks}
      />
    );
  }

  return (
    <>
      <main className="flex min-h-0 flex-1 flex-col overflow-auto bg-[#f5f7fb]">
      <header
        data-tauri-drag-region
        className="border-b border-[#e6ebf2] bg-white px-6 py-4"
        style={DRAG_REGION_STYLE}
      >
        <div className="flex items-center gap-4">
          <div data-tauri-drag-region className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8d97a4]">
                检测会话
              </div>
              <div className="mt-1 truncate text-[18px] font-semibold tracking-[-0.02em] text-[#243042]">
                {sessionTitle}
              </div>
            </div>
          </div>

          <div data-tauri-drag-region className="min-h-[44px] flex-1" />

          <div className="flex shrink-0 items-center gap-3" data-window-drag-disabled="true" style={NO_DRAG_REGION_STYLE}>
            {loading || pickingDirectory ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-[#eef5ff] px-3 py-1.5 text-[12px] font-semibold text-[#2f76e9]">
                <span className="text-[#2f76e9]">
                  <SpinnerIcon />
                </span>
                {pickingDirectory ? "选择目录中" : postLocalProcessing ? "云端验证中" : "扫描进行中"}
              </span>
            ) : null}
            {loading || pickingDirectory ? null : (
              <button
                type="button"
                onClick={onBack}
                className="rounded-xl border border-[#dbe3ee] bg-white px-4 py-2.5 text-sm font-medium text-[#516072] transition hover:border-[#c9d6e6] hover:text-[#2f76e9]"
              >
                返回
              </button>
            )}
            <button
              type="button"
              onClick={loading ? onStopScan : () => void onScan()}
              disabled={stopping}
              className={`rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(47,118,233,0.16)] transition disabled:cursor-not-allowed disabled:opacity-60 ${
                loading
                  ? "bg-[#ef4444] hover:bg-[#dc2626]"
                  : "bg-[#2f76e9] hover:bg-[#2567d2]"
              }`}
            >
              {loading ? (stopping ? "正在终止..." : postLocalProcessing ? "终止云端验证" : "终止扫描") : "重新扫描"}
            </button>
          </div>
        </div>
      </header>

      <section className="border-b border-[#e6ebf2] bg-white px-6 py-6">
        <div className="flex items-start gap-5">
          <div className="relative hidden shrink-0 sm:block">
            <div
              className={`absolute inset-0 rounded-[22px] border-[5px] opacity-90 [transform:rotate(42deg)] ${
                interruptedState ? "border-[#fde7b0]" : "border-[#d9e8ff]"
              }`}
            />
            <div
              className={`relative flex h-[108px] w-[108px] items-center justify-center rounded-[22px] border-[4px] bg-white [transform:rotate(10deg)] ${
                interruptedState
                  ? "border-[#f4b740] text-[#d97706] shadow-[0_14px_30px_rgba(245,158,11,0.16)]"
                  : "border-[#2f76e9] text-[#2f76e9] shadow-[0_14px_30px_rgba(47,118,233,0.12)]"
              }`}
            >
              <div className="[transform:rotate(-10deg)]">
                <div className="text-center text-[18px] font-semibold tracking-[-0.03em]">{progressLabel}</div>
              </div>
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-[28px] font-semibold tracking-[-0.04em] text-[#243042]">{headline}</h2>
              <button
                type="button"
                onClick={() => {
                  if (!loading && canOpenRiskPanel) {
                    setRiskPanelOpen((current) => !current);
                  }
                }}
                disabled={loading || !canOpenRiskPanel}
                className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
                  loading || pickingDirectory
                    ? "bg-[#eef5ff] text-[#2f76e9]"
                    : interruptedState
                      ? "bg-[#fff7db] text-[#d97706]"
                    : summaryReviewCount > 0
                      ? riskPanelOpen
                        ? canOpenRiskPanel
                          ? "bg-[#ef476f] text-white hover:bg-[#db3a62]"
                          : "bg-[#fff1f4] text-[#ef476f]"
                        : canOpenRiskPanel
                          ? "bg-[#fff1f4] text-[#ef476f] hover:bg-[#ffe6ec]"
                          : "bg-[#fff1f4] text-[#ef476f]"
                      : "bg-[#ebf7f1] text-[#13804b]"
                } ${loading || !canOpenRiskPanel ? "cursor-default" : "cursor-pointer"}`}
              >
                {pickingDirectory
                  ? "等待选择"
                  : loading
                    ? stopping
                      ? "中断中"
                      : postLocalProcessing
                        ? "云端验证中"
                        : "运行中"
                    : interruptedState
                      ? "已中断"
                    : summaryReviewLabel}
              </button>
            </div>

            <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[14px] text-[#7f8a98]">
              <span className="font-medium text-[#5f6c7b]">扫描目标</span>
              <span className="truncate font-mono text-[13px] text-[#667485]">{scanTarget}</span>
              <span className="font-medium text-[#5f6c7b]">覆盖范围</span>
              <span>{coverageText}</span>
            </div>
          </div>
        </div>

        <div className="mt-5">
          <div className="h-2 overflow-hidden rounded-full bg-[#edf1f5]">
            <div
              className={`h-full transition-all duration-300 ${interruptedState ? "bg-[#f4b740]" : "bg-[#2f76e9]"}`}
              style={{ width: `${progressBarWidth}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[12px] text-[#8d97a4]">
            <span>
              {pickingDirectory
                ? "等待选择目录"
                : loading
                  ? stopping
                    ? `正在中断，当前停在 ${progress}%`
                    : postLocalProcessing
                      ? "本地扫描已完成，正在进行云端验证"
                      : `已完成 ${progress}%`
                  : interruptedState
                    ? `扫描中断于 ${progress}%`
                    : "扫描完成"}
            </span>
            <span>{summaryFooterText}</span>
          </div>
        </div>
      </section>

      <section className="flex flex-1 flex-col gap-4 p-6">
        <section className="overflow-hidden rounded-[24px] border border-[#dde5ef] bg-white shadow-[0_12px_28px_rgba(18,32,56,0.04)]">
          <button
            type="button"
            onClick={() => setAnalysisExpanded((current) => !current)}
            className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
          >
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eef5ff] text-[#2f76e9]">
                <IdeaScanIcon />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-[#243042]">
                    {isRepositoryScan ? "代码安全分析" : "AI Skills 安全"}
                  </h3>
                  <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${skillStatusBadge.className}`}>
                    {skillStatusBadge.label}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[#8d97a4]">
                  {pendingCloudReview
                    ? analysisExpanded
                      ? "本地检查已完成，等待云端补充最终风险结论。"
                      : `本地 ${completedChecks}/${aiChecks.length} 项检查完成，等待云端复核。`
                    : analysisExpanded
                    ? isRepositoryScan
                      ? "当前代码库扫描的核心风险检查。"
                      : "当前扫描的 Skills 风险检查。"
                    : `当前已有 ${completedChecks}/${aiChecks.length} 项检查完成。`}
                </p>
              </div>
            </div>

            <span className={`text-[#a8b1be] transition ${analysisExpanded ? "rotate-180" : ""}`}>
              <ChevronDownTinyIcon />
            </span>
          </button>

          {analysisExpanded ? (
            <div className="border-t border-[#eef2f6] px-6 py-3">
              <div className="space-y-1">
                {aiChecks.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-5 rounded-2xl px-3 py-3 transition hover:bg-[#fafbfd]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <CheckStateIcon item={item} finalVerdictReady={finalVerdictReady} pendingCloudReview={pendingCloudReview} />
                    <span className={`truncate text-[16px] ${item.state === "waiting" ? "text-[#bcc6d2]" : "text-[#4f5d70]"}`}>
                      {item.label}
                    </span>
                  </div>
                    <CheckStatusAction item={item} finalVerdictReady={finalVerdictReady} onOpenWindow={openCheckDetails} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="overflow-hidden rounded-[24px] border border-[#dde5ef] bg-white shadow-[0_12px_28px_rgba(18,32,56,0.04)]">
          <button
            type="button"
            onClick={() => setMcpExpanded((current) => !current)}
            className="flex w-full items-start justify-between gap-5 px-6 py-5 text-left"
          >
            <div className="flex min-w-0 items-start gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#f3f7ff] text-[#6f86a8]">
                <PulseBoltIcon />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-[#243042]">
                    {isRepositoryScan ? "MCP 配置检测" : "Tools / MCP 安全"}
                  </h3>
                  <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${mcpStatusBadge.className}`}>
                    {mcpStatusBadge.label}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[#8d97a4]">
                  {pendingCloudReview
                    ? mcpExpanded
                      ? "本地检查已完成，等待云端补充 MCP 与外部接口风险结论。"
                      : `本地 ${completedMcpChecks}/${mcpChecks.length} 项检查完成，等待云端复核。`
                    : mcpExpanded
                    ? isRepositoryScan
                      ? "检测代码仓库中的 MCP 配置、端点和外部接口风险。"
                      : "检测 MCP Tools 和外部接口风险。"
                    : `当前已有 ${completedMcpChecks}/${mcpChecks.length} 项检查完成。`}
                </p>
              </div>
            </div>

            <span className={`shrink-0 text-[#a8b1be] transition ${mcpExpanded ? "rotate-180" : ""}`}>
              <ChevronDownTinyIcon />
            </span>
          </button>

          {mcpExpanded ? (
            <div className="border-t border-[#eef2f6] px-6 py-3">
              <div className="space-y-1">
                {mcpChecks.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-5 rounded-2xl px-3 py-3 transition hover:bg-[#fafbfd]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <CheckStateIcon item={item} finalVerdictReady={finalVerdictReady} pendingCloudReview={pendingCloudReview} />
                    <span className={`truncate text-[16px] ${item.state === "waiting" ? "text-[#bcc6d2]" : "text-[#4f5d70]"}`}>
                      {item.label}
                    </span>
                  </div>
                    <CheckStatusAction item={item} finalVerdictReady={finalVerdictReady} onOpenWindow={openCheckDetails} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="overflow-hidden rounded-[24px] border border-[#dde5ef] bg-white shadow-[0_12px_28px_rgba(18,32,56,0.04)]">
          <button
            type="button"
            onClick={() => setAgentExpanded((current) => !current)}
            className="flex w-full items-start justify-between gap-5 px-6 py-5 text-left"
          >
            <div className="flex min-w-0 items-start gap-4">
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
                  agentReviewCount > 0 ? "bg-[#fff3f5] text-[#ef476f]" : "bg-[#eef5ff] text-[#2f76e9]"
                }`}
              >
                <AlertRingIcon />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-[#243042]">
                    {isRepositoryScan ? "检测报告" : "Agent 行为监控"}
                  </h3>
                  <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${agentStatusBadge.className}`}>
                    {agentStatusBadge.label}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[#8d97a4]">
                  {pendingCloudReview
                    ? agentExpanded
                      ? "本地检查已完成，等待云端补充行为与数据外发风险结论。"
                      : `本地 ${completedAgentChecks}/${agentChecks.length} 项检查完成，等待云端复核。`
                    : agentExpanded
                    ? isRepositoryScan
                      ? "汇总代码执行、文件操作、网络访问和数据外发相关风险。"
                      : "检测 Agent 执行过程中的异常行为。"
                    : `当前已有 ${completedAgentChecks}/${agentChecks.length} 项检查完成。`}
                </p>
              </div>
            </div>

            <span className={`shrink-0 text-[#a8b1be] transition ${agentExpanded ? "rotate-180" : ""}`}>
              <ChevronDownTinyIcon />
            </span>
          </button>

          {agentExpanded ? (
            <div className="border-t border-[#eef2f6] px-6 py-3">
              <div className="space-y-1">
                {agentChecks.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-5 rounded-2xl px-3 py-3 transition hover:bg-[#fafbfd]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <CheckStateIcon item={item} finalVerdictReady={finalVerdictReady} pendingCloudReview={pendingCloudReview} />
                    <span className={`truncate text-[16px] ${item.state === "waiting" ? "text-[#bcc6d2]" : "text-[#4f5d70]"}`}>
                      {item.label}
                    </span>
                  </div>
                    <CheckStatusAction item={item} finalVerdictReady={finalVerdictReady} onOpenWindow={openCheckDetails} />
                  </div>
                ))}
              </div>

              {isRepositoryScan && results.length > 0 ? (
                <div className="mt-4 rounded-[20px] border border-[#e7edf5] bg-[#fafcff] px-4 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[13px] font-semibold text-[#344256]">命中文件</div>
                      <div className="mt-1 text-[12px] text-[#8d97a4]">按风险优先级展示前 4 个文件，可直接进入详情页继续复核。</div>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {results.slice(0, 4).map((result) => (
                      <button
                        key={result.path}
                        type="button"
                        onClick={() => onOpenDetail(result.path)}
                        className="flex w-full items-center justify-between gap-4 rounded-2xl border border-[#edf1f5] bg-white px-4 py-3 text-left transition hover:border-[#cdd9e8] hover:bg-[#fdfefe]"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-semibold text-[#344256]">{result.name}</div>
                          <div className="mt-1 truncate font-mono text-[11px] text-[#94a0b2]">{result.path}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <RiskChip category={result.category} />
                          <span className="text-[12px] font-semibold text-[#2f76e9]">查看详情</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 flex items-center justify-between gap-4">
                <span className="text-sm text-[#7f8a98]">
                  {isRepositoryScan
                    ? agentReviewCount > 0
                      ? "建议根据报告优先修复命中的高危文件，再结合活动监控追查运行时行为。"
                      : "当前未发现明显的仓库级执行风险，你仍可进入活动监控查看完整事件流。"
                    : agentReviewCount > 0
                      ? "建议打开活动监控，查看最近一次扫描中捕获到的执行与调用行为。"
                      : "当前未发现明显的 Agent 执行异常，你仍可进入活动监控查看完整事件流。"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (isRepositoryScan && focusSkill) {
                      onOpenDetail(focusSkill.path);
                      return;
                    }
                    onOpenActivity();
                  }}
                  className="rounded-xl border border-[#dbe3ee] bg-white px-4 py-2 text-sm font-semibold text-[#516072] transition hover:border-[#c8d5e4] hover:text-[#2f76e9]"
                >
                  {isRepositoryScan && focusSkill ? "查看详情页" : "打开活动监控"}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </section>
      </main>
    </>
  );
}
