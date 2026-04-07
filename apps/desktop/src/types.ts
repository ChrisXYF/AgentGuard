export type RiskCategory = "safe" | "suspicious" | "high_risk" | "malicious";

export interface Finding {
  rule_id: string;
  title: string;
  description: string;
  category: string;
  severity: number;
  file: string;
  line: number;
  snippet: string;
}

export interface FileReport {
  path: string;
  risk_score: number;
  category: RiskCategory;
  findings: Finding[];
}

export interface SkillReport {
  name: string;
  path: string;
  risk_score: number;
  category: RiskCategory;
  flags: string[];
  files: FileReport[];
}

export interface ComponentReport {
  name: string;
  path: string;
  component_type: string;
  risk_score: number;
  category: RiskCategory;
  flags: string[];
  files: FileReport[];
}

export interface ScanSummary {
  scanned_roots: string[];
  scanned_skills: number;
  scanned_mcps: number;
  scanned_agents: number;
  scanned_components: number;
  findings: number;
  skill_findings: number;
  mcp_findings: number;
  agent_findings: number;
  backend: string;
  generated_at: string;
}

export interface ScanResponse {
  summary: ScanSummary;
  results: SkillReport[];
  mcp_results: ComponentReport[];
  agent_results: ComponentReport[];
}

export type RepositoryScanJobState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RepositoryScanJobStatus {
  jobId: string;
  path: string;
  status: RepositoryScanJobState;
  stage: string;
  progress: number;
  currentFile?: string | null;
  scannedFiles?: number;
  totalFiles?: number;
  findingsCount?: number;
  highestSeverity?: number;
  stageFindings?: Record<string, number>;
  errorMessage?: string | null;
  response?: ScanResponse | null;
  startedAt: string;
  finishedAt?: string | null;
}

export type ComponentKind = "agent" | "skill" | "mcp_server" | "tool" | "prompt" | "resource";
export type DiscoverySource = "filesystem" | "agent_root" | "skill_root" | "config_file";

export interface ComponentRelationship {
  relation: string;
  target_id: string;
}

export interface DiscoveredComponent {
  id: string;
  kind: ComponentKind;
  name: string;
  source: DiscoverySource;
  path: string;
  description?: string | null;
  metadata: Record<string, unknown>;
  relationships: ComponentRelationship[];
}

export interface DiscoverySnapshot {
  generated_at: string;
  components: DiscoveredComponent[];
}

export interface ScanArtifact {
  schema_version: string;
  artifact_id: string;
  generated_at: string;
  client: ArtifactClient;
  scan_scope: ScanScope;
  inventory: ArtifactInventory;
  local_findings: LocalFindings;
  content_artifacts: ContentArtifacts;
  privacy: ArtifactPrivacy;
}

export interface ArtifactClient {
  product: string;
  version: string;
  platform: string;
  scan_mode: string;
  backend: string;
}

export interface ScanScope {
  roots: string[];
  targets: ArtifactTarget[];
}

export interface ArtifactTarget {
  kind: string;
  path: string;
}

export interface ArtifactInventory {
  summary: ArtifactInventorySummary;
  components: DiscoveredComponent[];
}

export interface ArtifactInventorySummary {
  components: number;
  agents: number;
  skills: number;
  mcps: number;
  prompts: number;
  tools: number;
  resources: number;
}

export interface LocalFindings {
  summary: LocalFindingsSummary;
  components: ArtifactComponentReport[];
}

export interface LocalFindingsSummary {
  total: number;
  by_severity: Record<string, number>;
}

export interface ArtifactComponentReport {
  component_id: string;
  name: string;
  kind: string;
  path: string;
  risk_score: number;
  category: RiskCategory;
  flags: string[];
  files: FileReport[];
}

export interface ContentArtifacts {
  descriptions: ArtifactDescription[];
  files: ArtifactFile[];
}

export interface ArtifactDescription {
  component_id: string;
  kind: string;
  text: string;
  sha256: string;
}

export interface ArtifactFile {
  path: string;
  sha256: string;
  size: number;
  extension?: string | null;
}

export interface ArtifactPrivacy {
  redaction_mode: string;
  includes_raw_content: boolean;
  includes_descriptions: boolean;
}

export interface LocalSkillPackageFile {
  path: string;
  sha256: string;
  content_base64: string;
}

export interface LocalSkillPackage {
  name: string;
  path: string;
  fingerprint: string;
  file_count: number;
  files: LocalSkillPackageFile[];
}

export interface SkillFingerprintRef {
  component_id: string;
  name: string;
  path: string;
  root?: string | null;
  fingerprint: string;
  file_count: number;
}

export interface FullScanBundle {
  run_id: string;
  local_report: ScanResponse;
  full_artifact: ScanArtifact;
  skill_refs: SkillFingerprintRef[];
}

export interface ManagedTarget {
  tool: string;
  mode: string;
  status: string;
  target_path: string;
  synced_at?: number | null;
}

export interface ManagedSkill {
  id: string;
  name: string;
  source_type: string;
  source_ref?: string | null;
  central_path: string;
  created_at: number;
  updated_at: number;
  last_sync_at?: number | null;
  status: string;
  targets: ManagedTarget[];
}

export interface SkillLibraryArtifactFile {
  path: string;
  kind: string;
  sha256: string;
  size: number;
  extension?: string | null;
  content_type?: string | null;
  is_text: boolean;
  is_executable: boolean;
}

export interface SkillLibraryArtifactSource {
  source_type: string;
  source_key: string;
  source_label?: string | null;
  skill_name?: string | null;
  owner_name?: string | null;
  source_url?: string | null;
  raw_metadata: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
}

export interface SkillLibraryAnalysisEvidence {
  path: string;
  reason: string;
  snippet?: string | null;
}

export interface SkillLibraryAnalysisSignature {
  instructions?: string | null;
  prompts_count?: number | null;
  tools_count?: number | null;
  resources_count?: number | null;
}

export interface SkillLibraryAnalysisSummary {
  source?: string | null;
  analysis_method?: string | null;
  score_system?: string | null;
  content_fingerprint?: string | null;
  library_risk_score?: number | null;
  library_verdict?: "clear" | "review" | "block" | null;
  library_risk_level?: string | null;
  analysis_confidence?: number | null;
  analysis_model?: string | null;
  analysis_version?: string | null;
  summary?: string | null;
  reasoning?: string | null;
  category?: string | null;
  category_result?: string | null;
  risk_level?: string | null;
  score_reason?: string | null;
  recommendations?: string[];
  traits?: string[];
  capabilities?: string[];
  suspicious_behaviors?: string[];
  trusted_signals?: string[];
  evidence?: SkillLibraryAnalysisEvidence[];
  signature?: SkillLibraryAnalysisSignature | null;
  file_count?: number | null;
  top_files?: string[];
}

export interface SkillLibraryAnalysis {
  analysis_status: string;
  analysis_error?: string | null;
  analysis_version: string;
  analysis_input_fingerprint?: string | null;
  analysis_score_system: string;
  analysis_method: string;
  analysis_model?: string | null;
  analysis_confidence?: number | null;
  analysis_started_at?: string | null;
  analysis_finished_at?: string | null;
  library_risk_score: number;
  library_verdict?: "clear" | "review" | "block" | null;
  library_risk_level?: string | null;
  analysis_summary: SkillLibraryAnalysisSummary;
}

export interface SkillLibraryArtifactDetail {
  artifact_id: string;
  fingerprint_version: string;
  content_fingerprint: string;
  instructions_sha256?: string | null;
  file_count: number;
  prompts_count: number;
  tools_count: number;
  resources_count: number;
  first_seen_at: string;
  last_seen_at: string;
  analysis?: SkillLibraryAnalysis | null;
  sources: SkillLibraryArtifactSource[];
  files: SkillLibraryArtifactFile[];
}

export interface SkillLibraryBatchLookupItem {
  content_fingerprint: string;
  found: boolean;
  artifact_id?: string | null;
  analysis_status?: string | null;
  analysis_finished_at?: string | null;
  has_successful_analysis: boolean;
}

export interface SkillLibraryBatchLookupResponse {
  results: SkillLibraryBatchLookupItem[];
}

export interface ToolInfo {
  key: string;
  label: string;
  installed: boolean;
  skills_dir: string;
}

export interface ToolStatus {
  tools: ToolInfo[];
  installed: string[];
}

export interface MarketplaceSkillRecord {
  slug: string;
  name: string;
  owner_name: string;
  category?: string | null;
  description?: string | null;
  description_zh?: string | null;
  homepage?: string | null;
  version?: string | null;
  downloads: number;
  installs: number;
  stars: number;
  score: number;
  tags: string[];
  is_top_skill: boolean;
  top_rank?: number | null;
  remote_updated_at?: string | null;
  last_synced_at?: string | null;
  intelligence_source?: string | null;
  intelligence_verdict?: "clear" | "review" | "block" | null;
  intelligence_risk_level?: string | null;
  intelligence_score?: number | null;
  intelligence_traits: string[];
  intelligence_recommendations: string[];
  library_source?: string | null;
  library_verdict?: "clear" | "review" | "block" | null;
  library_risk_level?: string | null;
  library_score?: number | null;
  library_traits?: string[];
  library_recommendations?: string[];
}

export interface MarketplaceSkillMetadataSummary {
  source?: string | null;
  skill_key?: string | null;
  version_fingerprint?: string | null;
  slug?: string | null;
  owner_name?: string | null;
  homepage?: string | null;
  category?: string | null;
  downloads?: number | null;
  installs?: number | null;
  stars?: number | null;
  marketplace_score?: number | null;
  is_top_skill?: boolean | null;
  top_rank?: number | null;
  analysis_method?: string | null;
  score_system?: string | null;
  analysis_confidence?: number | null;
  recommendations?: string[];
  traits?: string[];
  category_result?: string | null;
  risk_level?: string | null;
  score_reason?: string | null;
}

export interface MarketplaceSkillAnalysisEvidence {
  path: string;
  reason: string;
  snippet?: string | null;
}

export interface MarketplaceSkillAnalysisSignature {
  instructions?: string | null;
  prompts_count?: number | null;
  tools_count?: number | null;
  resources_count?: number | null;
}

export interface MarketplaceSkillAnalysisSummary {
  source?: string | null;
  analysis_method?: string | null;
  score_system?: string | null;
  slug?: string | null;
  skill_key?: string | null;
  owner_name?: string | null;
  homepage?: string | null;
  library_risk_score?: number | null;
  library_verdict?: "clear" | "review" | "block" | null;
  library_risk_level?: string | null;
  analysis_confidence?: number | null;
  analysis_model?: string | null;
  analysis_version?: string | null;
  summary?: string | null;
  reasoning?: string | null;
  category?: string | null;
  category_result?: string | null;
  risk_level?: string | null;
  score_reason?: string | null;
  recommendations?: string[];
  traits?: string[];
  capabilities?: string[];
  suspicious_behaviors?: string[];
  trusted_signals?: string[];
  evidence?: MarketplaceSkillAnalysisEvidence[];
  signature?: MarketplaceSkillAnalysisSignature | null;
  snapshot_id?: string | null;
  bundle_hash?: string | null;
  declared_version?: string | null;
  archive_size?: number | null;
  file_count?: number | null;
  top_files?: string[];
}

export interface MarketplaceSkillSnapshot {
  id: string;
  source_type?: string | null;
  source_url?: string | null;
  declared_version?: string | null;
  source_revision?: string | null;
  bundle_hash?: string | null;
  fetch_status?: string | null;
  fetch_error?: string | null;
  archive_size?: number | null;
  file_count?: number | null;
  fetched_at?: string | null;
  analysis_status?: string | null;
  analysis_error?: string | null;
  analysis_version?: string | null;
  analysis_score_system?: string | null;
  analysis_method?: string | null;
  analysis_model?: string | null;
  analysis_confidence?: number | null;
  analysis_started_at?: string | null;
  analysis_finished_at?: string | null;
  version_fingerprint?: string | null;
  prompts_count?: number | null;
  tools_count?: number | null;
  resources_count?: number | null;
  library_risk_score?: number | null;
  library_verdict?: "clear" | "review" | "block" | null;
  library_risk_level?: string | null;
  analysis_summary?: MarketplaceSkillAnalysisSummary | null;
}

export interface MarketplaceSkillDetail extends MarketplaceSkillRecord {
  metadata_risk_score?: number | null;
  metadata_verdict?: "clear" | "review" | "block" | null;
  metadata_risk_level?: string | null;
  metadata_score_system?: string | null;
  metadata_analysis_method?: string | null;
  metadata_analysis_confidence?: number | null;
  metadata_analyzed_at?: string | null;
  metadata_summary?: MarketplaceSkillMetadataSummary | null;
  snapshot_count: number;
  latest_snapshot?: MarketplaceSkillSnapshot | null;
  snapshots: MarketplaceSkillSnapshot[];
}

export interface MarketplaceSkillsResponse {
  page: number;
  page_size: number;
  total: number;
  skills: MarketplaceSkillRecord[];
}

export interface MarketplaceCategory {
  slug: string;
  name: string;
  name_zh?: string | null;
  description?: string | null;
  sort_order: number;
  count: number;
}

export interface RuntimeSession {
  id: string;
  agent_name: string;
  source: string;
  workspace_path: string;
  started_at: string;
  ended_at?: string | null;
  source_updated_at?: string | null;
  status: string;
  risk_level: string;
  summary: string;
  duration_ms?: number | null;
  total_events: number;
  security_events: number;
  findings_count: number;
  model_calls: number;
  tool_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  avg_latency_ms: number;
}

export interface RuntimeEvent {
  id: number;
  session_id: string;
  event_type: string;
  event_time: string;
  severity: string;
  title: string;
  details_json: string;
}

export interface RuntimeToolStat {
  tool_name: string;
  total_calls: number;
  success_calls: number;
  failure_calls: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  last_called_at: string;
  session_count: number;
}

export interface RuntimeSecurityAlert {
  id: number;
  session_id: string;
  source: string;
  workspace_path: string;
  event_time: string;
  severity: string;
  title: string;
  alert_type: string;
  resource: string;
  action: string;
  blocked: boolean;
  reason: string;
  details_json: string;
}

export interface DesktopShellPreferences {
  enableSystemNotifications: boolean;
  enableForegroundRiskCard: boolean;
  hideToMenuBarOnClose: boolean;
}

export interface RuntimeRiskInboxState {
  latestAlert?: RuntimeSecurityAlert | null;
  pendingCount: number;
  latestPendingAlertId?: number | null;
  lastSeenAlertId?: number | null;
}

export interface RuntimeRiskFocusRequest {
  requestId?: string;
  sessionId: string;
  alertId: number;
  tab?: "alerts" | "blocked";
}

export interface DesktopShellOpenViewRequest {
  view: "runtime" | "settings";
}

export interface RuntimeGuardStatus {
  reachable: boolean;
  managed_by_desktop: boolean;
  pending_action?: string | null;
  base_url: string;
  bind_address: string;
  db_path?: string | null;
  started_at?: string | null;
  total_sessions: number;
  total_alerts: number;
  total_blocked: number;
  error?: string | null;
}

export interface CodexGuardAdapterStatus {
  detected: boolean;
  support_level: string;
  status: string;
  experimental_soft_stop_enabled: boolean;
  codex_home?: string | null;
  state_file?: string | null;
  session_index_present: boolean;
  guard_reachable: boolean;
  processed_events_total: number;
  processed_events_last_run: number;
  blocked_events_total: number;
  blocked_events_last_run: number;
  prompt_events_total: number;
  tool_call_events_total: number;
  output_events_total: number;
  soft_stop_attempts_total: number;
  soft_stop_attempts_last_run: number;
  soft_stop_success_total: number;
  soft_stop_success_last_run: number;
  last_checked_at?: string | null;
  last_synced_at?: string | null;
  last_blocked_event_at?: string | null;
  last_soft_stop_at?: string | null;
  last_soft_stop_result?: string | null;
  last_error?: string | null;
}

export interface RuntimeHostStatus {
  key: string;
  label: string;
  capability_level: string;
  status: string;
  detected: boolean;
  last_activity_at?: string | null;
  detail?: string | null;
}

export interface RuntimeGuardInterventionResult {
  supported: boolean;
  attempted: boolean;
  success: boolean;
  detail: string;
}

export interface RuntimeGuardExceptionRecord {
  id: number;
  scope: string;
  source: string;
  session_id?: string | null;
  policy_id: string;
  resource?: string | null;
  tool_name?: string | null;
  reason: string;
  created_at: string;
  remaining_matches?: number | null;
}

export interface RuntimeSessionInput {
  id: string;
  agent_name: string;
  source: string;
  workspace_path: string;
  started_at: string;
  ended_at?: string | null;
  status: string;
  risk_level: string;
  summary: string;
  duration_ms?: number | null;
}

export interface RuntimeEventInput {
  session_id: string;
  event_type: string;
  event_time: string;
  severity: string;
  title: string;
  details_json: string;
}

export interface RuntimeTelemetryBatchInput {
  session: RuntimeSessionInput;
  events: RuntimeEventInput[];
}

export interface RuntimeIngestConfig {
  health_url: string;
  running: boolean;
  otlp_logs_endpoint: string;
  otlp_traces_endpoint: string;
  otlp_metrics_endpoint: string;
}
