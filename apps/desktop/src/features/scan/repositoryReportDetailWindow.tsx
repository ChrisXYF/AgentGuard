import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { RiskChip } from "../skills/skillsUi";
import {
  AlertRingIcon,
  DRAG_REGION_STYLE,
  IdeaScanIcon,
  NO_DRAG_REGION_STYLE,
  PulseBoltIcon,
  WINDOW_DRAG_BLOCK_SELECTOR,
  basename,
  fileType,
  isTauriRuntime,
  openRelatedFile,
} from "../../shared/shared";
import type { ComponentReport, FileReport, Finding, SkillReport } from "../../types";

export type RepositoryReportKind = "skill" | "mcp" | "agent";

export type RepositoryReportWindowPayload = {
  kind: RepositoryReportKind;
  report: SkillReport | ComponentReport;
  repositoryPath: string | null;
};

type RepositoryReportDetailScreenProps = {
  fallbackTitle?: string | null;
  onBack: () => void;
  payload: RepositoryReportWindowPayload | null;
};

const DESKTOP_FONT =
  "\"SF Pro Display\",\"SF Pro Text\",\"PingFang SC\",\"Helvetica Neue\",\"Segoe UI\",sans-serif";

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

function relativeToRoot(path: string, rootPath?: string | null) {
  if (!rootPath) {
    return path;
  }

  const normalizedRoot = rootPath.replace(/\/+$/, "");
  if (path === normalizedRoot) {
    return basename(path);
  }

  if (!path.startsWith(`${normalizedRoot}/`)) {
    return path;
  }

  return path.slice(normalizedRoot.length + 1);
}

function getRepositoryReportKindMeta(kind: RepositoryReportKind) {
  switch (kind) {
    case "mcp":
      return {
        detail: "MCP 暴露面",
        icon: <PulseBoltIcon />,
        label: "MCP 报告",
        pillClass: "border-[#ffe1b7] bg-[#fff4e5] text-[#b96a00]",
        panelClass: "bg-[radial-gradient(circle_at_top,#fff6ea,transparent_58%),linear-gradient(180deg,#ffffff_0%,#fbfcff_100%)]",
      };
    case "agent":
      return {
        detail: "执行路径",
        icon: <AlertRingIcon />,
        label: "执行路径报告",
        pillClass: "border-[#ffd8df] bg-[#fff1f4] text-[#cf2e5c]",
        panelClass: "bg-[radial-gradient(circle_at_top,#fff0f5,transparent_58%),linear-gradient(180deg,#ffffff_0%,#fbfcff_100%)]",
      };
    case "skill":
    default:
      return {
        detail: "代码风险",
        icon: <IdeaScanIcon />,
        label: "文件报告",
        pillClass: "border-[#d8e5fb] bg-[#eef5ff] text-[#2f76e9]",
        panelClass: "bg-[radial-gradient(circle_at_top,#eef6ff,transparent_58%),linear-gradient(180deg,#ffffff_0%,#fbfcff_100%)]",
      };
  }
}

function getSeverityMeta(severity: number) {
  if (severity >= 85) {
    return {
      badgeClass: "border-[#ffd7db] bg-[#fff1f4] text-[#cf2e5c]",
      label: "Critical",
      railClass: "bg-[#ef476f]",
      textClass: "text-[#cf2e5c]",
    };
  }

  if (severity >= 60) {
    return {
      badgeClass: "border-[#ffe1b7] bg-[#fff6ea] text-[#c97a00]",
      label: "High",
      railClass: "bg-[#ea7a19]",
      textClass: "text-[#c97a00]",
    };
  }

  if (severity >= 30) {
    return {
      badgeClass: "border-[#dbe8ff] bg-[#eef5ff] text-[#2f76e9]",
      label: "Medium",
      railClass: "bg-[#2f76e9]",
      textClass: "text-[#2f76e9]",
    };
  }

  return {
    badgeClass: "border-[#d9e6df] bg-[#eff8f2] text-[#18824c]",
    label: "Low",
    railClass: "bg-[#20a05a]",
    textClass: "text-[#18824c]",
  };
}

function deriveSummaryText(report: SkillReport | ComponentReport, findingsCount: number, highestSeverity: number, activeFileName: string) {
  if (findingsCount === 0) {
    return "当前报告没有记录到需要处理的风险命中，可以把它当作一次审计快照归档。";
  }

  const reportFlags = report.flags.slice(0, 3);
  const flagText = reportFlags.length > 0 ? `，伴随 ${reportFlags.join(" / ")} 标记` : "";
  return `本报告共命中 ${findingsCount} 条风险线索，最高严重度 ${highestSeverity}，主要集中在 ${activeFileName}${flagText}。建议先复核片段，再决定是否收敛权限、替换敏感内容或补充显式授权。`;
}

function buildFindingRows(files: FileReport[]) {
  return files
    .flatMap((file) =>
      file.findings.map((finding) => ({
        ...finding,
        filePath: file.path,
      })),
    )
    .sort(
      (left, right) =>
        right.severity - left.severity ||
        left.filePath.localeCompare(right.filePath) ||
        left.line - right.line,
    );
}

function formatFindingsCount(value: number) {
  return `${value} ${value === 1 ? "finding" : "findings"}`;
}

function compactSnippet(snippet?: string | null) {
  if (!snippet) {
    return null;
  }

  const firstLine = snippet
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return null;
  }

  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}

function ActionButton({
  children,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition ${
        primary
          ? "border-[#2f76e9] bg-[#2f76e9] text-white hover:bg-[#245fc1]"
          : "border-[#d8e0ea] bg-white text-[#516072] hover:border-[#c8d5e4] hover:text-[#2f76e9]"
      }`}
    >
      {children}
    </button>
  );
}

function WindowPill({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold ${className}`}>
      {children}
    </span>
  );
}

function SurfaceCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`overflow-hidden rounded-[20px] border border-[#dfe6ee] bg-white ${className}`}>{children}</section>;
}

function SurfaceHeader({
  action,
  badge,
  title,
}: {
  action?: ReactNode;
  badge?: ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#edf1f5] bg-white px-4 py-3">
      <div className="text-[13px] font-semibold text-[#243042]">{title}</div>
      <div className="flex items-center gap-2">{badge}{action}</div>
    </div>
  );
}

function InspectorStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#e3e9f0] bg-white px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">{label}</div>
      <div className="mt-2 text-[20px] font-semibold tracking-[-0.03em] text-[#243042]">{value}</div>
    </div>
  );
}

export function RepositoryReportDetailScreen({
  fallbackTitle,
  onBack,
  payload,
}: RepositoryReportDetailScreenProps) {
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  useEffect(() => {
    if (!payload) {
      setActiveFilePath(null);
      return;
    }

    const defaultFile = payload.report.files
      .slice()
      .sort(
        (left, right) =>
          right.findings.length - left.findings.length ||
          right.risk_score - left.risk_score ||
          left.path.localeCompare(right.path),
      )[0];
    setActiveFilePath(defaultFile?.path ?? payload.report.files[0]?.path ?? null);
  }, [payload]);

  if (!payload) {
    return (
      <main
        className="relative flex h-screen min-h-0 flex-col items-center justify-center overflow-hidden bg-[#eef2f6] text-[#243042]"
        style={{ fontFamily: DESKTOP_FONT }}
      >
        <div className="rounded-[24px] border border-[#d9e1eb] bg-white px-8 py-7 text-center shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
          <div className="text-[20px] font-semibold text-[#243042]">{fallbackTitle ?? "审计详情不可用"}</div>
          <div className="mt-2 max-w-[420px] text-[14px] leading-7 text-[#7d8c9f]">
            这份仓库审计详情没有恢复成功。请回到代码库扫描窗口，重新点击一次“查看详情”。
          </div>
          <div className="mt-5 flex justify-center">
            <ActionButton onClick={onBack}>返回结果</ActionButton>
          </div>
        </div>
      </main>
    );
  }

  const { kind, report, repositoryPath } = payload;
  const kindMeta = getRepositoryReportKindMeta(kind);
  const files = report.files
    .slice()
    .sort(
      (left, right) =>
        right.findings.length - left.findings.length ||
        right.risk_score - left.risk_score ||
        left.path.localeCompare(right.path),
    );
  const selectedFile = files.find((item) => item.path === activeFilePath) ?? files[0] ?? null;
  const findings = buildFindingRows(selectedFile ? [selectedFile] : files);
  const allFindings = buildFindingRows(files);
  const highestSeverity = allFindings[0]?.severity ?? 0;
  const summaryText = deriveSummaryText(report, allFindings.length, highestSeverity, basename(selectedFile?.path ?? report.path));
  const relativePath = relativeToRoot(report.path, repositoryPath);
  const selectedRelativePath = selectedFile ? relativeToRoot(selectedFile.path, repositoryPath) : relativePath;
  const repositoryName = repositoryPath ? basename(repositoryPath) : null;

  return (
    <main
      className="relative flex h-screen min-h-0 flex-col overflow-hidden bg-[#eef2f6] text-[#243042]"
      style={{ fontFamily: DESKTOP_FONT }}
    >
      <header className="relative z-10 shrink-0 border-b border-[#dfe6ee] bg-white pl-20 pr-5">
        <div className="flex h-16 items-center gap-4">
          <div
            data-tauri-drag-region
            onMouseDown={startWindowDrag}
            className="flex min-w-0 items-center gap-4 select-none"
            style={DRAG_REGION_STYLE}
          >
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[#243042]">代码库审计</div>
            </div>
            <div className="h-6 w-px shrink-0 bg-[#e6ebf2]" />
            <div className="flex min-w-0 items-center gap-2">
              <WindowPill className={kindMeta.pillClass}>{kindMeta.label}</WindowPill>
              <WindowPill className="border-[#e3e9f0] bg-[#f6f8fb] text-[#5f7188]">{formatFindingsCount(allFindings.length)}</WindowPill>
            </div>
          </div>

          <div
            data-tauri-drag-region
            onMouseDown={startWindowDrag}
            className="min-h-[40px] flex-1 select-none"
            style={DRAG_REGION_STYLE}
          />

          <div className="flex shrink-0 items-center gap-2" data-window-drag-disabled="true" style={NO_DRAG_REGION_STYLE}>
            <ActionButton onClick={onBack}>返回结果</ActionButton>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0">
          <section className="hover-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
              <SurfaceCard className={kindMeta.panelClass}>
                <div className="grid gap-5 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_220px]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[11px] font-semibold uppercase tracking-[0.12em] ${kindMeta.pillClass}`}>
                        {kindMeta.icon}
                        {kindMeta.detail}
                      </span>
                      <RiskChip category={report.category} />
                      {report.flags.slice(0, 3).map((flag) => (
                        <span
                          key={flag}
                          className="inline-flex h-8 items-center rounded-full border border-[#dfe7f0] bg-white px-3 text-[11px] font-semibold text-[#6b7a90]"
                        >
                          {flag}
                        </span>
                      ))}
                    </div>

                    <h1 className="mt-4 break-words text-[32px] font-semibold tracking-[-0.05em] text-[#1f2c3a]">
                      {report.name}
                    </h1>

                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[#7b8ca1]">
                      <span className="font-mono text-[12px] text-[#5f7188]">{relativePath}</span>
                      <span>{fileType(report.path)}</span>
                      <span>{files.length} 个关联文件</span>
                      {repositoryName ? <span>{repositoryName}</span> : null}
                    </div>

                    <p className="mt-4 max-w-[860px] text-[14px] leading-7 text-[#5f7188]">{summaryText}</p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                    <InspectorStat label="风险评分" value={report.risk_score} />
                    <InspectorStat label="最高严重度" value={highestSeverity || "--"} />
                    <InspectorStat label="当前文件命中" value={selectedFile?.findings.length ?? allFindings.length} />
                  </div>
                </div>
              </SurfaceCard>

              <SurfaceCard>
                <SurfaceHeader
                  title={selectedFile ? `${basename(selectedFile.path)} 命中详情` : "命中详情"}
                  badge={
                    <span className="rounded-full border border-[#dbe3ee] bg-[#f8fafc] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">
                      {findings.length} Findings
                    </span>
                  }
                />

                {findings.length === 0 ? (
                  <div className="px-4 py-10 text-center text-[13px] text-[#8ea0b6]">当前文件没有可展示的风险命中。</div>
                ) : (
                  <div className="divide-y divide-[#edf1f5]">
                    {findings.map((finding, index) => {
                      const severityMeta = getSeverityMeta(finding.severity);
                      const snippet = compactSnippet(finding.snippet);
                      return (
                        <div
                          key={`${finding.rule_id}-${finding.filePath}-${finding.line}-${index}`}
                          className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 px-4 py-3 transition hover:bg-[#fbfcfe]"
                        >
                          <div className={`mt-1 h-2.5 w-2.5 rounded-full ${severityMeta.railClass}`} />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${severityMeta.badgeClass}`}>
                                {severityMeta.label}
                              </span>
                              <span className="rounded-full border border-[#dfe7f0] bg-[#f8fafc] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">
                                {finding.rule_id}
                              </span>
                              <span className="rounded-full border border-[#dfe7f0] bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">
                                Line {finding.line}
                              </span>
                              {files.length > 1 ? (
                                <span className="truncate rounded-full border border-[#dfe7f0] bg-white px-2.5 py-1 text-[10px] font-semibold text-[#8ea0b6]">
                                  {relativeToRoot(finding.filePath, repositoryPath)}
                                </span>
                              ) : null}
                            </div>

                            <div className="mt-2 truncate text-[14px] font-semibold tracking-[-0.01em] text-[#1f2c3a]">
                              {finding.title}
                            </div>
                            <div className="mt-1 truncate text-[12px] text-[#66788d]">{finding.description}</div>

                            {snippet ? (
                              <div className="mt-2 rounded-[12px] bg-[#f6f8fb] px-3 py-2 font-mono text-[11px] text-[#5f7188]">
                                <div className="truncate">{snippet}</div>
                              </div>
                            ) : null}
                          </div>

                          <div className="shrink-0 text-right">
                            <div className={`text-[22px] font-semibold tracking-[-0.04em] ${severityMeta.textClass}`}>
                              {finding.severity}
                            </div>
                            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a0acbd]">
                              severity
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SurfaceCard>
            </div>
          </section>

          <aside className="hover-scrollbar min-h-0 w-[340px] shrink-0 overflow-y-auto border-l border-[#dfe6ee] bg-[#f7f9fc] p-4">
            <div className="space-y-4">
              <SurfaceCard className="bg-[radial-gradient(circle_at_top,#ffffff,transparent_68%),linear-gradient(180deg,#fdfefe_0%,#f7f9fc_100%)]">
                <div className="px-5 py-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">当前焦点</div>
                      <div className="mt-2 text-[20px] font-semibold tracking-[-0.03em] text-[#243042]">
                        {basename(selectedFile?.path ?? report.path)}
                      </div>
                      <div className="mt-1 break-all font-mono text-[11px] leading-6 text-[#7b8ca1]">
                        {selectedRelativePath}
                      </div>
                    </div>
                    <div className="flex h-[88px] w-[88px] shrink-0 items-center justify-center rounded-full border-[8px] border-[#e7edf4] bg-white">
                      <span className="text-[28px] font-semibold tracking-[-0.05em] text-[#ea7a19]">{report.risk_score}</span>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-3 rounded-[16px] border border-[#e3e9f0] bg-white px-4 py-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">审计分数</div>
                      <div className="mt-1 text-[13px] text-[#5f7188]">{kindMeta.detail}</div>
                    </div>
                    <ActionButton onClick={() => void openRelatedFile(selectedFile?.path ?? report.path)}>打开当前文件</ActionButton>
                  </div>
                </div>
              </SurfaceCard>

              <SurfaceCard>
                <SurfaceHeader title="审计概览" />
                <div className="grid gap-3 p-3">
                  <InspectorStat label="报告类型" value={kindMeta.label} />
                  <InspectorStat label="受影响文件" value={files.length} />
                  <InspectorStat label="当前文件命中" value={selectedFile?.findings.length ?? allFindings.length} />
                  <InspectorStat label="风险分类" value={<RiskChip category={report.category} />} />
                </div>
              </SurfaceCard>

              {files.length > 1 ? (
                <SurfaceCard>
                  <SurfaceHeader title="受影响文件清单" />
                  <div className="space-y-2 p-3">
                    {files.map((file) => {
                      const fileSelected = file.path === selectedFile?.path;
                      return (
                        <button
                          key={`inspector-${file.path}`}
                          type="button"
                          onClick={() => setActiveFilePath(file.path)}
                          className={`w-full rounded-[16px] border px-4 py-3 text-left transition ${
                            fileSelected
                              ? "border-[#cfdcf1] bg-[#f4f8ff]"
                              : "border-[#e3e9f0] bg-white hover:border-[#d4dce7] hover:bg-[#fbfcfe]"
                          }`}
                        >
                          <div className="truncate text-[13px] font-semibold text-[#304054]">{basename(file.path)}</div>
                          <div className="mt-1 truncate font-mono text-[11px] text-[#8ea0b6]">
                            {relativeToRoot(file.path, repositoryPath)}
                          </div>
                          <div className="mt-2 flex items-center justify-between text-[11px] text-[#8ea0b6]">
                            <span>{fileType(file.path)}</span>
                            <span className="font-semibold text-[#516072]">{file.findings.length} 条</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </SurfaceCard>
              ) : null}
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
