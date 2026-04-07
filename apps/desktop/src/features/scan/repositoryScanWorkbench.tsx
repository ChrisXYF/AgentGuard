import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { CheckState } from "../../shared/appTypes";
import { RiskChip } from "../skills/skillsUi";
import {
  AlertRingIcon,
  DRAG_REGION_STYLE,
  IdeaScanIcon,
  NO_DRAG_REGION_STYLE,
  PulseBoltIcon,
  SpinnerIcon,
  SuccessIcon,
  ToolScanIcon,
  WaitingDotIcon,
  WINDOW_DRAG_BLOCK_SELECTOR,
  WarningIcon,
  buildRepositoryScanPreviewFiles,
  isTauriRuntime,
} from "../../shared/shared";
import type { ComponentReport, Finding, RepositoryScanJobStatus, SkillReport } from "../../types";

type RepositoryWorkbenchCheck = {
  label: string;
  state: CheckState;
  detail: string;
};

type RepositoryScanWorkbenchProps = {
  agentChecks: RepositoryWorkbenchCheck[];
  agentFindings: number;
  agentResults: ComponentReport[];
  errorMessage: string | null;
  findingsCount: number;
  focusSkill: SkillReport | null;
  headline: string;
  loading: boolean;
  mcpChecks: RepositoryWorkbenchCheck[];
  mcpFindings: number;
  mcpResults: ComponentReport[];
  onBack: () => void;
  onOpenActivity: () => void;
  onOpenDetail: (path: string) => void;
  onOpenResult: () => void;
  onQuickFix: () => void;
  onScan: () => Promise<void>;
  pickingDirectory: boolean;
  progress: number;
  results: SkillReport[];
  scannedAgents: number;
  scannedComponents: number;
  scannedMcps: number;
  scannedRoots: string[];
  sessionTitle: string;
  skillChecks: RepositoryWorkbenchCheck[];
  skillFindings: number;
  repositoryScanCurrentFile: string;
  repositoryScanJob: RepositoryScanJobStatus | null;
  repositoryScanDisplayProgress: number;
  repositoryScanLoading: boolean;
  repositoryScanRevealPending: boolean;
  repositoryScanTargetPath: string | null;
  standaloneRepositoryWindow: boolean;
  waitingForRepositorySelection: boolean;
};

type RepositoryFindingEntry = {
  kind: "file" | "mcp" | "agent";
  owner: string;
  ownerPath: string;
  path: string;
  finding: Finding;
};

type RepositoryLaneTone = "blue" | "amber" | "red";

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

/* ─────────────────────── Main Result View ─────────────────────── */

export function RepositoryScanWorkbench({
  agentChecks,
  agentFindings,
  agentResults,
  errorMessage,
  findingsCount,
  focusSkill,
  headline,
  loading,
  mcpChecks,
  mcpFindings,
  mcpResults,
  onBack,
  onOpenActivity,
  onOpenDetail,
  onOpenResult,
  onQuickFix,
  onScan,
  pickingDirectory,
  progress,
  results,
  scannedAgents,
  scannedComponents,
  scannedMcps,
  scannedRoots,
  sessionTitle,
  skillChecks,
  skillFindings,
  repositoryScanCurrentFile,
  repositoryScanJob,
  repositoryScanDisplayProgress,
  repositoryScanLoading,
  repositoryScanRevealPending,
  repositoryScanTargetPath,
  standaloneRepositoryWindow,
  waitingForRepositorySelection,
}: RepositoryScanWorkbenchProps) {
  /* ── Loading / picker gate ── */
  if (repositoryScanLoading || waitingForRepositorySelection || repositoryScanRevealPending) {
    return (
      <RepositoryScanLoadingScreen
        currentFile={repositoryScanCurrentFile}
        findingsCount={repositoryScanJob?.findingsCount ?? 0}
        highestSeverity={repositoryScanJob?.highestSeverity ?? 0}
        loading={loading}
        onClose={onBack}
        onOpenResult={onOpenResult}
        progress={repositoryScanDisplayProgress}
        repositoryScanJob={repositoryScanJob}
        resultPending={repositoryScanRevealPending}
        targetPath={repositoryScanTargetPath}
      />
    );
  }

  /* ── Derived data ── */
  const repositoryPath = scannedRoots[0] ?? null;
  const repositoryName = repositoryPath?.split("/").filter(Boolean).pop() ?? "未选择仓库";
  const highRiskFiles = results
    .slice()
    .sort((left, right) => right.risk_score - left.risk_score)
    .slice(0, 6);
  const allFindings = buildRepositoryFindings(results, mcpResults, agentResults).slice(0, 8);
  const completedChecks = [...skillChecks, ...mcpChecks, ...agentChecks].filter((item) => item.state === "done").length;
  const issueChecks = [...skillChecks, ...mcpChecks, ...agentChecks].filter((item) => item.state === "issue").length;
  const hasAnyResult =
    scannedComponents > 0 || findingsCount > 0 || results.length > 0 || mcpResults.length > 0 || agentResults.length > 0;
  const showErrorState = Boolean(errorMessage) && !loading && !hasAnyResult;
  const leadSeverity = allFindings[0]?.finding.severity ?? 0;
  const activeDomains = [
    skillFindings > 0 ? "skill" : null,
    mcpFindings > 0 ? "mcp" : null,
    agentFindings > 0 ? "agent" : null,
  ].filter(Boolean).length;
  const statusAppearance = getStatusAppearance({ errorMessage, findingsCount, loading, pickingDirectory });

  const laneCards = [
    {
      key: "skills",
      title: "代码风险",
      subtitle: "下载、联网、敏感访问",
      count: skillFindings,
      icon: <IdeaScanIcon />,
      tone: "blue" as const,
      checks: skillChecks,
    },
    {
      key: "mcp",
      title: "MCP 暴露面",
      subtitle: "端点、工具、外部接口",
      count: mcpFindings,
      icon: <PulseBoltIcon />,
      tone: "amber" as const,
      checks: mcpChecks,
    },
    {
      key: "agent",
      title: "执行路径",
      subtitle: "命令链、数据流、出站",
      count: agentFindings,
      icon: <AlertRingIcon />,
      tone: "red" as const,
      checks: agentChecks,
    },
  ];

  const stats = [
    { label: "审计文件", value: String(scannedComponents) },
    { label: "风险命中", value: String(findingsCount) },
    { label: "执行路径", value: String(scannedAgents) },
    { label: "MCP 配置", value: String(scannedMcps) },
    { label: "完成检查", value: String(completedChecks) },
    { label: "进度", value: pickingDirectory ? "..." : `${progress}%` },
  ];
  const summaryDescription = showErrorState
    ? "本次仓库审计没有成功生成可用结果。你可以先确认目录仍然可读，再结合错误详情决定是否重新扫描。"
    : findingsCount > 0
      ? `已覆盖 ${scannedComponents} 个文件与配置对象，识别出 ${findingsCount} 条风险命中。当前结果区已压缩为可点击的发现列表，方便逐条进入详情复核。`
      : `本次仓库审计覆盖了 ${scannedComponents} 个文件与配置对象，没有发现高优先级命中。仍保留检查矩阵和辅助信号，方便继续抽查。`;
  const guidanceSteps = showErrorState
    ? [
        "先确认目标目录仍然存在且当前进程有读取权限。",
        "重新执行仓库扫描，确认是否能稳定复现同一错误。",
        "如果仍然失败，再去看 Tauri 日志或 Rust 侧 repository audit 抛错。",
      ]
    : findingsCount > 0
      ? [
          "先处理可直接执行命令、联网或敏感读取的命中项。",
          "进入详情页逐条复核片段，区分真实风险、业务需求和误报。",
          "如果涉及调用链或外部访问，继续打开活动监控追查运行态。",
        ]
      : [
          "当前没有高危命中，可以先从检查矩阵确认覆盖面。",
          "抽查高优先级文件列表，确认关键配置和入口文件没有遗漏。",
          "需要运行态验证时，再进入活动监控继续追查。",
        ];
  const inspectorMetrics = [
    { label: "最高严重度", value: leadSeverity || "--" },
    { label: "待复核域", value: issueChecks },
    { label: "活跃风险域", value: activeDomains },
    { label: "高危文件", value: highRiskFiles.length },
  ];
  const leadingFinding = allFindings[0] ?? null;

  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-white text-[#243042]"
      style={{ fontFamily: DESKTOP_FONT }}
    >
      {/* ── Toolbar ── */}
      <WorkbenchToolbar
        actions={
          <>
            <ToolbarButton onClick={onBack}>
              {standaloneRepositoryWindow ? "关闭窗口" : "返回"}
            </ToolbarButton>
            <ToolbarButton primary onClick={() => void onScan()} disabled={loading}>
              {loading ? "扫描中..." : "重新扫描"}
            </ToolbarButton>
          </>
        }
        badges={
          <>
            <StatusPill className={statusAppearance.pillClass}>
              <span className={`h-2 w-2 rounded-full ${statusAppearance.dotClass}`} />
              {statusAppearance.label}
            </StatusPill>
            {(loading || pickingDirectory) ? (
              <StatusPill className="border-[#d8e5fb] bg-[#eef5ff] text-[#2f76e9]">
                <SpinnerIcon />
                {pickingDirectory ? "目录选择中" : "仓库审计中"}
              </StatusPill>
            ) : null}
          </>
        }
      />

      {/* ── Stat Bar ── */}
      <section className="shrink-0 border-b border-[#eef1f4] bg-[#f8fafc] px-5 py-2">
        <div className="flex items-center gap-1">
          <div className="mr-2 min-w-0 truncate text-[12px] text-[#8ea0b6]">
            {repositoryName}
            {repositoryPath ? (
              <span className="ml-2 font-mono text-[11px] text-[#a8b8cc]">{repositoryPath}</span>
            ) : null}
          </div>
          <div className="ml-auto flex items-center">
            {stats.map((item, index) => (
              <span key={item.label} className="flex items-center">
                {index > 0 ? <span className="mx-2.5 h-3 w-px bg-[#e0e6ed]" /> : null}
                <span className="text-[12px] text-[#8ea0b6]">
                  {item.label}
                  <span className="ml-1 font-semibold text-[#516072]">{item.value}</span>
                </span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Progress Bar (thin, only when active) ── */}
      {(loading || pickingDirectory) ? (
        <div className="h-0.5 shrink-0 bg-[#eef1f4]">
          <div
            className="h-full bg-[#2f76e9] transition-all duration-300"
            style={{ width: `${Math.max(pickingDirectory ? 6 : progress, 4)}%` }}
          />
        </div>
      ) : null}

      {/* ── Body: dual-column ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[#edf1f5]">
        {/* Left column */}
        <div className="hover-scrollbar min-h-0 min-w-0 flex-[1.7] overflow-y-auto p-3">
          <div className="space-y-3">
            <Panel className="bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)]">
              <div className="px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill className="border-[#dbe3ee] bg-[#f8fafc] text-[#516072]">
                    {repositoryName}
                  </StatusPill>
                  {sessionTitle && sessionTitle !== repositoryName ? (
                    <StatusPill className="border-[#dbe3ee] bg-white text-[#7b8ca1]">
                      {sessionTitle}
                    </StatusPill>
                  ) : null}
                  {leadingFinding ? (
                    <StatusPill className="border-[#dbe3ee] bg-white text-[#7b8ca1]">
                      焦点 {leadingFinding.finding.rule_id}
                    </StatusPill>
                  ) : null}
                </div>
                <h2 className="mt-3 text-[20px] font-semibold tracking-[-0.03em] text-[#1d2736]">{headline}</h2>
                <p className="mt-2 max-w-[920px] text-[13px] leading-6 text-[#667085]">{summaryDescription}</p>
                <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {inspectorMetrics.map((item) => (
                    <MiniStat key={item.label} label={item.label} value={item.value} />
                  ))}
                </div>
              </div>
            </Panel>

            {showErrorState ? (
              /* ── Error State ── */
              <Panel>
                <PanelHeader title="扫描失败" badge="Needs Retry" badgeClassName="border-[#fde7c2] bg-[#fff7ea] text-[#a76500]" />
                <div className="space-y-3 p-4">
                  <div className="rounded-lg border border-[#fde7c2] bg-[#fffbf2] px-4 py-3">
                    <div className="text-[13px] font-semibold text-[#8a4316]">错误原因</div>
                    <div className="mt-1 text-[12px] leading-6 text-[#9a5a32]">{errorMessage}</div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-[#e4e9f0] bg-white px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8ea0b6]">扫描目标</div>
                      <div className="mt-1 break-all font-mono text-[12px] text-[#516072]">
                        {repositoryPath ?? "未获取到目录"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#e4e9f0] bg-white px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8ea0b6]">建议处理</div>
                      <div className="mt-1 text-[12px] leading-6 text-[#667085]">
                        先确认目录仍然存在、仓库可读，再重新扫描。如果是后端 job 报错，优先看 Tauri 日志或 Rust 侧 repository audit 抛错。
                      </div>
                    </div>
                  </div>
                </div>
              </Panel>
            ) : (
              <>
                {/* ── Key Findings ── */}
                <Panel>
                  <PanelHeader title="关键发现队列" badge="Top 8" />

                  {allFindings.length === 0 ? (
                    <EmptyHint text="当前没有需要展示的关键发现。" />
                  ) : (
                    <div className="px-3 pb-3">
                      <div className="grid grid-cols-[110px_110px_minmax(0,1.4fr)_minmax(0,1.2fr)_88px] gap-3 border-b border-[#eef1f4] px-1 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8ea0b6]">
                        <div>风险级别</div>
                        <div>类型</div>
                        <div>发现项</div>
                        <div>文件</div>
                        <div className="text-right">操作</div>
                      </div>
                      <div className="divide-y divide-[#eef1f4]">
                      {allFindings.map((item, index) => {
                        const sevAppearance = getSeverityAppearance(item.finding.severity);
                        const kindAppearance = getFindingKindAppearance(item.kind);

                        return (
                          <button
                            key={`${item.path}-${item.finding.rule_id}-${index}`}
                            type="button"
                            onClick={() => onOpenDetail(item.ownerPath)}
                            className="grid w-full grid-cols-[110px_110px_minmax(0,1.4fr)_minmax(0,1.2fr)_88px] items-center gap-3 px-1 py-3 text-left transition hover:bg-[#f8fbff]"
                          >
                            <div className="flex flex-col gap-1">
                              <MicroBadge className={sevAppearance.badgeClass}>{sevAppearance.label}</MicroBadge>
                            </div>
                            <div className="flex flex-col gap-1">
                              <MicroBadge className={kindAppearance.badgeClass}>{kindAppearance.label}</MicroBadge>
                              <span className="text-[11px] text-[#8ea0b6]">L{item.finding.line}</span>
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-semibold text-[#1d2736]">{item.finding.title}</div>
                              <div className="mt-0.5 truncate text-[11px] text-[#8ea0b6]">
                                {item.finding.rule_id} · 来源 {item.owner}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-mono text-[11px] text-[#516072]">{item.path}</div>
                              <div className="mt-0.5 truncate text-[11px] text-[#8ea0b6]">{item.finding.description}</div>
                            </div>
                            <div className="text-right">
                              <span className="inline-flex rounded-full border border-[#d8e5fb] bg-[#eef5ff] px-3 py-1 text-[11px] font-semibold text-[#2f76e9]">
                                查看详情
                              </span>
                            </div>
                          </button>
                        );
                      })}
                      </div>
                    </div>
                  )}
                </Panel>

                {/* ── High-risk Files ── */}
                <Panel>
                  <PanelHeader
                    title="高危文件列表"
                    badge={`${highRiskFiles.length} Files`}
                    action={
                      focusSkill ? (
                        <SmallButton onClick={() => onOpenDetail(focusSkill.path)}>
                          查看详情
                        </SmallButton>
                      ) : null
                    }
                  />

                  <div className="px-3 pb-2">
                    <div className="grid grid-cols-[minmax(0,1fr)_92px_72px_80px] gap-3 border-b border-[#eef1f4] px-1 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8ea0b6]">
                      <div>文件</div>
                      <div>风险</div>
                      <div>发现</div>
                      <div className="text-right">操作</div>
                    </div>

                    {highRiskFiles.length === 0 ? (
                      <div className="px-4 py-8 text-center text-[13px] text-[#a0acbd]">当前没有需要展示的命中文件。</div>
                    ) : (
                      <div className="divide-y divide-[#eef1f4]">
                        {highRiskFiles.map((file) => (
                          <div
                            key={file.path}
                            className="grid grid-cols-[minmax(0,1fr)_92px_72px_80px] items-center gap-3 px-1 py-3"
                          >
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-semibold text-[#304054]">{file.name}</div>
                              <div className="mt-0.5 truncate font-mono text-[11px] text-[#a0acbd]">{file.path}</div>
                            </div>
                            <div>
                              <RiskChip category={file.category} />
                            </div>
                            <div className="text-[12px] font-medium text-[#667085]">
                              {file.files.reduce((sum, item) => sum + item.findings.length, 0)} 条
                            </div>
                            <div className="text-right">
                              <SmallButton onClick={() => onOpenDetail(file.path)}>
                                详情
                              </SmallButton>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </Panel>
              </>
            )}
          </div>
        </div>

        {/* ── Right column ── */}
        <aside className="hover-scrollbar min-h-0 w-[320px] shrink-0 overflow-y-auto border-l border-[#dfe6ee] bg-[#f7f9fc] p-3">
          <div className="space-y-3">
            {/* Actions */}
            <Panel>
              <PanelHeader title="审计操作" />
              <div className="space-y-2 p-3">
                <ActionRow
                  disabled={loading}
                  icon={<ToolScanIcon />}
                  onClick={() => void onScan()}
                  title="重新执行仓库扫描"
                  detail="重新读取目录并刷新全部结果面板。"
                />
                <ActionRow
                  disabled={loading || findingsCount === 0}
                  icon={
                    <span className="rounded-md border border-[#d8e0ea] bg-[#f0f4f9] px-2 py-0.5 text-[10px] font-semibold text-[#667085]">
                      Preview
                    </span>
                  }
                  onClick={onQuickFix}
                  title="一键修复"
                  detail="后续会接自动修复流程，现在先保留统一入口。"
                />
                <ActionRow
                  icon={<span className="text-[11px] font-semibold text-[#2f76e9]">Runtime</span>}
                  onClick={onOpenActivity}
                  title="打开活动监控"
                  detail="继续追查运行时行为、调用链和外部访问。"
                />
              </div>
            </Panel>

            {/* Overview */}
            <Panel>
              <PanelHeader title="审计概览" />
              <div className="space-y-3 p-3">
                <div className="rounded-[16px] border border-[#e4e9f0] bg-white px-3 py-3">
                  <div className="text-[13px] font-semibold text-[#304054]">{repositoryName}</div>
                  <div className="mt-1 break-all font-mono text-[11px] leading-5 text-[#8ea0b6]">
                    {repositoryPath ?? "等待选择项目目录"}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <MiniStat label="最高严重度" value={leadSeverity || "--"} />
                  <MiniStat label="待复核域" value={issueChecks} />
                  <MiniStat label="活跃风险域" value={activeDomains} />
                </div>
                <div className="space-y-2">
                  {guidanceSteps.map((item, index) => (
                    <GuidanceStep key={`aside-${item}`} index={index + 1} text={item} compact />
                  ))}
                </div>
              </div>
            </Panel>

            {/* Audit Matrix */}
            <Panel>
              <PanelHeader title="检查矩阵" badge={`${laneCards.length} Domains`} />
              <div className="space-y-2 p-3">
                {laneCards.map((lane) => (
                  <LaneCard key={lane.key} lane={lane} />
                ))}
              </div>
            </Panel>

            {/* MCP signals */}
            <SignalList
              emptyText="当前仓库中没有检测到需要重点展示的 MCP 配置项。"
              title="MCP 命中"
              items={mcpResults}
            />

            {/* Agent paths */}
            <SignalList
              emptyText="当前仓库中没有需要重点展示的执行路径命中。"
              title="执行路径"
              items={agentResults}
            />
          </div>
        </aside>
      </div>
    </main>
  );
}

/* ─────────────────────── Shared Sub-components ─────────────────────── */

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`overflow-hidden rounded-[18px] border border-[#dfe6ee] bg-white ${className}`}>
      {children}
    </section>
  );
}

function PanelHeader({
  action,
  badge,
  badgeClassName,
  title,
}: {
  action?: ReactNode;
  badge?: string;
  badgeClassName?: string;
  title: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#edf1f5] bg-white px-4 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7d8c9f]">{title}</div>
      <div className="flex shrink-0 items-center gap-2">
        {action}
        {badge ? (
          <span
            className={`rounded-md border border-[#d9e2ee] bg-[#f8fafc] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#8ea0b6] ${badgeClassName ?? ""}`}
          >
            {badge}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StatusPill({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold ${className}`}
    >
      {children}
    </span>
  );
}

function WorkbenchToolbar({
  actions,
  badges,
  title = "代码库审计",
}: {
  actions?: ReactNode;
  badges: ReactNode;
  title?: string;
}) {
  return (
    <header
      data-tauri-drag-region
      onMouseDown={startWindowDrag}
      className="relative z-10 shrink-0 border-b border-[#eef1f4] bg-white pl-20 pr-5"
      style={DRAG_REGION_STYLE}
    >
      <div className="flex h-16 items-center gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[#243042]">
              {title}
            </h1>
          </div>
          <div className="h-6 w-px shrink-0 bg-[#e6ebf2]" />
          <div className="flex min-w-0 items-center gap-2">{badges}</div>
        </div>

        <div className="min-h-[40px] flex-1" />

        {actions ? (
          <div
            className="flex shrink-0 items-center gap-2"
            data-window-drag-disabled="true"
            style={NO_DRAG_REGION_STYLE}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}

function MicroBadge({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${className}`}>
      {children}
    </span>
  );
}

function ToolbarButton({
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
      className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-60 ${
        primary
          ? "border-[#2f76e9] bg-[#2f76e9] text-white hover:bg-[#265fc5]"
          : "border-[#d8e0ea] bg-white text-[#516072] hover:border-[#c8d5e4] hover:text-[#2f76e9]"
      }`}
    >
      {children}
    </button>
  );
}

function SmallButton({
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
      className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-60 ${
        primary
          ? "border-[#2f76e9] bg-[#2f76e9] text-white hover:bg-[#265fc5]"
          : "border-[#d8e0ea] bg-white text-[#516072] hover:border-[#c8d5e4] hover:text-[#2f76e9]"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="px-4 py-8 text-center text-[13px] text-[#a0acbd]">{text}</div>
  );
}

function GuidanceStep({
  compact = false,
  index,
  text,
}: {
  compact?: boolean;
  index: number;
  text: string;
}) {
  return (
    <div className={`flex items-start gap-2.5 rounded-[14px] border border-[#e4e9f0] bg-white ${compact ? "px-3 py-2.5" : "px-3 py-3"}`}>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#eef4ff] text-[10px] font-semibold text-[#2f76e9]">
        {index}
      </span>
      <div className={`text-[#667085] ${compact ? "text-[11px] leading-5" : "text-[12px] leading-5"}`}>{text}</div>
    </div>
  );
}

function ActionRow({
  disabled = false,
  detail,
  icon,
  onClick,
  title,
}: {
  disabled?: boolean;
  detail: string;
  icon: ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-between gap-3 rounded-[16px] border border-[#e4e9f0] bg-white px-3 py-2.5 text-left transition hover:border-[#c8d5e4] hover:bg-[#fbfcfe] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-[#243042]">{title}</div>
        <div className="mt-0.5 text-[11px] text-[#8ea0b6]">{detail}</div>
      </div>
      <span className="shrink-0 text-[#2f76e9]">{icon}</span>
    </button>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[14px] border border-[#e4e9f0] bg-[#f8fafc] px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a0acbd]">{label}</div>
      <div className="mt-1 text-[18px] font-semibold tracking-tight text-[#243042]">{value}</div>
    </div>
  );
}

function LaneCard({
  lane,
}: {
  lane: {
    title: string;
    subtitle: string;
    count: number;
    icon: ReactNode;
    tone: RepositoryLaneTone;
    checks: RepositoryWorkbenchCheck[];
  };
}) {
  const toneAppearance = getLaneToneAppearance(lane.tone);

  return (
    <div className={`rounded-[16px] border ${toneAppearance.cardClass} px-3 py-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[12px] ${toneAppearance.iconBgClass}`}>
            {lane.icon}
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[#243042]">{lane.title}</div>
            <div className="text-[11px] text-[#8ea0b6]">{lane.subtitle}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[18px] font-semibold tracking-tight text-[#243042]">{lane.count}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[#a0acbd]">hits</div>
        </div>
      </div>

      {lane.checks.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {lane.checks.map((item) => {
            const checkAppearance = getCheckStateAppearance(item.state);
            return (
              <div
                key={item.label}
                className="flex items-center justify-between gap-2 rounded-[12px] border border-[#e8edf4] bg-white px-2.5 py-1.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className={checkAppearance.iconClass}>{checkAppearance.icon}</span>
                  <span className="truncate text-[12px] text-[#516072]">{item.label}</span>
                </div>
                <span className={`shrink-0 text-[11px] font-semibold ${checkAppearance.textClass}`}>{item.detail}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SignalList({
  emptyText,
  items,
  title,
}: {
  emptyText: string;
  items: ComponentReport[];
  title: string;
}) {
  return (
    <Panel>
      <PanelHeader title={title} />
      <div className="space-y-2 p-3">
        {items.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-[#d9e2ec] bg-[#f8fafc] px-3 py-5 text-center text-[12px] text-[#a0acbd]">
            {emptyText}
          </div>
        ) : (
          items.slice(0, 3).map((item) => (
            <div key={item.path} className="rounded-[14px] border border-[#e4e9f0] bg-white px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-[#304054]">{item.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-[#a0acbd]">{item.path}</div>
                </div>
                <RiskChip category={item.category} />
              </div>
              <div className="mt-2 text-[11px] leading-5 text-[#667085]">
                {item.flags[0] ?? "命中规则，建议进入完整报告继续复核。"}
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

/* ─────────────────────── Data Builders ─────────────────────── */

function buildRepositoryFindings(
  results: SkillReport[],
  mcpResults: ComponentReport[],
  agentResults: ComponentReport[],
) {
  return [
    ...results.flatMap((report) =>
      report.files.flatMap((file) =>
        file.findings.map((finding) => ({
          kind: "file" as const,
          owner: report.name,
          ownerPath: report.path,
          path: file.path,
          finding,
        })),
      ),
    ),
    ...mcpResults.flatMap((report) =>
      report.files.flatMap((file) =>
        file.findings.map((finding) => ({
          kind: "mcp" as const,
          owner: report.name,
          ownerPath: report.path,
          path: file.path,
          finding,
        })),
      ),
    ),
    ...agentResults.flatMap((report) =>
      report.files.flatMap((file) =>
        file.findings.map((finding) => ({
          kind: "agent" as const,
          owner: report.name,
          ownerPath: report.path,
          path: file.path,
          finding,
        })),
      ),
    ),
  ].sort(
    (left, right) =>
      right.finding.severity - left.finding.severity ||
      left.finding.rule_id.localeCompare(right.finding.rule_id) ||
      left.path.localeCompare(right.path),
  ) satisfies RepositoryFindingEntry[];
}

/* ─────────────────────── Appearance Helpers ─────────────────────── */

function getStatusAppearance({
  errorMessage,
  findingsCount,
  loading,
  pickingDirectory,
}: {
  errorMessage: string | null;
  findingsCount: number;
  loading: boolean;
  pickingDirectory: boolean;
}) {
  if (pickingDirectory) {
    return {
      dotClass: "bg-[#60a5fa]",
      label: "等待选择",
      pillClass: "border-[#d8e5fb] bg-[#eef5ff] text-[#2f76e9]",
    };
  }

  if (loading) {
    return {
      dotClass: "bg-[#60a5fa]",
      label: "审计运行中",
      pillClass: "border-[#d8e5fb] bg-[#eef5ff] text-[#2f76e9]",
    };
  }

  if (errorMessage) {
    return {
      dotClass: "bg-[#ef4444]",
      label: "扫描失败",
      pillClass: "border-[#ffc8d2] bg-[#fff1f4] text-[#d93b5c]",
    };
  }

  if (findingsCount > 0) {
    return {
      dotClass: "bg-[#fb923c]",
      label: "需要复核",
      pillClass: "border-[#fde7c2] bg-[#fff7ea] text-[#a76500]",
    };
  }

  return {
    dotClass: "bg-[#22c55e]",
    label: "未发现高危命中",
    pillClass: "border-[#cdeed8] bg-[#eefaf3] text-[#13804b]",
  };
}

function getSeverityAppearance(severity: number) {
  if (severity >= 90) {
    return {
      label: "critical",
      railClass: "bg-[#e35d47]",
      badgeClass: "border-[#ffc8d2] bg-[#fff1f4] text-[#d93b5c]",
    };
  }

  if (severity >= 70) {
    return {
      label: "high",
      railClass: "bg-[#f59e0b]",
      badgeClass: "border-[#fde7c2] bg-[#fff7ea] text-[#a76500]",
    };
  }

  if (severity >= 40) {
    return {
      label: "medium",
      railClass: "bg-[#2f76e9]",
      badgeClass: "border-[#d3e2ff] bg-[#eef5ff] text-[#2f76e9]",
    };
  }

  return {
    label: "low",
    railClass: "bg-[#22a86a]",
    badgeClass: "border-[#cdeed8] bg-[#eefaf3] text-[#13804b]",
  };
}

function getFindingKindAppearance(kind: RepositoryFindingEntry["kind"]) {
  if (kind === "mcp") {
    return {
      label: "mcp",
      badgeClass: "border-[#fde7c2] bg-[#fff7ea] text-[#a76500]",
    };
  }

  if (kind === "agent") {
    return {
      label: "agent",
      badgeClass: "border-[#e4d8fb] bg-[#f5f0ff] text-[#7c3aed]",
    };
  }

  return {
    label: "file",
    badgeClass: "border-[#d3e2ff] bg-[#eef5ff] text-[#2f76e9]",
  };
}

function getLaneToneAppearance(tone: RepositoryLaneTone) {
  if (tone === "amber") {
    return {
      cardClass: "border-[#f0dcc2] bg-[#fffbf5]",
      iconBgClass: "bg-[#fff4e0] text-[#a76500]",
    };
  }

  if (tone === "red") {
    return {
      cardClass: "border-[#f0d0d7] bg-[#fffafb]",
      iconBgClass: "bg-[#ffe8ee] text-[#cf2e5c]",
    };
  }

  return {
    cardClass: "border-[#d5e3fb] bg-[#f9fbff]",
    iconBgClass: "bg-[#e6f0ff] text-[#2f76e9]",
  };
}

function getCheckStateAppearance(state: CheckState) {
  if (state === "done") {
    return {
      icon: <SuccessIcon />,
      iconClass: "text-[#22a86a]",
      textClass: "text-[#13804b]",
    };
  }

  if (state === "issue") {
    return {
      icon: <WarningIcon />,
      iconClass: "text-[#ef476f]",
      textClass: "text-[#cf2e5c]",
    };
  }

  if (state === "working") {
    return {
      icon: <SpinnerIcon />,
      iconClass: "text-[#2f76e9]",
      textClass: "text-[#2f76e9]",
    };
  }

  return {
    icon: <WaitingDotIcon />,
    iconClass: "text-[#a9b4c2]",
    textClass: "text-[#a0acbd]",
  };
}

/* ─────────────────────── Loading Screen ─────────────────────── */

function RepositoryScanLoadingScreen({
  currentFile,
  findingsCount,
  highestSeverity,
  loading,
  onClose,
  onOpenResult,
  progress,
  repositoryScanJob,
  resultPending,
  targetPath,
}: {
  currentFile: string;
  findingsCount: number;
  highestSeverity: number;
  loading: boolean;
  onClose: () => void;
  onOpenResult: () => void;
  progress: number;
  repositoryScanJob: RepositoryScanJobStatus | null;
  resultPending: boolean;
  targetPath: string | null;
}) {
  const liveProgress = repositoryScanJob?.progress ?? progress;
  const clampedProgress = resultPending ? 100 : Math.max(4, Math.min(liveProgress, 99));
  const currentTarget =
    repositoryScanJob?.currentFile || currentFile || targetPath || "正在准备扫描目录";
  const activeFileName = currentTarget.split("/").pop() || currentTarget;
  const scannedFiles = repositoryScanJob?.scannedFiles ?? 0;
  const totalFiles = repositoryScanJob?.totalFiles ?? 0;
  const stageFindings = repositoryScanJob?.stageFindings ?? {};
  const resultPreviewFiles = repositoryScanJob?.response
    ? buildRepositoryScanPreviewFiles(targetPath, repositoryScanJob.response)
    : [];
  const fallbackPreviewFiles = buildRepositoryScanPreviewFiles(targetPath, null);
  const previewFiles = [
    currentTarget,
    ...(resultPreviewFiles.length > 0 ? resultPreviewFiles : fallbackPreviewFiles).filter((item) => item !== currentTarget),
  ].slice(0, 5);
  const previewUsesResultFiles = resultPreviewFiles.length > 0;
  const auditStages = [
    { key: "code_analysis", label: "代码文件分析", detail: "扫描代码文件中的语法与常见安全风险。", activeAt: 6, doneAt: 18 },
    { key: "dependency_review", label: "依赖项检查", detail: "检查依赖包、组件引用和配置文件。", activeAt: 18, doneAt: 30 },
    { key: "mcp_config", label: "MCP 配置扫描", detail: "检测 MCP 端点安全与工具配置策略。", activeAt: 30, doneAt: 42 },
    { key: "agent_flow", label: "Agent 行为链路", detail: "分析 Agent 的执行路径和调用链模式。", activeAt: 42, doneAt: 54 },
    { key: "secret_detection", label: "敏感信息检测", detail: "识别是否存在硬编码的 API Key 或 Token。", activeAt: 54, doneAt: 66 },
    { key: "network_review", label: "网络请求审计", detail: "审计可疑的外部 HTTP 请求和未授权数据外发。", activeAt: 66, doneAt: 78 },
    { key: "shell_execution", label: "Shell 命令扫描", detail: "检测可能导致任意命令执行的高危操作。", activeAt: 78, doneAt: 90 },
    { key: "prompt_injection", label: "Prompt 注入检查", detail: "审计提示词注入与越权绕过风险。", activeAt: 90, doneAt: 100 },
  ];
  const activeStageIndex = loading
    ? auditStages.findIndex((item) => clampedProgress >= item.activeAt && clampedProgress < item.doneAt)
    : auditStages.length - 1;
  const resolvedActiveStageIndex =
    activeStageIndex >= 0 ? activeStageIndex : Math.min(auditStages.length - 1, Math.floor((clampedProgress / 100) * auditStages.length));
  const headerTitle = targetPath ? "代码库扫描" : "等待选择代码库";
  const stateText = !targetPath
    ? "等待选择目录"
    : resultPending
      ? findingsCount > 0
        ? "扫描完成，等待查看结果"
        : "扫描完成，等待查看结果"
      : loading
        ? findingsCount > 0
          ? "扫描中，已检测到风险"
          : "正在进行扫描"
        : "正在整理结果";
  const badgeClass = findingsCount > 0
    ? "border-[#ffd8e0] bg-[#fff1f4] text-[#cf2e5c]"
    : "border-[#d8e5fb] bg-[#eef5ff] text-[#2f76e9]";
  const badgeDotClass = findingsCount > 0 ? "bg-[#ef476f]" : "bg-[#20c083]";
  const fileStatusLabel = resultPending ? "样本" : "当前";
  const trackingPanelTitle = resultPending ? "结果预览" : "实时跟踪";
  const trackingLeadLabel = resultPending
    ? findingsCount > 0
      ? "高风险样本"
      : "结果样本"
    : findingsCount > 0
      ? "已检测到风险"
      : "当前扫描";
  const trackingHint = resultPending
    ? {
        title: "结果已就绪",
        body: previewUsesResultFiles
          ? "本次扫描已结束，以上展示的是已纳入结果的文件样本。点击右上角“查看结果”进入审计列表。"
          : "当前结果已整理完毕，点击右上角“查看结果”进入审计列表。",
      }
    : previewUsesResultFiles
      ? null
      : {
          title: "目录样本",
          body: "右侧文件用于提示扫描范围，不表示真实排队顺序；实时进度以上方文件计数和当前文件为准。",
        };

  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-white text-[#243042]"
      style={{ fontFamily: DESKTOP_FONT }}
    >
      {/* Toolbar */}
      <WorkbenchToolbar
        title={headerTitle}
        actions={
          <>
            <ToolbarButton onClick={onClose}>{targetPath ? "关闭窗口" : "返回"}</ToolbarButton>
            {resultPending ? (
              <ToolbarButton primary onClick={onOpenResult}>
                查看结果
              </ToolbarButton>
            ) : null}
          </>
        }
        badges={
          <StatusPill className={badgeClass}>
            <span className={`h-2 w-2 rounded-full ${badgeDotClass}`} />
            {stateText}
          </StatusPill>
        }
      />

      {/* Stat bar */}
      <section className="shrink-0 border-b border-[#eef1f4] bg-[#f8fafc] px-5 py-2">
        <div className="flex items-center gap-4 text-[12px] text-[#8ea0b6]">
          <span>
            进度 <span className="font-semibold text-[#516072]">{clampedProgress}%</span>
          </span>
          <span className="h-3 w-px bg-[#e0e6ed]" />
          <span>
            阶段 <span className="font-semibold text-[#516072]">{Math.max(1, resolvedActiveStageIndex + 1)}/{auditStages.length}</span>
          </span>
          <span className="h-3 w-px bg-[#e0e6ed]" />
          <span>
            文件{" "}
            <span className="font-semibold text-[#516072]">
              {totalFiles > 0 ? `${Math.min(scannedFiles, totalFiles)}/${totalFiles}` : "--"}
            </span>
          </span>
          <span className="h-3 w-px bg-[#e0e6ed]" />
          <span>
            风险 <span className="font-semibold text-[#516072]">{findingsCount}</span>
          </span>
          <span className="h-3 w-px bg-[#e0e6ed]" />
          <span className="min-w-0 truncate">
            {fileStatusLabel} <span className="font-semibold text-[#516072]">{activeFileName}</span>
          </span>
        </div>
      </section>

      {/* Progress */}
      <div className="h-0.5 shrink-0 bg-[#eef1f4]">
        <div
          className="h-full bg-[#2f76e9] transition-all duration-300"
          style={{ width: `${clampedProgress}%` }}
        />
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[#f6f8fb]">
        {/* Left: stages */}
        <div className="hover-scrollbar min-h-0 min-w-0 flex-[1.2] overflow-y-auto p-4">
          <Panel>
            <PanelHeader title="扫描阶段" badge={resultPending ? "Ready" : loading ? "Live" : "Summary"} />
            <div className="space-y-1.5 p-3">
              {auditStages.map((item, index) => {
                const hitCount = stageFindings[item.key] ?? 0;
                const state: CheckState =
                  hitCount > 0
                    ? "issue"
                    : resultPending
                      ? "done"
                      : clampedProgress >= item.doneAt
                        ? "done"
                        : clampedProgress >= item.activeAt || index === resolvedActiveStageIndex
                          ? "working"
                          : "waiting";
                const stateAppearance = getCheckStateAppearance(state);

                return (
                  <div
                    key={item.key}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${
                      state === "issue"
                        ? "border-[#ffd8e0] bg-[#fff7fa]"
                        : state === "working"
                          ? "border-[#d3e2ff] bg-[#f8fbff]"
                          : "border-[#e4e9f0] bg-white"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                          state === "issue"
                            ? "bg-[#fff1f4] text-[#ef476f]"
                            : state === "done"
                              ? "bg-[#eefaf3] text-[#16a34a]"
                              : state === "working"
                                ? "bg-[#eef5ff] text-[#2f76e9]"
                                : "bg-[#f5f7fb] text-[#a8b4c4]"
                        }`}
                      >
                        {stateAppearance.icon}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-[#243042]">{item.label}</div>
                        <div className="text-[11px] text-[#8ea0b6]">{item.detail}</div>
                      </div>
                    </div>
                    <span className={`shrink-0 text-[11px] font-semibold ${stateAppearance.textClass}`}>
                      {state === "issue"
                        ? `已命中${hitCount > 0 ? ` · ${hitCount}` : ""}`
                        : state === "done"
                          ? "已完成"
                          : state === "working"
                            ? "扫描中"
                            : "等待"}
                    </span>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>

        {/* Right: tracking */}
        <aside className="hover-scrollbar min-h-0 w-[340px] shrink-0 overflow-y-auto border-l border-[#eef1f4] bg-white p-4">
          <div className="space-y-3">
            <Panel>
              <PanelHeader title={trackingPanelTitle} badge={resultPending ? "Ready" : "Live"} />
              <div className="space-y-2 p-3">
                <div
                  className={`rounded-lg px-3 py-2.5 ${
                    findingsCount > 0
                      ? "border border-[#ffd8e0] bg-[#fff7fa]"
                      : "border border-[#d3e2ff] bg-[#f8fbff]"
                  }`}
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#a0acbd]">
                    {trackingLeadLabel}
                  </div>
                  <div className="mt-1 text-[13px] font-semibold text-[#243042]">{activeFileName}</div>
                  <div className="mt-1 break-all font-mono text-[11px] leading-5 text-[#8ea0b6]">{currentTarget}</div>
                  <div className="mt-2 flex items-center gap-4 text-[11px] text-[#8ea0b6]">
                    <span>
                      风险 <span className="font-semibold text-[#516072]">{findingsCount}</span>
                    </span>
                    <span>
                      最高严重度 <span className="font-semibold text-[#516072]">{highestSeverity || "--"}</span>
                    </span>
                  </div>
                </div>

                {previewFiles.map((item, index) => (
                  <div
                    key={`${item}-${index}`}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
                      index === 0 ? "border-[#d3e2ff] bg-[#f8fbff]" : "border-[#e4e9f0] bg-white"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-[#516072]">{item.split("/").pop() || item}</div>
                      <div className="truncate font-mono text-[10px] text-[#a0acbd]">{item}</div>
                    </div>
                    <span
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                        index === 0
                          ? resultPending
                            ? "bg-[#ebf7f1] text-[#13804b]"
                            : "bg-[#eef5ff] text-[#2f76e9]"
                          : previewUsesResultFiles
                            ? "bg-[#eef5ff] text-[#2f76e9]"
                            : "bg-[#f5f7fb] text-[#a0acbd]"
                      }`}
                    >
                      {index === 0
                        ? resultPending
                          ? "结果样本"
                          : "处理中"
                        : previewUsesResultFiles
                          ? resultPending
                            ? "已收录"
                            : "已扫描"
                          : "目录样本"}
                    </span>
                  </div>
                ))}
                {trackingHint ? (
                  <div className="rounded-lg border border-[#d8e5fb] bg-[#f8fbff] px-3 py-3">
                    <div className="text-[12px] font-semibold text-[#243042]">{trackingHint.title}</div>
                    <div className="mt-1 text-[11px] leading-5 text-[#8ea0b6]">
                      {trackingHint.body}
                    </div>
                  </div>
                ) : null}
              </div>
            </Panel>

            <Panel>
              <PanelHeader title="仓库目标" />
              <div className="p-3">
                <div className="rounded-lg border border-[#e4e9f0] bg-[#f8fafc] px-3 py-2.5 break-all font-mono text-[12px] leading-5 text-[#516072]">
                  {targetPath || "未选择代码仓库目录"}
                </div>
              </div>
            </Panel>
          </div>
        </aside>
      </div>
    </main>
  );
}
