import { useState } from "react";
import type { ReactNode } from "react";
import { IssueRow, RiskCircle } from "../../shared/sharedUi";
import {
  DRAG_REGION_STYLE,
  InfoIcon,
  ShieldDetailIcon,
  ToolPolicyIcon,
  ToolQuarantineIcon,
  ToolReportIcon,
  ToolScanIcon,
  dirname,
  fileType,
  openRelatedFile,
} from "../../shared/shared";
import type { SkillReport } from "../../types";


export function DetailScreen({
  onBack,
  skill,
}: {
  onBack: () => void;
  skill: SkillReport | null;
}) {
  const findings = skill
    ? skill.files.flatMap((file) => file.findings.map((finding) => ({ ...finding, filePath: file.path })))
    : [];

  return (
    <main className="flex h-full flex-col overflow-hidden bg-white">
      <header className="border-b border-[#eef1f4] bg-white px-6 py-5">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <ShieldDetailIcon />
              <h1 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#8d97a4]">
                风险分析
              </h1>
            </div>
            <h2 className="text-[24px] font-bold text-[#2f3540]">
              {skill?.name ?? "未选择报告"}
            </h2>
          </div>
          <div className="flex flex-col items-center pr-2">
            <RiskCircle value={skill?.risk_score ?? 0} />
            <span className="mt-3 text-xs font-medium text-[#ea7a19]">高风险评分</span>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <section>
          <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-[#4b5563]">
            问题列表
            <span className="rounded-full bg-[#ffe4e6] px-2 py-0.5 text-[10px] uppercase text-[#ef4444]">
              紧急
            </span>
          </h3>
          <div className="space-y-3">
            {findings.length === 0 ? (
              <div className="rounded-md border border-[#eceff3] bg-[#fafbfc] p-3 text-sm text-[#8d97a4]">
                当前报告暂无记录的问题。
              </div>
            ) : (
              findings.slice(0, 6).map((finding, index) => (
                <IssueRow key={`${finding.rule_id}-${index}`} finding={finding} />
              ))
            )}
          </div>
        </section>

        <section className="mt-8">
          <h3 className="mb-3 text-sm font-bold text-[#4b5563]">关联文件</h3>
          <div className="overflow-hidden rounded border border-[#e5e7eb]">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#e5e7eb] bg-[#f9fafb] text-[#8d97a4]">
                <tr>
                  <th className="px-4 py-2 font-medium uppercase">文件名</th>
                  <th className="px-4 py-2 font-medium uppercase">路径</th>
                  <th className="px-4 py-2 font-medium uppercase">类型</th>
                </tr>
              </thead>
              <tbody>
                {skill?.files.length ? (
                  skill.files.map((file) => (
                    <tr key={file.path} className="border-t border-[#f1f3f6]">
                      <td className="px-4 py-2.5 font-medium text-[#2f76e9]">
                        <button
                          type="button"
                          onClick={() => void openRelatedFile(file.path)}
                          className="transition hover:text-[#215fbc]"
                        >
                          {file.path.split("/").pop()}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-[#7f8895]">{dirname(file.path)}</td>
                      <td className="px-4 py-2.5 text-[#b0b7c1]">{fileType(file.path)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} className="px-4 py-10 text-center text-[#9aa4b2]">
                      暂无关联文件。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <footer className="flex items-center justify-between border-t border-[#e5e7eb] bg-[#f9fafb] px-6 py-4">
        <div />
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded border border-[#d1d5db] bg-white px-6 py-2 text-sm font-medium text-[#374151] transition hover:bg-[#f9fafb]"
          >
            返回
          </button>
          <button className="rounded bg-[#ef4444] px-6 py-2 text-sm font-semibold text-white transition hover:bg-[#dc2626]">
            删除 Skill
          </button>
        </div>
      </footer>
    </main>
  );
}


export function ToolboxScreen({
  onOpenQuarantine,
  onRunRepositoryScan,
  quarantined,
}: {
  onOpenQuarantine: () => void;
  onRunRepositoryScan: (path?: string) => Promise<void>;
  quarantined: SkillReport[];
}) {
  const tools: Array<{
    key: "quarantine" | "scan" | "reports" | "policies";
    title: string;
    description: string;
    icon: ReactNode;
    badge?: string;
    onClick?: () => void;
  }> = [
    {
      key: "scan",
      title: "代码库扫描",
      description: "选择一个本地项目目录，用 AOS Core 扫描代码、MCP 配置和相关安全风险，并生成检测报告。",
      icon: <ToolScanIcon />,
      onClick: () => void onRunRepositoryScan(),
    },
    {
      key: "quarantine",
      title: "隔离区",
      description: "用于集中查看高风险项目并执行恢复或移除操作，当前版本暂未开放。",
      icon: <ToolQuarantineIcon />,
      badge: "即将推出",
    },
    {
      key: "reports",
      title: "报告导出",
      description: "整理最近扫描的摘要、发现和证据文件，作为后续能力预留。",
      icon: <ToolReportIcon />,
      badge: "即将推出",
    },
    {
      key: "policies",
      title: "策略中心",
      description: "统一管理扫描策略、自动处理规则和例外名单，作为后续能力预留。",
      icon: <ToolPolicyIcon />,
      badge: "即将推出",
    },
  ];

  return (
    <main className="flex h-full flex-col overflow-hidden bg-white">
      <header
        data-tauri-drag-region
        style={DRAG_REGION_STYLE}
        className="flex h-14 items-center border-b border-[#eef1f4] px-6"
      >
        <h1 className="text-sm font-semibold uppercase tracking-[0.04em] text-[#7b8491]">工具箱</h1>
        <div className="min-h-[40px] flex-1" data-tauri-drag-region style={DRAG_REGION_STYLE} />
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-8 py-8">
        <header className="flex items-start justify-between gap-6 border-b border-[#eef2f6] pb-7">
          <div>
            <h1 className="mt-2 text-[34px] font-semibold tracking-[-0.04em] text-[#243042]">安全工具集</h1>
            <p className="mt-3 max-w-[720px] text-[15px] leading-7 text-[#7d8c9f]">
              常用安全能力统一收纳在这里。你可以从这里快速发起代码库扫描，并查看后续即将开放的安全能力。
            </p>
          </div>
        </header>

        <section className="mt-8 grid grid-cols-2 gap-x-16 gap-y-14 pb-8">
          {tools.map((tool) => {
            const clickable = Boolean(tool.onClick);
            return (
              <button
                key={tool.key}
                type="button"
                onClick={tool.onClick}
                disabled={!clickable}
                className={`group flex items-start gap-5 rounded-[26px] p-2 text-left transition ${
                  clickable ? "hover:bg-[#f8fbff]" : "cursor-default"
                }`}
              >
                <div className="mt-1 flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-[22px] border border-[#e4e9f0] bg-white text-[#6f7782] shadow-[0_6px_18px_rgba(15,23,42,0.03)]">
                  {tool.icon}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <h2 className="text-[22px] font-semibold tracking-[-0.03em] text-[#2b313a]">{tool.title}</h2>
                    {tool.badge ? (
                      <span className="rounded-full bg-[#f1f4f8] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">
                        {tool.badge}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 max-w-[420px] text-[15px] leading-7 text-[#98a2b2]">{tool.description}</p>
                </div>
              </button>
            );
          })}
        </section>
      </div>
    </main>
  );
}
