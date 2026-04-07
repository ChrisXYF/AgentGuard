import type { SkillReport } from "../types";
import { SeverityBadge } from "./SeverityBadge";

export function SkillCard({ report }: { report: SkillReport }) {
  return (
    <article className="rounded-[28px] border border-white/10 bg-white/5 p-6 shadow-glow backdrop-blur">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
            Skill Result
          </p>
          <h3 className="mt-2 font-display text-2xl text-white">{report.name}</h3>
          <p className="mt-2 text-sm text-slate-400">{report.path}</p>
        </div>

        <div className="flex items-center gap-4">
          <div className="rounded-2xl border border-pulse/30 bg-pulse/10 px-4 py-3 text-right">
            <p className="text-xs uppercase tracking-[0.2em] text-pulse/80">
              Risk Score
            </p>
            <p className="font-display text-3xl text-pulse">{report.risk_score}</p>
          </div>
          <SeverityBadge category={report.category} />
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <section>
          <p className="text-sm font-semibold text-slate-200">Flags</p>
          {report.flags.length === 0 ? (
            <div className="mt-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
              No suspicious patterns were triggered for this skill.
            </div>
          ) : (
            <ul className="mt-3 space-y-2 text-sm text-slate-300">
              {report.flags.map((flag) => (
                <li
                  key={flag}
                  className="rounded-2xl border border-white/8 bg-black/10 px-4 py-3"
                >
                  {flag}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <p className="text-sm font-semibold text-slate-200">Evidence</p>
          {report.files.length === 0 ? (
            <div className="mt-3 rounded-2xl border border-white/8 bg-slate-950/50 px-4 py-3 text-sm text-slate-400">
              No flagged files for this skill.
            </div>
          ) : (
            <div className="mt-3 space-y-4">
              {report.files.map((file) => (
                <div
                  key={file.path}
                  className="rounded-2xl border border-white/8 bg-slate-950/50 p-4"
                >
                  <div className="flex items-center justify-between gap-4">
                    <p className="truncate text-sm text-slate-200">{file.path}</p>
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400">
                      {file.risk_score}
                    </span>
                  </div>
                  <ul className="mt-3 space-y-3">
                    {file.findings.map((finding) => (
                      <li key={`${finding.rule_id}-${finding.line}`}>
                        <p className="text-sm font-medium text-white">{finding.title}</p>
                        <p className="text-xs text-slate-400">
                          Line {finding.line} • {finding.description}
                        </p>
                        {finding.snippet ? (
                          <pre className="mt-2 overflow-x-auto rounded-xl border border-white/60 bg-white/95 p-3 text-xs text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                            <code>{finding.snippet}</code>
                          </pre>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </article>
  );
}
