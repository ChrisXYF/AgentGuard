import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ManagedSkill, ToolStatus } from "../types";

function isTauriRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(
    (window as { __TAURI__?: unknown }).__TAURI__ ||
      (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useSkillManager() {
  const [managedSkills, setManagedSkills] = useState<ManagedSkill[]>([]);
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
  const [centralRepoPath, setCentralRepoPath] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!isTauriRuntime()) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [skills, tools, centralPath] = await Promise.all([
        invoke<ManagedSkill[]>("get_managed_skills"),
        invoke<ToolStatus>("get_tool_status"),
        invoke<string>("get_central_repo_path"),
      ]);
      setManagedSkills(skills);
      setToolStatus(tools);
      setCentralRepoPath(centralPath);
    } catch (refreshError) {
      setError(toErrorMessage(refreshError));
      throw refreshError;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, []);

  const runMutation = async <T,>(task: () => Promise<T>) => {
    setLoading(true);
    setError(null);

    try {
      const result = await task();
      await refresh();
      return result;
    } catch (mutationError) {
      const message = toErrorMessage(mutationError);
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  return {
    centralRepoPath,
    clearError: () => setError(null),
    error,
    loading,
    managedSkills,
    refresh,
    toolStatus,
    deleteManagedSkill: (skillId: string) =>
      runMutation(() => invoke("delete_managed_skill", { skillId })),
    importGitSkill: (repoUrl: string, name?: string) =>
      runMutation(() => invoke<ManagedSkill>("import_git_skill", { repoUrl, name })),
    importLocalSkill: (sourcePath: string, name?: string) =>
      runMutation(() => invoke<ManagedSkill>("import_local_skill", { sourcePath, name })),
    syncSkillToTool: (skillId: string, toolId: string) =>
      runMutation(() => invoke<ManagedSkill>("sync_skill_to_tool", { skillId, toolId })),
    unsyncSkillFromTool: (skillId: string, toolId: string) =>
      runMutation(() => invoke<ManagedSkill>("unsync_skill_from_tool", { skillId, toolId })),
    updateManagedSkill: (skillId: string) =>
      runMutation(() => invoke<ManagedSkill>("update_managed_skill", { skillId })),
  };
}
