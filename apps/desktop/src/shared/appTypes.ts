import type { ReactNode } from "react";
import type {
  Finding,
  ManagedSkill,
  MarketplaceCategory,
  MarketplaceSkillRecord,
} from "../types";

export type View = "dashboard" | "assets" | "runtime" | "detail" | "toolbox" | "settings" | "scan";
export type NavView = "dashboard" | "assets" | "runtime" | "toolbox" | "settings";
export type FindingWithFile = Finding & { filePath: string; sourceName: string };
export type SkillsTab = "skills" | "mcps";
export type ScanBackend = "local_scanner" | "repository_audit";
export type CheckState = "done" | "issue" | "working" | "waiting";
export type ManagedSkillDetailAction = "view" | "analyze";

export type AppSettings = {
  scanPaths: string[];
  mcpScanPaths: string[];
  recursiveScan: boolean;
  realtimeProtection: boolean;
  autoScanOnLaunch: boolean;
  autoScanInterval: "manual" | "daily" | "weekly";
  autoQuarantine: boolean;
  logRetentionDays: "7" | "30" | "90";
  backend: ScanBackend;
  aiExplanation: boolean;
  includedExtensions: string[];
};

export type MarketplaceSkillCardModel = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  categorySlug: string;
  downloads: number;
  installsLabel: string;
  installs: number;
  starsLabel: string;
  stars: number;
  versionLabel: string;
  author: string;
  homepage?: string | null;
  isTopSkill: boolean;
  topRank?: number | null;
  intelligenceVerdict?: "clear" | "review" | "block" | null;
  intelligenceRiskLevel?: string | null;
  intelligenceScore?: number | null;
  intelligenceSource?: string | null;
  intelligenceTraits: string[];
  intelligenceRecommendations: string[];
  accent: string;
  icon: ReactNode;
};

export type MarketplaceSortOption = {
  label: string;
  sortBy: string;
  sortOrder: "asc" | "desc";
};

export type InstalledSkillLocation = {
  path: string;
  root: string | null;
  toolKey: string | null;
  toolLabel: string;
};

export type InstalledSkillListItem = {
  id: string;
  name: string;
  description: string;
  detailFiles: string[];
  locations: InstalledSkillLocation[];
  managedSkill: ManagedSkill | null;
  primaryPath: string | null;
};

export type MarketplaceLookup = Map<string, MarketplaceCategory>;
export type MarketplaceRecord = MarketplaceSkillRecord;
