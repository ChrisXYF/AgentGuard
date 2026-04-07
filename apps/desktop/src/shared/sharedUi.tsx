import type { ReactNode } from "react";
import type { Finding } from "../types";
import { WarningIcon } from "./icons";

export function FooterMetric({
  className,
  delta,
  dot,
  emphasis,
  interactive,
  label,
  onClick,
  trend,
  value,
}: {
  className?: string;
  delta?: string;
  dot?: boolean;
  emphasis?: boolean;
  interactive?: boolean;
  label: string;
  onClick?: () => void;
  trend?: boolean;
  value: string;
}) {
  const Component = onClick ? "button" : "div";
  return (
    <Component
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`${className ?? ""} flex h-full flex-col justify-center border-r border-[#e5e7eb] px-6 text-left last:border-r-0 ${
        onClick ? "transition hover:bg-[#f5f9ff]" : ""
      }`}
    >
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[#a1a9b3]">
        {label}
      </p>
      <div className="flex min-w-0 items-center gap-2">
        {dot ? <span className="h-2 w-2 rounded-full bg-[#22c55e]" /> : null}
        <span className={`min-w-0 ${emphasis ? "text-lg font-semibold text-[#2f76e9]" : "text-[15px] font-medium text-[#4b5563]"}`}>
          {value}
        </span>
        {delta ? <span className="rounded bg-[#eafaf0] px-1 text-[10px] text-[#16a34a]">{delta}</span> : null}
        {trend ? <span className="text-[#60a5fa]">↗</span> : null}
        {interactive ? <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.08em] text-[#2f76e9]">Open</span> : null}
      </div>
    </Component>
  );
}

export function DashboardScoreMetric({ value }: { value: number | null }) {
  return (
    <div className="flex h-full min-w-0 items-center justify-between gap-4 border-r border-[#e5e7eb] px-6">
      <div className="min-w-0 flex flex-col">
        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#a1a9b3]">
          安全评分
        </p>
        <p className="mt-2 text-[15px] font-medium text-[#4b5563]">{formatSecurityScoreValue(value)}</p>
      </div>
      <DashboardScoreCircle value={value} compact />
    </div>
  );
}

export function DashboardScoreCircle({ compact = false, value }: { compact?: boolean; value: number | null }) {
  const appearance = value === null
    ? {
        ringClass: "border-[#e8edf5]",
        textClass: "text-[#b4bfcd]",
      }
    : getSecurityScoreAppearance(value);

  return (
    <div className={`flex flex-col items-center ${compact ? "" : "w-[182px] rounded-[30px] border border-[#edf1f6] bg-white px-7 py-7 shadow-[0_10px_24px_rgba(18,32,56,0.04)]"}`}>
      <div
        className={`flex items-center justify-center rounded-full bg-white ${compact ? "h-[78px] w-[78px] border-[7px]" : "h-[116px] w-[116px] border-[8px]"} ${appearance.ringClass}`}
      >
        <span className={`${compact ? "text-[20px]" : "text-[24px]"} font-semibold tracking-[-0.04em] ${appearance.textClass}`}>
          {value ?? "—"}
        </span>
      </div>
    </div>
  );
}

export function RiskCircle({ value }: { value: number }) {
  return (
    <div className="relative flex h-[124px] w-[124px] items-center justify-center">
      <div className="absolute inset-0 rounded-full border-[6px] border-[#f1f3f6]" />
      <span className="relative text-4xl font-semibold tracking-[-0.03em] text-[#ea7a19]">{value}</span>
    </div>
  );
}

export function IssueRow({ finding }: { finding: Finding & { filePath: string } }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-[#f4d7d7] bg-[#fff9f9] px-4 py-3">
      <div className="mt-0.5 text-[#ef4444]">
        <WarningIcon />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-[#3d4653]">{finding.description}</div>
        <div className="mt-1 text-xs text-[#9aa3ae]">
          {finding.filePath}:{finding.line}
        </div>
        {finding.snippet ? (
          <pre className="mt-3 overflow-x-auto rounded-xl bg-white px-3 py-2 text-xs text-[#657387]">
            {finding.snippet}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function getSecurityScoreAppearance(value: number) {
  if (value >= 80) {
    return {
      label: "受保护",
      ringClass: "border-[#d9f4e4]",
      textClass: "text-[#1f9d55]",
    };
  }

  if (value >= 60) {
    return {
      label: "稳定",
      ringClass: "border-[#dbe9ff]",
      textClass: "text-[#2f76e9]",
    };
  }

  if (value >= 40) {
    return {
      label: "需关注",
      ringClass: "border-[#ffe6bf]",
      textClass: "text-[#dd8a12]",
    };
  }

  return {
    label: "高风险",
    ringClass: "border-[#ffd6d8]",
    textClass: "text-[#e0525d]",
  };
}

function formatSecurityScoreValue(value: number | null) {
  return value === null ? "未扫描" : `${value} 分`;
}
