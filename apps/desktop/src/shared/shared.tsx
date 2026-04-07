import type {
  InstalledSkillListItem,
  InstalledSkillLocation,
  MarketplaceSkillCardModel,
  MarketplaceSortOption,
} from "./appTypes";
import type {
  ComponentReport,
  DiscoverySnapshot,
  ManagedSkill,
  MarketplaceSkillRecord,
  SkillReport,
  ToolInfo,
} from "../types";
import {
  basename,
  isHttpUrl,
  normalizePathForLookup,
  normalizeSkillLookupKey,
  toolInfoForSkillRoot,
} from "./pathUtils";

export const MARKETPLACE_SORT_OPTIONS: MarketplaceSortOption[] = [
  { label: "按 Stars", sortBy: "stars", sortOrder: "desc" },
  { label: "按下载量", sortBy: "downloads", sortOrder: "desc" },
  { label: "名称 A-Z", sortBy: "name", sortOrder: "asc" },
];

export function buildInstalledSkillList(
  snapshot: DiscoverySnapshot | null,
  managedSkills: ManagedSkill[],
  toolInfos: ToolInfo[],
) {
  const itemsByKey = new Map<string, InstalledSkillListItem>();

  const ensureItem = (
    key: string,
    defaults: Partial<InstalledSkillListItem> & Pick<InstalledSkillListItem, "name">,
  ) => {
    const existing = itemsByKey.get(key);
    if (existing) {
      return existing;
    }

    const created: InstalledSkillListItem = {
      id: defaults.id ?? key,
      name: defaults.name,
      description: defaults.description ?? "已从本地目录发现这个 Skill。",
      detailFiles: defaults.detailFiles ?? [],
      locations: defaults.locations ?? [],
      managedSkill: defaults.managedSkill ?? null,
      primaryPath: defaults.primaryPath ?? null,
    };
    itemsByKey.set(key, created);
    return created;
  };

  const addLocation = (item: InstalledSkillListItem, location: InstalledSkillLocation) => {
    const locationKey = `${location.toolKey ?? "custom"}:${normalizePathForLookup(location.path)}`;
    if (
      item.locations.some(
        (existing) =>
          `${existing.toolKey ?? "custom"}:${normalizePathForLookup(existing.path)}` === locationKey,
      )
    ) {
      return;
    }
    item.locations.push(location);
  };

  for (const component of snapshot?.components ?? []) {
    if (component.kind !== "skill") {
      continue;
    }

    const root =
      component.metadata && typeof component.metadata.root === "string"
        ? component.metadata.root
        : null;
    const tool = toolInfoForSkillRoot(root ?? component.path, toolInfos);
    const key = normalizeSkillLookupKey(component.name) || normalizePathForLookup(component.path);
    const item = ensureItem(key, {
      id: component.id,
      name: component.name,
      description: component.description?.trim() || "已从本地目录发现这个 Skill。",
      primaryPath: component.path,
    });

    if (!item.primaryPath) {
      item.primaryPath = component.path;
    }
    if (!item.description && component.description?.trim()) {
      item.description = component.description.trim();
    }

    addLocation(item, {
      path: component.path,
      root,
      toolKey: tool?.key ?? null,
      toolLabel: tool?.label ?? (root ? basename(root) : "自定义目录"),
    });

    const detailFiles = (snapshot?.components ?? [])
      .filter(
        (child) =>
          child.kind !== "skill" &&
          normalizePathForLookup(child.path).startsWith(`${normalizePathForLookup(component.path)}/`),
      )
      .map((child) => {
        const relative = child.path.slice(component.path.length).replace(/^\/+/, "");
        return relative || basename(child.path);
      })
      .filter(Boolean)
      .slice(0, 24);
    if (detailFiles.length > 0) {
      item.detailFiles = Array.from(new Set([...item.detailFiles, ...detailFiles])).sort((left, right) =>
        left.localeCompare(right),
      );
    }
  }

  const findManagedItemKey = (skill: ManagedSkill) => {
    const sourcePath = skill.source_ref && !isHttpUrl(skill.source_ref) ? normalizePathForLookup(skill.source_ref) : "";
    const centralPath = normalizePathForLookup(skill.central_path);
    const nameKey = normalizeSkillLookupKey(skill.name);
    const sourceBaseKey = skill.source_ref ? normalizeSkillLookupKey(basename(skill.source_ref)) : "";

    for (const [key, item] of itemsByKey.entries()) {
      if (sourcePath && normalizePathForLookup(item.primaryPath) === sourcePath) {
        return key;
      }

      if (
        item.locations.some(
          (location) =>
            normalizePathForLookup(location.path) === sourcePath ||
            normalizePathForLookup(location.path) === centralPath,
        )
      ) {
        return key;
      }

      if (key === nameKey || normalizeSkillLookupKey(item.name) === sourceBaseKey) {
        return key;
      }
    }

    return null;
  };

  for (const managedSkill of managedSkills) {
    const existingKey = findManagedItemKey(managedSkill);
    if (!existingKey) {
      continue;
    }

    const item = ensureItem(existingKey, {
      id: managedSkill.id,
      name: managedSkill.name,
      description: managedSourceDescription(managedSkill),
      primaryPath:
        managedSkill.source_ref && !isHttpUrl(managedSkill.source_ref)
          ? managedSkill.source_ref
          : managedSkill.central_path,
      managedSkill,
    });

    item.managedSkill = managedSkill;
    if (!item.description) {
      item.description = managedSourceDescription(managedSkill);
    }
    if (!item.primaryPath) {
      item.primaryPath =
        managedSkill.source_ref && !isHttpUrl(managedSkill.source_ref)
          ? managedSkill.source_ref
          : managedSkill.central_path;
    }

    for (const target of managedSkill.targets) {
      const tool = toolInfos.find((entry) => entry.key === target.tool) ?? null;
      addLocation(item, {
        path: target.target_path,
        root: tool?.skills_dir ?? null,
        toolKey: target.tool,
        toolLabel: tool?.label ?? target.tool,
      });
    }
  }

  return Array.from(itemsByKey.values())
    .map((item) => ({
      ...item,
      description: item.description || "已从本地目录发现这个 Skill。",
      detailFiles: item.detailFiles.slice(),
      locations: item.locations.slice().sort((left, right) => left.toolLabel.localeCompare(right.toolLabel)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function managedSourceTone(sourceType: string) {
  if (sourceType.toLowerCase().includes("git")) {
    return "bg-[#eff6ff] text-[#2563eb]";
  }

  if (sourceType.toLowerCase().includes("local")) {
    return "bg-[#e8f7ef] text-[#13804b]";
  }

  return "bg-[#f1f4f8] text-[#5d6d84]";
}

export function managedSourceTypeLabel(sourceType: string) {
  const normalized = sourceType.toLowerCase();

  if (normalized.includes("git")) {
    return "从仓库导入";
  }

  if (normalized.includes("local")) {
    return "本地导入";
  }

  return "已添加";
}

export function managedSourceDescription(skill: ManagedSkill) {
  const normalized = skill.source_type.toLowerCase();

  if (normalized.includes("git")) {
    return "这个 Skill 来自代码仓库，后续可以继续检查更新。";
  }

  if (normalized.includes("local")) {
    return "这个 Skill 来自你的本地文件，已加入当前技能列表。";
  }

  return "这个 Skill 已加入当前技能列表，可按需启用。";
}

export function buildRepositoryScanPreviewFiles(
  path: string | null,
  data: { results: SkillReport[]; mcp_results: ComponentReport[]; agent_results: ComponentReport[] } | null,
) {
  const actualFiles = data
    ? Array.from(
        new Set(
          [
            ...data.results.flatMap((item) => item.files.map((file) => file.path)),
            ...data.mcp_results.flatMap((item) => item.files.map((file) => file.path)),
            ...data.agent_results.flatMap((item) => item.files.map((file) => file.path)),
          ].filter(Boolean),
        ),
      ).slice(0, 12)
    : [];

  if (actualFiles.length > 0) {
    return actualFiles;
  }

  if (!path) {
    return ["等待选择项目目录"];
  }

  return [
    `${path}/agent.py`,
    `${path}/agents/main.py`,
    `${path}/config/mcp.json`,
    `${path}/tools/search.py`,
    `${path}/prompts/system.md`,
    `${path}/server/index.ts`,
    `${path}/src/runtime/bridge.ts`,
    `${path}/src/security/policies.ts`,
  ];
}

export function resolveMarketplaceInstallSource(value?: string | null) {
  if (!value || !isHttpUrl(value)) {
    return null;
  }

  if (value.endsWith(".git")) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/i, "")}.git`;
  } catch {
    return null;
  }
}

export function isMarketplaceSkillInstalled(skill: MarketplaceSkillCardModel, installedKeys: Set<string>) {
  const keys = [
    skill.slug,
    skill.name,
    skill.homepage,
    skill.homepage?.split("/").filter(Boolean).pop()?.replace(/\.git$/i, ""),
  ]
    .filter(Boolean)
    .map((value) => normalizeSkillLookupKey(value as string));

  return keys.some((key) => installedKeys.has(key));
}

export function findManagedSkillMarketplaceMatch(
  skill: ManagedSkill,
  rows: MarketplaceSkillRecord[],
) {
  const keys = new Set<string>();
  const addKey = (value?: string | null) => {
    if (!value) return;
    const normalized = normalizeSkillLookupKey(value);
    if (normalized) {
      keys.add(normalized);
    }
  };

  addKey(skill.name);
  addKey(basename(skill.central_path));

  if (skill.source_ref) {
    if (isHttpUrl(skill.source_ref)) {
      addKey(skill.source_ref.split("/").filter(Boolean).pop()?.replace(/\.git$/i, ""));
    } else {
      addKey(basename(skill.source_ref));
    }
  }

  let best: MarketplaceSkillRecord | null = null;
  let bestScore = -1;

  for (const row of rows) {
    const slugKey = normalizeSkillLookupKey(row.slug);
    const nameKey = normalizeSkillLookupKey(row.name);
    let score = 0;

    if (keys.has(slugKey)) score = Math.max(score, 100);
    if (keys.has(nameKey)) score = Math.max(score, 96);
    if ([...keys].some((key) => slugKey.includes(key) || nameKey.includes(key) || key.includes(slugKey))) {
      score = Math.max(score, 80);
    }
    if (row.is_top_skill) score += 2;
    if ((row.library_score ?? row.intelligence_score ?? 0) > 0) score += 1;

    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  return bestScore >= 80 ? best : null;
}

export function buildManagedSkillMarketplaceCandidates(skill: ManagedSkill) {
  const values = new Set<string>();
  const add = (value?: string | null) => {
    if (!value) {
      return;
    }

    const normalized = normalizeSkillLookupKey(value);
    if (normalized) {
      values.add(normalized);
    }
  };

  add(skill.name);
  add(basename(skill.central_path));

  if (skill.source_ref) {
    if (isHttpUrl(skill.source_ref)) {
      try {
        const url = new URL(skill.source_ref);
        const parts = url.pathname.split("/").filter(Boolean);
        add(parts[parts.length - 1]?.replace(/\.git$/i, ""));
        add(parts[parts.length - 2]);
      } catch {
        add(skill.source_ref);
      }
    } else {
      add(skill.source_ref);
      add(basename(skill.source_ref));
    }
  }

  return Array.from(values);
}

export function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
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

export function marketplaceRiskLevelLabel(level?: string | null) {
  const normalized = level?.trim().toLowerCase();
  if (normalized === "critical") return "严重风险";
  if (normalized === "high") return "高风险";
  if (normalized === "medium") return "中风险";
  if (normalized === "low") return "低风险";
  return "待判断";
}

export function marketplaceRiskLevelShortLabel(level?: string | null) {
  const normalized = level?.trim().toLowerCase();
  if (normalized === "critical") return "严重";
  if (normalized === "high") return "高";
  if (normalized === "medium") return "中";
  if (normalized === "low") return "低";
  return "--";
}

export function getMarketplaceRiskAppearance(level?: string | null, verdict?: "clear" | "review" | "block" | null) {
  const normalized = level?.trim().toLowerCase();

  if (verdict === "block" || normalized === "critical" || normalized === "high") {
    return {
      pillClass: "border-[#ffc8d2] bg-[#fff1f4] text-[#d93b5c]",
      ringClass: "border-[#ffcad5] text-[#d93b5c]",
      surfaceClass: "border-[#ffd4dd] bg-[linear-gradient(135deg,#fff8f8_0%,#fff1f4_100%)]",
      textClass: "text-[#d93b5c]",
    };
  }

  if (verdict === "review" || normalized === "medium") {
    return {
      pillClass: "border-[#f7d7aa] bg-[#fff7ea] text-[#a76500]",
      ringClass: "border-[#f6ddb5] text-[#b36c00]",
      surfaceClass: "border-[#f7dfbf] bg-[linear-gradient(135deg,#fffdf6_0%,#fff7ea_100%)]",
      textClass: "text-[#b36c00]",
    };
  }

  return {
    pillClass: "border-[#cdeed8] bg-[#eefaf3] text-[#13804b]",
    ringClass: "border-[#cdeed8] text-[#13804b]",
    surfaceClass: "border-[#d7efe1] bg-[linear-gradient(135deg,#f8fffb_0%,#eefaf3_100%)]",
    textClass: "text-[#13804b]",
  };
}

export function sanitizeEvidenceSnippet(value?: string | null) {
  if (!value) {
    return "";
  }

  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/AIza[0-9A-Za-z_-]+/g, "AIza[redacted]");
}

export function formatConfidence(value?: number | null) {
  if (value == null || Number.isNaN(value)) {
    return "未提供";
  }

  return `${Math.round(value * 100)}%`;
}

export function formatIsoTimestamp(value?: string | null) {
  if (!value) {
    return "暂无";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

export function formatRelativeTimestamp(timestamp?: number | null) {
  if (!timestamp) {
    return "刚刚";
  }

  const delta = Date.now() - timestamp;
  if (delta < 60_000) {
    return "刚刚";
  }

  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }

  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export function formatAbsoluteTimestamp(timestamp?: number | null) {
  if (!timestamp) {
    return "暂无";
  }

  return new Date(timestamp).toLocaleString();
}

export function buildManagedSkillWindowFallback({
  centralPath,
  id,
  name,
  sourceRef,
  sourceType,
  status,
}: {
  centralPath?: string | null;
  id?: string | null;
  name?: string | null;
  sourceRef?: string | null;
  sourceType?: string | null;
  status?: string | null;
}): ManagedSkill | null {
  const resolvedName = name?.trim();
  const resolvedPath = centralPath?.trim() || sourceRef?.trim();

  if (!resolvedName || !resolvedPath) {
    return null;
  }

  return {
    id: id?.trim() || normalizeSkillLookupKey(`${resolvedName}-${resolvedPath}`),
    name: resolvedName,
    source_type: sourceType?.trim() || "discovered",
    source_ref: sourceRef?.trim() || resolvedPath,
    central_path: resolvedPath,
    created_at: 0,
    updated_at: 0,
    last_sync_at: null,
    status: status?.trim() || "discovered",
    targets: [],
  };
}

export * from "./icons";
export * from "./pathUtils";
export * from "./settings";
export * from "./windowing";
