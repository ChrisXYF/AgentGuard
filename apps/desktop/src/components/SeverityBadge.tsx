import type { RiskCategory } from "../types";

const badgeMap: Record<RiskCategory, string> = {
  safe: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  suspicious: "border-amber-400/30 bg-amber-400/10 text-amber-100",
  high_risk: "border-orange-400/30 bg-orange-400/10 text-orange-100",
  malicious: "border-rose-500/40 bg-rose-500/10 text-rose-100",
};

const labelMap: Record<RiskCategory, string> = {
  safe: "Safe",
  suspicious: "Suspicious",
  high_risk: "High Risk",
  malicious: "Malicious",
};

export function SeverityBadge({ category }: { category: RiskCategory }) {
  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] ${badgeMap[category]}`}
    >
      {labelMap[category]}
    </span>
  );
}
