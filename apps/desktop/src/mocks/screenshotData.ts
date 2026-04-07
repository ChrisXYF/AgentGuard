import type { SkillReport } from "../types";

export const SCREENSHOT_SKILLS: SkillReport[] = [
  {
    name: "remotion-best-practices",
    path: "/Users/test/.agents/skills/remotion-best-practices",
    risk_score: 92,
    category: "malicious",
    flags: ["External network request", "Sensitive credential access"],
    files: [
      {
        path: "/Users/test/.agents/skills/remotion-best-practices/rules/voiceover.md",
        risk_score: 60,
        category: "high_risk",
        findings: [
          {
            rule_id: "NET001",
            title: "NET001",
            description: "检测到向外发送数据的网络请求",
            category: "critical",
            severity: 35,
            file: "/Users/test/.agents/skills/remotion-best-practices/rules/voiceover.md",
            line: 31,
            snippet: "const response = await fetch(staticFile(\"captions123.json\"));",
          },
          {
            rule_id: "FILE001",
            title: "FILE001",
            description: "尝试访问敏感文件",
            category: "critical",
            severity: 35,
            file: "/Users/test/.agents/skills/remotion-best-practices/rules/voiceover.md",
            line: 36,
            snippet: "process.env.ELEVENLABS_API_KEY",
          },
        ],
      },
    ],
  },
  {
    name: "find-skills",
    path: "/Users/test/.agents/skills/find-skills",
    risk_score: 8,
    category: "safe",
    flags: [],
    files: [
      {
        path: "/Users/test/.agents/skills/find-skills/SKILL.md",
        risk_score: 8,
        category: "safe",
        findings: [],
      },
    ],
  },
];

export const SCREENSHOT_DATA = {
  summary: {
    scanned_roots: ["~/.agents/skills", "~/.cline/plugins"],
    scanned_skills: 2,
    scanned_mcps: 1,
    scanned_agents: 1,
    scanned_components: 4,
    findings: 6,
    skill_findings: 4,
    mcp_findings: 1,
    agent_findings: 1,
    backend: "local-discovery",
    generated_at: "2026-03-14T01:45:45Z",
  },
  results: SCREENSHOT_SKILLS,
  mcp_results: [],
  agent_results: [],
};
