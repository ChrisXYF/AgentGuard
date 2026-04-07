import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { discoverInventory, discoverLocalMcpServers } from "../../domain/full-scan/client";
import type { InstalledSkillListItem, ManagedSkillDetailAction, SkillsTab } from "../../shared/appTypes";
import { avatarColor, initials } from "./skillsUi";
import {
  CodeCardIcon,
  DRAG_REGION_STYLE,
  DownloadTinyIcon,
  DocCardIcon,
  GlobeCardIcon,
  MarketCardIcon,
  NO_DRAG_REGION_STYLE,
  PrivacyCardIcon,
  SearchTinyIcon,
  WandCardIcon,
  basename,
  buildInstalledSkillList,
  formatRelativeTimestamp,
  isHttpUrl,
  isMarkdownPath,
  isTauriRuntime,
  openExternalUrl,
  openLocalPath,
  openMarkdownPreview,
} from "../../shared/shared";
import type { DiscoveredComponent, DiscoverySnapshot, ManagedSkill, ToolInfo } from "../../types";

export type LocalSkillAnalysisEntryState = {
  error: string | null;
  fingerprint: string | null;
  status: "idle" | "checking" | "ready" | "analyze";
};

const INSTALLED_SKILLS_PAGE_SIZE = 8;
const MCP_COMPONENTS_PAGE_SIZE = 8;

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  const raw = String(error ?? "").trim();
  return raw || "本地资产扫描失败，请检查打包资源和数据库初始化。";
}

function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const startIndex = (currentPage - 1) * pageSize;

  return {
    currentPage,
    pageCount,
    pageItems: items.slice(startIndex, startIndex + pageSize),
    startIndex,
  };
}

export function SkillsScreen({
  analysisRefreshVersion,
  managedLoading,
  managedSkills,
  onOpenManagedSkillDetail,
  onRefreshManaged,
  recursiveScan,
  skillScanPaths,
  mcpScanPaths,
  includedExtensions,
  toolInfos,
}: {
  analysisRefreshVersion: number;
  managedLoading: boolean;
  managedSkills: ManagedSkill[];
  onOpenManagedSkillDetail: (skill: InstalledSkillListItem, action?: ManagedSkillDetailAction) => Promise<void>;
  onRefreshManaged: () => Promise<void>;
  recursiveScan: boolean;
  skillScanPaths: string[];
  mcpScanPaths: string[];
  includedExtensions: string[];
  toolInfos: ToolInfo[];
}) {
  const [skillsTab, setSkillsTab] = useState<SkillsTab>("skills");
  const [installedQuery, setInstalledQuery] = useState("");
  const [installedSkillsPage, setInstalledSkillsPage] = useState(1);
  const [mcpPage, setMcpPage] = useState(1);
  const [selectedInstalledSkillId, setSelectedInstalledSkillId] = useState<string | null>(null);
  const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null);
  const [installedInventory, setInstalledInventory] = useState<DiscoverySnapshot | null>(null);
  const [installedInventoryError, setInstalledInventoryError] = useState<string | null>(null);
  const [installedInventoryLoading, setInstalledInventoryLoading] = useState(false);
  const [mcpInventory, setMcpInventory] = useState<DiscoverySnapshot | null>(null);
  const [mcpInventoryError, setMcpInventoryError] = useState<string | null>(null);
  const [mcpInventoryLoading, setMcpInventoryLoading] = useState(false);
  const [installedSkillAnalysisStates, setInstalledSkillAnalysisStates] = useState<Record<string, LocalSkillAnalysisEntryState>>({});
  const [analysisLookupVersion, setAnalysisLookupVersion] = useState(0);
  const [realtimeSyncing, setRealtimeSyncing] = useState(false);
  const [lastRealtimeSyncAt, setLastRealtimeSyncAt] = useState<number | null>(null);
  const syncInFlightRef = useRef(false);
  const busy = managedLoading || installedInventoryLoading || mcpInventoryLoading || realtimeSyncing;
  const skillScanPathsKey = skillScanPaths.join("\n");
  const mcpScanPathsKey = mcpScanPaths.join("\n");

  const refreshInstalledInventory = async () => {
    if (!isTauriRuntime()) {
      return;
    }

    setInstalledInventoryLoading(true);
    setInstalledInventoryError(null);
    try {
      const snapshot = await discoverInventory(skillScanPaths, {
        recursiveScan,
        includedExtensions,
      });
      setInstalledInventory(snapshot);
    } catch (error) {
      setInstalledInventoryError(toErrorMessage(error));
      throw error;
    } finally {
      setInstalledInventoryLoading(false);
    }
  };

  const refreshMcpInventory = async () => {
    if (!isTauriRuntime()) {
      return;
    }

    setMcpInventoryLoading(true);
    setMcpInventoryError(null);
    try {
      const snapshot = await discoverLocalMcpServers(mcpScanPaths);
      setMcpInventory(snapshot);
    } catch (error) {
      setMcpInventoryError(toErrorMessage(error));
      throw error;
    } finally {
      setMcpInventoryLoading(false);
    }
  };

  const syncRealtimeState = async () => {
    if (!isTauriRuntime() || syncInFlightRef.current) {
      return;
    }

    syncInFlightRef.current = true;
    setRealtimeSyncing(true);
    try {
      await Promise.allSettled([onRefreshManaged(), refreshInstalledInventory(), refreshMcpInventory()]);
      setAnalysisLookupVersion((current) => current + 1);
      setLastRealtimeSyncAt(Date.now());
    } finally {
      syncInFlightRef.current = false;
      setRealtimeSyncing(false);
    }
  };

  useEffect(() => {
    void syncRealtimeState();
  }, [includedExtensions.join(","), recursiveScan, skillScanPathsKey, mcpScanPathsKey]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const timer = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      void syncRealtimeState();
    }, 15000);

    return () => {
      window.clearInterval(timer);
    };
  }, [includedExtensions.join(","), recursiveScan, skillScanPathsKey, mcpScanPathsKey]);

  const installedSkills = useMemo(
    () => buildInstalledSkillList(installedInventory, managedSkills, toolInfos),
    [installedInventory, managedSkills, toolInfos],
  );
  const mcpComponents = useMemo(
    () =>
      (mcpInventory?.components ?? [])
        .filter((component) => component.kind === "mcp_server")
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name)),
    [mcpInventory],
  );
  const filteredInstalledSkills = installedSkills.filter((skill) => {
    const needle = installedQuery.trim().toLowerCase();
    return (
      !needle ||
      skill.name.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle) ||
      (skill.primaryPath ?? "").toLowerCase().includes(needle) ||
      skill.locations.some(
        (location) =>
          location.toolLabel.toLowerCase().includes(needle) || location.path.toLowerCase().includes(needle),
      ) ||
      (skill.managedSkill?.source_ref ?? "").toLowerCase().includes(needle)
    );
  });
  const filteredMcpComponents = mcpComponents.filter((component) => {
    const needle = installedQuery.trim().toLowerCase();
    if (!needle) {
      return true;
    }
    return [
      component.name,
      component.path,
      component.source,
      component.description ?? "",
      JSON.stringify(component.metadata),
      component.relationships.map((relation) => `${relation.relation} ${relation.target_id}`).join(" "),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  const installedSkillsPagination = useMemo(
    () => paginateItems(filteredInstalledSkills, installedSkillsPage, INSTALLED_SKILLS_PAGE_SIZE),
    [filteredInstalledSkills, installedSkillsPage],
  );
  const mcpPagination = useMemo(
    () => paginateItems(filteredMcpComponents, mcpPage, MCP_COMPONENTS_PAGE_SIZE),
    [filteredMcpComponents, mcpPage],
  );
  const pagedInstalledSkills = installedSkillsPagination.pageItems;
  const pagedMcpComponents = mcpPagination.pageItems;

  const selectedInstalledSkill =
    pagedInstalledSkills.find((skill) => skill.id === selectedInstalledSkillId) ?? pagedInstalledSkills[0] ?? null;
  const selectedMcpComponent =
    pagedMcpComponents.find((component) => component.id === selectedMcpId) ?? pagedMcpComponents[0] ?? null;
  const installedSkillsAnalysisKey = installedSkills
    .map((skill) => `${skill.id}:${skill.managedSkill?.central_path ?? skill.primaryPath ?? ""}`)
    .join("\n");

  useEffect(() => {
    const visible = pagedInstalledSkills.some((skill) => skill.id === selectedInstalledSkillId);
    if (visible) {
      return;
    }

    setSelectedInstalledSkillId(pagedInstalledSkills[0]?.id ?? null);
  }, [pagedInstalledSkills, selectedInstalledSkillId]);

  useEffect(() => {
    const visible = pagedMcpComponents.some((component) => component.id === selectedMcpId);
    if (visible) {
      return;
    }

    setSelectedMcpId(pagedMcpComponents[0]?.id ?? null);
  }, [pagedMcpComponents, selectedMcpId]);

  useEffect(() => {
    setInstalledSkillsPage(1);
    setMcpPage(1);
  }, [installedQuery]);

  useEffect(() => {
    if (installedSkillsPage !== installedSkillsPagination.currentPage) {
      setInstalledSkillsPage(installedSkillsPagination.currentPage);
    }
  }, [installedSkillsPage, installedSkillsPagination.currentPage]);

  useEffect(() => {
    if (mcpPage !== mcpPagination.currentPage) {
      setMcpPage(mcpPagination.currentPage);
    }
  }, [mcpPage, mcpPagination.currentPage]);

  useEffect(() => {
    let cancelled = false;

    if (installedSkills.length === 0) {
      setInstalledSkillAnalysisStates({});
      return () => {
        cancelled = true;
      };
    }

    if (!isTauriRuntime()) {
      setInstalledSkillAnalysisStates((current) => {
        const next = { ...current };
        for (const skill of installedSkills) {
          next[skill.id] = {
            error: null,
            fingerprint: null,
            status: "ready",
          };
        }
        return next;
      });
      return () => {
        cancelled = true;
      };
    }

    const skillsForLookup = installedSkills
      .map((skill) => ({
        skillId: skill.id,
        skillPath: skill.managedSkill?.central_path ?? skill.primaryPath ?? "",
      }))
      .filter((skill) => skill.skillPath);

    setInstalledSkillAnalysisStates((current) => {
      const next: Record<string, LocalSkillAnalysisEntryState> = {};
      for (const skill of installedSkills) {
        next[skill.id] = {
          error: null,
          fingerprint: null,
          status: "ready",
        };
      }
      return next;
    });

    return () => {
      cancelled = true;
    };
  }, [analysisLookupVersion, analysisRefreshVersion, installedSkillsAnalysisKey]);

  const handleRefreshInstalled = async () => {
    await syncRealtimeState();
  };

  const searchPlaceholder =
    skillsTab === "skills"
      ? "按 skill、来源路径或运行时搜索..."
      : "按 MCP server 名称、命令、路径或来源搜索...";
  const currentInventoryError = skillsTab === "skills" ? installedInventoryError : mcpInventoryError;
  const realtimeStatusText = realtimeSyncing
    ? "分析状态自动更新中..."
    : `最近同步 ${formatRelativeTimestamp(lastRealtimeSyncAt)}`;

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-white">
      <header
        data-tauri-drag-region
        className="flex h-14 items-center justify-between border-b border-[#eef1f4] px-6"
        style={DRAG_REGION_STYLE}
      >
        <div className="flex items-center gap-6" data-window-drag-disabled="true" style={NO_DRAG_REGION_STYLE}>
          <h1 className="text-sm font-semibold uppercase tracking-[0.04em] text-[#7b8491]">
            资产管理
          </h1>
          <div className="flex items-center gap-1 rounded-xl border border-[#e4e9f0] bg-[#f8fafc] p-1">
            <button
              type="button"
              onClick={() => setSkillsTab("skills")}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
                skillsTab === "skills" ? "bg-white text-[#175cd3] shadow-sm" : "text-[#667085] hover:text-[#175cd3]"
              }`}
            >
              Skills
            </button>
            <button
              type="button"
              onClick={() => setSkillsTab("mcps")}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
                skillsTab === "mcps" ? "bg-white text-[#175cd3] shadow-sm" : "text-[#667085] hover:text-[#175cd3]"
              }`}
            >
              MCP
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3" data-window-drag-disabled="true" style={NO_DRAG_REGION_STYLE}>
          <div className="text-[11px] font-medium text-[#8ea0b6]">{realtimeStatusText}</div>
          <button
            type="button"
            onClick={() => void handleRefreshInstalled()}
            disabled={busy}
            data-window-drag-disabled="true"
            style={NO_DRAG_REGION_STYLE}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-60 ${
              realtimeSyncing
                ? "border-[#bcd2f7] bg-[#eef5ff] text-[#2f76e9]"
                : "border-[#d8e0ea] bg-white text-[#516072] hover:border-[#c8d5e4] hover:text-[#2f76e9]"
            }`}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${realtimeSyncing ? "bg-[#2f76e9] animate-pulse" : "bg-[#98a2b3]"}`} />
            {realtimeSyncing ? "刷新中..." : "刷新"}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#f6f8fb]">
        <section className="border-b border-[#e8edf4] bg-white px-6 py-3">
          <div className="flex items-center gap-4" data-window-drag-disabled="true" style={NO_DRAG_REGION_STYLE}>
            <div className="relative max-w-[420px] flex-1">
              <input
                value={installedQuery}
                onChange={(event) => setInstalledQuery(event.target.value)}
                className="w-full rounded-lg border border-[#d8e0ea] bg-white py-2 pl-9 pr-3 text-[13px] text-[#243042] outline-none transition focus:border-[#2f76e9]"
                placeholder={searchPlaceholder}
              />
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#98a2b3]">
                <SearchTinyIcon />
              </span>
            </div>

          </div>
          {currentInventoryError ? (
            <div className="mt-3 rounded-lg border border-[#f4d6d2] bg-[#fff6f5] px-3 py-2 text-[12px] text-[#b42318]">
              本地扫描失败：{currentInventoryError}
            </div>
          ) : null}
        </section>

        {skillsTab === "skills" ? (
          <div className="min-h-0 flex-1 overflow-hidden px-6 py-4">
            <section className="grid h-full min-h-0 gap-4 [grid-template-columns:minmax(380px,460px)_minmax(0,1fr)]">
              <section className="flex min-h-0 flex-col rounded-2xl border border-[#e4e9f0] bg-white">
                <div className="flex items-center justify-between border-b border-[#eef2f5] px-4 py-3">
                  <div className="text-[13px] font-semibold text-[#243042]">
                    本地 Skills
                  </div>
                  <div className="text-[12px] text-[#8ea0b6]">
                    共 {filteredInstalledSkills.length} 项
                  </div>
                </div>

                <div className="hover-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                  <div className="space-y-2">
                    {installedInventoryLoading && installedSkills.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[#d9e2ec] bg-[#fbfcfe] px-4 py-8 text-center text-[12px] text-[#8ea0b6]">
                        正在扫描本地 Skills...
                      </div>
                    ) : installedInventoryError && installedSkills.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[#f4d6d2] bg-[#fff6f5] px-4 py-8 text-center text-[12px] text-[#b42318]">
                        本地 Skills 扫描失败，请刷新后重试。
                      </div>
                    ) : filteredInstalledSkills.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[#d9e2ec] bg-[#fbfcfe] px-4 py-8 text-center text-[12px] text-[#8ea0b6]">
                        没有匹配当前筛选条件的本地 Skill。
                      </div>
                    ) : (
                      pagedInstalledSkills.map((skill, index) => (
                        <ManagedSkillDistributionRow
                          key={skill.id}
                          index={installedSkillsPagination.startIndex + index}
                          onSelect={setSelectedInstalledSkillId}
                          selected={selectedInstalledSkill?.id === skill.id}
                          skill={skill}
                        />
                      ))
                    )}
                  </div>
                </div>
                <InventoryPagination
                  currentPage={installedSkillsPagination.currentPage}
                  pageCount={installedSkillsPagination.pageCount}
                  pageSize={INSTALLED_SKILLS_PAGE_SIZE}
                  totalItems={filteredInstalledSkills.length}
                  onChange={setInstalledSkillsPage}
                />
              </section>

              <LocalManagedSkillPanel
                detailEntryState={selectedInstalledSkill ? installedSkillAnalysisStates[selectedInstalledSkill.id] ?? null : null}
                managedSkill={selectedInstalledSkill}
                onOpenManagedSkillDetail={onOpenManagedSkillDetail}
              />
            </section>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden px-6 py-4">
            <section className="grid h-full min-h-0 gap-4 [grid-template-columns:minmax(340px,420px)_minmax(0,1fr)]">
              <section className="flex min-h-0 flex-col rounded-2xl border border-[#e4e9f0] bg-white">
                <div className="flex items-center justify-between border-b border-[#eef2f5] px-4 py-3">
                  <div className="text-[13px] font-semibold text-[#243042]">
                    MCP Servers
                  </div>
                  <div className="text-[12px] text-[#8ea0b6]">
                    共 {filteredMcpComponents.length} 项
                  </div>
                </div>

                <div className="hover-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                  <div className="space-y-2">
                    {mcpInventoryLoading && mcpComponents.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[#d9e2ec] bg-[#fbfcfe] px-4 py-8 text-center text-[12px] text-[#8ea0b6]">
                        正在发现本机 MCP server...
                      </div>
                    ) : mcpInventoryError && mcpComponents.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[#f4d6d2] bg-[#fff6f5] px-4 py-8 text-center text-[12px] text-[#b42318]">
                        MCP server 扫描失败，请刷新后重试。
                      </div>
                    ) : filteredMcpComponents.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[#d9e2ec] bg-[#fbfcfe] px-4 py-8 text-center text-[12px] text-[#8ea0b6]">
                        当前没有匹配筛选条件的 MCP server。
                      </div>
                    ) : (
                      pagedMcpComponents.map((component, index) => (
                        <McpInventoryRow
                          key={component.id}
                          component={component}
                          index={mcpPagination.startIndex + index}
                          onSelect={setSelectedMcpId}
                          selected={selectedMcpComponent?.id === component.id}
                        />
                      ))
                    )}
                  </div>
                </div>
                <InventoryPagination
                  currentPage={mcpPagination.currentPage}
                  pageCount={mcpPagination.pageCount}
                  pageSize={MCP_COMPONENTS_PAGE_SIZE}
                  totalItems={filteredMcpComponents.length}
                  onChange={setMcpPage}
                />
              </section>

              <McpInventoryPanel component={selectedMcpComponent} />
            </section>
          </div>
        )}

      </div>
    </main>
  );
}

function InventoryPagination({
  currentPage,
  pageCount,
  pageSize,
  totalItems,
  onChange,
}: {
  currentPage: number;
  pageCount: number;
  pageSize: number;
  totalItems: number;
  onChange: Dispatch<SetStateAction<number>>;
}) {
  if (totalItems <= pageSize) {
    return null;
  }

  return (
    <div className="flex items-center justify-between border-t border-[#eef2f5] bg-[#fbfcfe] px-4 py-2.5">
      <div className="text-[11px] text-[#8ea0b6]">
        第 {(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, totalItems)} 项，共 {totalItems} 项
      </div>
      <div className="flex items-center gap-2">
        <div className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-[#516072] ring-1 ring-[#e4e9f0]">
          第 {currentPage} / {pageCount} 页
        </div>
        <div className="flex items-center gap-1 rounded-full border border-[#e4e9f0] bg-white p-1">
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => onChange((page) => Math.max(1, page - 1))}
            className="rounded-full px-2.5 py-1 text-[11px] font-medium text-[#667085] transition hover:bg-[#f5f8ff] hover:text-[#175cd3] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {"<"}
          </button>
          <button
            type="button"
            disabled={currentPage >= pageCount}
            onClick={() => onChange((page) => Math.min(pageCount, page + 1))}
            className="rounded-full px-2.5 py-1 text-[11px] font-medium text-[#667085] transition hover:bg-[#f5f8ff] hover:text-[#175cd3] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {">"}
          </button>
        </div>
      </div>
    </div>
  );
}


function ManagedSkillDistributionRow({
  index,
  onSelect,
  selected,
  skill,
}: {
  index: number;
  onSelect: Dispatch<SetStateAction<string | null>>;
  selected: boolean;
  skill: InstalledSkillListItem;
}) {
  const discoveredLabels = Array.from(new Set(skill.locations.map((location) => location.toolLabel)));
  const sourceName = skill.primaryPath ? basename(skill.primaryPath) : "未记录来源";
  const trailingLabel = skill.managedSkill?.last_sync_at
    ? `同步于 ${formatRelativeTimestamp(skill.managedSkill.last_sync_at)}`
    : skill.locations.length > 0
      ? `${skill.locations.length} 个安装位置`
      : "未关联安装位置";

  return (
    <article
      onClick={() => onSelect(skill.id)}
      className={`cursor-pointer rounded-xl border p-3 transition ${
        selected
          ? "border-[#bfd4fb] bg-[#eef5ff] text-[#243042]"
          : "border-[#e4e9f0] bg-white text-[#243042] hover:border-[#cfdae8] hover:bg-[#fbfcfe]"
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${avatarColor(index)}`}>
          {initials(skill.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-[#243042]">{skill.name}</div>
              <div className="mt-1 truncate text-[11px] text-[#8ea0b6]">
                {sourceName}
              </div>
            </div>
          </div>
          <div className="mt-1 text-[12px] leading-5 text-[#667085]">
            <div
              className="overflow-hidden"
              style={{
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: 3,
              }}
            >
              {skill.description}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {discoveredLabels.length > 0 ? (
              discoveredLabels.slice(0, 4).map((label) => (
                <span
                  key={`${skill.id}-${label}`}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    selected
                      ? "bg-white text-[#175cd3] border border-[#d9e8ff]"
                      : "bg-[#eef4ff] text-[#2f76e9]"
                  }`}
                >
                  {label}
                </span>
              ))
            ) : (
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  selected
                    ? "bg-white text-[#b54708] border border-[#fde7c2]"
                    : "bg-[#fff4d6] text-[#9a6a00]"
                }`}
              >
                未分配
              </span>
            )}
            <span className="ml-auto text-[11px] text-[#8ea0b6]">
              {trailingLabel}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}


function LocalManagedSkillPanel({
  detailEntryState,
  managedSkill,
  onOpenManagedSkillDetail,
}: {
  detailEntryState: LocalSkillAnalysisEntryState | null;
  managedSkill: InstalledSkillListItem | null;
  onOpenManagedSkillDetail: (skill: InstalledSkillListItem, action?: ManagedSkillDetailAction) => Promise<void>;
}) {
  if (!managedSkill) {
    return (
      <aside className="rounded-2xl border border-dashed border-[#d9e2ec] bg-white px-6 py-10 text-center">
        <div className="text-[16px] font-semibold text-[#243042]">选择一个 Skill</div>
        <div className="mt-2 text-[12px] leading-6 text-[#8ea0b6]">
          右侧会展示它的本地来源、安装位置和可用的管理操作。
        </div>
      </aside>
    );
  }

  const managedRecord = managedSkill.managedSkill;
  const enabledToolLabels = Array.from(
    new Set(
      managedSkill.locations
        .filter((location) => location.toolKey || location.toolLabel)
        .map((location) => location.toolLabel),
    ),
  );
  const sourcePath =
    managedRecord?.source_ref && isHttpUrl(managedRecord.source_ref)
      ? managedRecord.source_ref
      : managedSkill.primaryPath ?? managedRecord?.source_ref ?? null;
  const displaySource = sourcePath ?? "无来源信息";

  const handleOpenSource = async () => {
    if (!sourcePath) {
      return;
    }

    if (isHttpUrl(sourcePath)) {
      await openExternalUrl(sourcePath);
      return;
    }

    await openLocalPath(sourcePath);
  };

  const resolveDetailFilePath = (relativePath: string) => {
    if (!managedSkill.primaryPath) {
      return null;
    }

    const basePath = managedSkill.primaryPath.replace(/\/+$/, "");
    const normalizedRelativePath = relativePath.replace(/^\/+/, "");
    return `${basePath}/${normalizedRelativePath}`;
  };

  const handleOpenDetailFile = async (relativePath: string) => {
    const detailFilePath = resolveDetailFilePath(relativePath);
    if (!detailFilePath || !isMarkdownPath(detailFilePath)) {
      return;
    }

    await openMarkdownPreview(detailFilePath);
  };

  const handleOpenSkillDetail = async () => {
    await onOpenManagedSkillDetail(managedSkill, effectiveDetailEntryState.status === "ready" ? "view" : "analyze");
  };

  const effectiveDetailEntryState = detailEntryState ?? {
    error: null,
    fingerprint: null,
    status: "checking",
  };

  const detailButtonLabel =
    effectiveDetailEntryState.status === "checking"
      ? "检查分析档案..."
      : effectiveDetailEntryState.status === "ready"
        ? "查看分析详情"
        : "开始安全分析";
  const detailButtonMutedText =
    effectiveDetailEntryState.status === "checking"
      ? "正在校验本地 fingerprint 是否已有成功分析"
      : effectiveDetailEntryState.status === "ready"
        ? "已命中本地内容对应的风险档案"
        : effectiveDetailEntryState.error
          ? effectiveDetailEntryState.error
          : effectiveDetailEntryState.fingerprint
            ? "未命中成功分析档案，将上传当前本地版本并重新分析"
            : "当前没有命中可直接查看的分析档案";

  return (
    <aside className="hover-scrollbar flex min-h-0 flex-col overflow-y-auto rounded-2xl border border-[#e4e9f0] bg-white">
      <div className="border-b border-[#eef2f5] px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8ea0b6]">当前 Skill</div>
            <div className="mt-1 truncate text-[16px] font-semibold text-[#243042]">{managedSkill.name}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {enabledToolLabels.length > 0 ? (
                enabledToolLabels.map((label) => (
                  <span
                    key={`${managedSkill.id}-header-${label}`}
                    className="rounded-full bg-[#eefaf3] px-2.5 py-1 text-[11px] font-semibold text-[#13804b]"
                  >
                    {label}
                  </span>
                ))
              ) : (
                <span className="rounded-full bg-[#f1f5f9] px-2.5 py-1 text-[11px] font-semibold text-[#667085]">
                  未关联工具
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              type="button"
              onClick={() => void handleOpenSkillDetail()}
              disabled={effectiveDetailEntryState.status === "checking"}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                effectiveDetailEntryState.status === "ready"
                  ? "border border-[#d8e0ea] bg-white text-[#516072] hover:border-[#c8d5e4] hover:text-[#2f76e9]"
                  : "border border-[#bcd2f7] bg-[#eef5ff] text-[#2f76e9] hover:border-[#a7c4f6] hover:bg-[#e6f0ff]"
              }`}
            >
              {detailButtonLabel}
            </button>
            <div className="max-w-[240px] text-right text-[11px] leading-5 text-[#8ea0b6]">
              {detailButtonMutedText}
            </div>
          </div>
        </div>
        <div className="mt-3 text-[12px] leading-6 text-[#667085]">
          {managedSkill.description}
        </div>
      </div>

      <div>
        <div className="border-b border-[#eef2f5] px-4 py-3">
          <div className="grid gap-y-2 text-[11px] text-[#8ea0b6]">
            <div>
              <div className="font-semibold uppercase tracking-[0.08em]">Source</div>
              <div className="mt-1 truncate text-[12px] text-[#243042]">
                {displaySource}
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {sourcePath ? (
              <button
                type="button"
                onClick={() => void handleOpenSource()}
                className="rounded-lg border border-[#d8e0ea] bg-white px-3 py-1.5 text-[12px] font-medium text-[#516072] transition hover:border-[#c8d5e4] hover:text-[#2f76e9]"
              >
                打开来源
              </button>
            ) : null}
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="text-[13px] font-semibold text-[#243042]">Skill 文件列表</div>
          <div className="mt-1 text-[11px] text-[#8ea0b6]">当前仅支持 Markdown 文件预览。</div>
          {managedSkill.detailFiles.length > 0 ? (
            <div className="mt-3 space-y-2">
              {managedSkill.detailFiles.map((file) => {
                const detailFilePath = resolveDetailFilePath(file);
                const canPreview = Boolean(detailFilePath && isMarkdownPath(detailFilePath));

                return (
                  <div
                    key={`${managedSkill.id}-${file}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[#eef2f5] bg-[#fbfcfe] px-3 py-2"
                  >
                    <div className="min-w-0 truncate text-[12px] text-[#516072]">{file}</div>
                    <button
                      type="button"
                      disabled={!canPreview}
                      title={canPreview ? `预览 ${file}` : "暂仅支持 Markdown 文件预览"}
                      onClick={() => void handleOpenDetailFile(file)}
                      className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                        canPreview
                          ? "border border-[#d8e0ea] bg-white text-[#516072] hover:border-[#c8d5e4] hover:text-[#2f76e9]"
                          : "cursor-not-allowed border border-[#e4e7ec] bg-[#f8fafc] text-[#a0acbd]"
                      }`}
                    >
                      {canPreview ? "预览" : "暂不支持"}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-[#d9e2ec] bg-[#fbfcfe] px-3 py-6 text-[12px] text-[#8ea0b6]">
              当前还没有拿到这个 Skill 的文件清单。
            </div>
          )}
        </div>
      </div>

    </aside>
  );
}


function McpInventoryRow({
  component,
  index,
  onSelect,
  selected,
}: {
  component: DiscoveredComponent;
  index: number;
  onSelect: Dispatch<SetStateAction<string | null>>;
  selected: boolean;
}) {
  const clientLabel =
    typeof component.metadata.client_label === "string"
      ? component.metadata.client_label
      : typeof component.metadata.client === "string"
        ? component.metadata.client
        : component.source;
  const transport =
    typeof component.metadata.transport === "string" ? component.metadata.transport : null;
  const command =
    typeof component.metadata.command === "string" ? component.metadata.command : null;
  const url = typeof component.metadata.url === "string" ? component.metadata.url : null;
  const secondaryText = url ?? command ?? component.path;

  return (
    <article
      onClick={() => onSelect(component.id)}
      className={`cursor-pointer rounded-xl border p-3 transition ${
        selected
          ? "border-[#bfd4fb] bg-[#eef5ff] text-[#243042]"
          : "border-[#e4e9f0] bg-white text-[#243042] hover:border-[#cfdae8] hover:bg-[#fbfcfe]"
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${avatarColor(index)}`}>
          <DownloadTinyIcon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[#243042]">{component.name}</div>
          <div className="mt-1 truncate text-[11px] text-[#8ea0b6]">{component.path}</div>
          <div className="mt-1 truncate text-[11px] text-[#667085]">{secondaryText}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              selected ? "border border-[#d9e8ff] bg-white text-[#175cd3]" : "bg-[#eef4ff] text-[#2f76e9]"
            }`}>
              {clientLabel}
            </span>
            {transport ? (
              <span className="rounded-full bg-[#f5f7fa] px-2.5 py-1 text-[11px] font-semibold text-[#667085]">
                {transport}
              </span>
            ) : null}
            <span className="rounded-full bg-[#f5f7fa] px-2.5 py-1 text-[11px] font-semibold text-[#667085]">
              {basename(component.path)}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}


function McpInventoryPanel({
  component,
}: {
  component: DiscoveredComponent | null;
}) {
  if (!component) {
    return (
      <aside className="rounded-2xl border border-dashed border-[#d9e2ec] bg-white px-6 py-10 text-center">
        <div className="text-[16px] font-semibold text-[#243042]">选择一个 MCP server</div>
        <div className="mt-2 text-[12px] leading-6 text-[#8ea0b6]">
          右侧会展示这个 MCP server 的来源配置、元数据和客户端来源。
        </div>
      </aside>
    );
  }

  const metadataEntries = Object.entries(component.metadata);
  const clientLabel =
    typeof component.metadata.client_label === "string"
      ? component.metadata.client_label
      : typeof component.metadata.client === "string"
        ? component.metadata.client
        : component.source;
  const transport =
    typeof component.metadata.transport === "string" ? component.metadata.transport : null;

  return (
    <aside className="hover-scrollbar flex min-h-0 flex-col overflow-y-auto rounded-2xl border border-[#e4e9f0] bg-white">
      <div className="border-b border-[#eef2f5] px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8ea0b6]">当前 MCP Server</div>
            <div className="mt-1 truncate text-[16px] font-semibold text-[#243042]">{component.name}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[#eef4ff] px-2.5 py-1 text-[11px] font-semibold text-[#2f76e9]">
                {clientLabel}
              </span>
              {transport ? (
                <span className="rounded-full bg-[#f5f7fa] px-2.5 py-1 text-[11px] font-semibold text-[#667085]">
                  {transport}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void openLocalPath(component.path)}
            className="rounded-lg border border-[#d8e0ea] bg-white px-3 py-1.5 text-[12px] font-medium text-[#516072] transition hover:border-[#c8d5e4] hover:text-[#2f76e9]"
          >
            打开配置
          </button>
        </div>
        <div className="mt-3 text-[12px] leading-6 text-[#667085]">
          {component.description?.trim() || "当前 MCP server 未提供描述信息。"}
        </div>
      </div>

      <div className="border-b border-[#eef2f5] px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8ea0b6]">Config</div>
        <div className="mt-1 break-all text-[12px] text-[#243042]">{component.path}</div>
      </div>

      <div className="border-b border-[#eef2f5] px-4 py-3">
        <div className="text-[13px] font-semibold text-[#243042]">Metadata</div>
        {metadataEntries.length > 0 ? (
          <div className="mt-3 space-y-2">
            {metadataEntries.map(([key, value]) => (
              <div key={key} className="rounded-lg border border-[#eef2f5] bg-[#fbfcfe] px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8ea0b6]">{key}</div>
                <div className="mt-1 break-all text-[12px] text-[#516072]">{formatMetadataValue(value)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-[#d9e2ec] bg-[#fbfcfe] px-3 py-6 text-[12px] text-[#8ea0b6]">
            当前 MCP server 没有暴露额外 metadata。
          </div>
        )}
      </div>

      <div className="px-4 py-3">
        <div className="text-[13px] font-semibold text-[#243042]">关联关系</div>
        {component.relationships.length > 0 ? (
          <div className="mt-3 space-y-2">
            {component.relationships.map((relation) => (
              <div key={`${relation.relation}-${relation.target_id}`} className="rounded-lg border border-[#eef2f5] bg-[#fbfcfe] px-3 py-2 text-[12px] text-[#516072]">
                <span className="font-semibold text-[#243042]">{relation.relation}</span>
                <span className="mx-2 text-[#98a2b3]">→</span>
                <span className="break-all">{relation.target_id}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-[#d9e2ec] bg-[#fbfcfe] px-3 py-6 text-[12px] text-[#8ea0b6]">
            当前 MCP server 没有记录关联关系。
          </div>
        )}
      </div>
    </aside>
  );
}


function formatMetadataValue(value: unknown) {
  if (value == null) {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
