import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import {
  DRAG_REGION_STYLE,
  NO_DRAG_REGION_STYLE,
  basename,
  dirname,
  fileType,
  openLocalPath,
} from "../../shared/shared";

/* ─────────────────────── Types ─────────────────────── */

type OutlineItem = { id: string; level: number; text: string };
type FrontmatterEntry = { key: string; multiline: boolean; value: string };

function extractOutline(md: string) {
  const headings: OutlineItem[] = [];
  let index = 0;
  let fence = false;
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      headings.push({
        id: `md-outline-${index}`,
        level: m[1].length,
        text: m[2].replace(/[`*_~]/g, "").trim(),
      });
      index += 1;
    }
  }
  return headings;
}

function normVal(v: string) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
}

function fmtLabel(key: string) {
  return key.replace(/[_-]+/g, " ").trim();
}

function extractFrontmatter(md: string) {
  const n = md.replace(/\r\n/g, "\n");
  if (!n.startsWith("---\n")) return { body: n, frontmatter: [] as FrontmatterEntry[] };
  const lines = n.split("\n");
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") {
      close = i;
      break;
    }
  }
  if (close === -1) return { body: n, frontmatter: [] as FrontmatterEntry[] };
  const fm: FrontmatterEntry[] = [];
  let curKey: string | null = null;
  let curVal: string[] = [];
  const push = () => {
    if (!curKey) return;
    const raw = curVal.join("\n").trim();
    fm.push({ key: curKey, multiline: raw.includes("\n"), value: normVal(raw) });
    curKey = null;
    curVal = [];
  };
  for (const line of lines.slice(1, close)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && !line.startsWith(" ") && !line.startsWith("\t")) {
      push();
      curKey = m[1];
      curVal = m[2] ? [m[2]] : [];
      continue;
    }
    if (curKey) curVal.push(line);
  }
  push();
  if (!fm.length)
    fm.push({ key: "metadata", multiline: true, value: lines.slice(1, close).join("\n").trim() });
  return { body: lines.slice(close + 1).join("\n").replace(/^\n+/, ""), frontmatter: fm };
}

function countCodeBlocks(md: string) {
  return Math.floor((md.match(/^```/gm)?.length ?? 0) / 2);
}

function readMins(md: string) {
  const latin = md.match(/[A-Za-z0-9_./-]+/g)?.length ?? 0;
  const cjk = md.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const total = latin + cjk;
  return total === 0 ? 0 : Math.max(1, Math.ceil(total / 240));
}

/* ─────────────────────── Icons ─────────────────────── */

function DocIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 2.5h10a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M5 5.5h6M5 8h4M5 10.5h5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MetaIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path d="M3.5 4h5M3.5 6h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M8.5 3L4.5 7l4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M5.5 3l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M3 5.5 7 9l4-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ─────────────────────── Main component ─────────────────────── */

export function MarkdownPreviewScreen({
  markdownPath,
  onClose: _onClose,
}: {
  markdownPath: string | null;
  onClose: () => void;
}) {
  const articleRef = useRef<HTMLElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!markdownPath) {
      setContent("");
      setError("\u672A\u627E\u5230 Markdown \u6587\u4EF6\u8DEF\u5F84\u3002");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setError(null);
    setContent("");

    void invoke<string>("read_markdown_file", { path: markdownPath })
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [markdownPath]);

  const parsed = useMemo(() => extractFrontmatter(content), [content]);
  const body = parsed.body;
  const fm = parsed.frontmatter;
  const html = useMemo(
    () => (body ? (marked.parse(body, { async: false, breaks: true, gfm: true }) as string) : ""),
    [body],
  );
  const outline = useMemo(() => extractOutline(body), [body]);
  const lineCount = useMemo(
    () => (body ? body.replace(/\r\n/g, "\n").split("\n").length : 0),
    [body],
  );
  const codeBlocks = useMemo(() => countCodeBlocks(body), [body]);
  const minutes = useMemo(() => readMins(body), [body]);
  const chars = useMemo(() => body.replace(/\s+/g, "").length, [body]);
  const dir = markdownPath ? dirname(markdownPath) : null;
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const headings = Array.from(article.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
    headings.forEach((heading, index) => {
      const id = outline[index]?.id;
      if (!id) {
        heading.removeAttribute("id");
        heading.removeAttribute("data-outline-id");
        return;
      }
      heading.id = id;
      heading.dataset.outlineId = id;
    });
  }, [outline, html]);

  const scrollToOutlineItem = (item: OutlineItem) => {
    const container = contentScrollRef.current;
    const article = articleRef.current;
    if (!container || !article) return;
    const target = article.querySelector<HTMLElement>(`[data-outline-id="${item.id}"]`);
    if (!target) return;
    const top = container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
    container.scrollTo({ behavior: "smooth", top: Math.max(0, top) });
  };

  const statusLabel = loading
    ? "\u52A0\u8F7D\u4E2D"
    : error
      ? "\u8BFB\u53D6\u5931\u8D25"
      : !body.trim()
        ? "\u7A7A\u6587\u6863"
        : null;
  const statusTone = loading
    ? "border-[#d0daf0] bg-[#eef3ff] text-[#4b8bf5]"
    : error
      ? "border-[#fdd] bg-[#fff1f1] text-[#e53e3e]"
      : "border-[#d0e8d8] bg-[#eef7f1] text-[#18824c]";

  /* ─────────────────────── Render ─────────────────────── */

  return (
    <main className="relative h-screen overflow-hidden bg-[#f7f9fc] text-[#1f2937]">
      <div
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-20 h-10 select-none"
        style={DRAG_REGION_STYLE}
      />
      <div className="flex h-full flex-col">
        {/* Header */}
        <header
          data-tauri-drag-region
          className="border-b border-[#e8edf4] bg-white pl-20 pr-5"
          style={DRAG_REGION_STYLE}
        >
          <div className="flex h-[56px] items-center justify-between gap-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#eef3ff] text-[#4b8bf5]">
                <DocIcon />
              </div>
              <h1 className="truncate text-[15px] font-semibold text-[#243042]">
                {markdownPath ? basename(markdownPath) : "\u672A\u547D\u540D\u6587\u4EF6"}
              </h1>
              {statusLabel ? (
                <span
                  className={`inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-[10px] font-semibold ${statusTone}`}
                >
                  {statusLabel}
                </span>
              ) : null}
              <span className="hidden truncate text-[12px] text-[#8ea0b6] sm:block">
                {dir ?? ""}
              </span>
            </div>
            <div
              className="flex shrink-0 items-center gap-2"
              data-window-drag-disabled="true"
              style={NO_DRAG_REGION_STYLE}
            >
              {dir ? (
                <button
                  type="button"
                  onClick={() => void openLocalPath(dir)}
                  className="inline-flex h-8 items-center rounded-lg border border-[#dbe3ee] bg-white px-3 text-[12px] font-medium text-[#516072] transition hover:border-[#c8d5e4] hover:text-[#4b8bf5]"
                >
                  {"\u6253\u5F00\u76EE\u5F55"}
                </button>
              ) : null}
            </div>
          </div>
        </header>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full">
            {/* Content */}
            <section className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <div ref={contentScrollRef} className="hover-scrollbar h-full overflow-auto px-6 py-5">
                <div className="mx-auto max-w-[820px] space-y-5">
                  {/* Frontmatter */}
                  {fm.length > 0 ? (
                    <section className="rounded-2xl border border-[#e4eaf2] bg-white p-5 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
                      <div className="mb-3 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2">
                          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#f0f4ff] text-[#4b8bf5]">
                            <MetaIcon />
                          </div>
                          <span className="text-[13px] font-semibold text-[#344256]">
                            {"\u5143\u6570\u636E"}
                          </span>
                        </div>
                        <span className="rounded-full bg-[#f0f4ff] px-2 py-0.5 text-[10px] font-semibold text-[#4b8bf5]">
                          {fm.length} {"\u9879"}
                        </span>
                      </div>
                      <dl className="grid gap-2 sm:grid-cols-2">
                        {fm.map((e) => (
                          <div
                            key={e.key}
                            className="rounded-xl border border-[#eef2f7] bg-[#fafbfd] px-3.5 py-2.5"
                          >
                            <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8ea0b6]">
                              {fmtLabel(e.key)}
                            </dt>
                            <dd
                              className={`mt-1 text-[13px] leading-5 text-[#344256] ${e.multiline ? "whitespace-pre-wrap" : "break-words"}`}
                            >
                              {e.value || "\u2014"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  ) : null}

                  {/* Body */}
                  <div
                    className="prose prose-sm max-w-none prose-headings:font-semibold prose-a:text-[#4b8bf5] prose-a:no-underline hover:prose-a:underline prose-code:rounded prose-code:bg-[#f1f5f9] prose-code:px-1.5 prose-code:py-0.5 prose-code:font-mono prose-code:font-medium prose-code:text-[#ef4444] prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-[#e2e8f0] prose-pre:bg-[#f8fafc] prose-pre:text-[#334155] prose-img:rounded-lg"
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                </div>
              </div>
            </section>

            {/* Right panel */}
            <aside
              className={`min-h-0 shrink-0 overflow-hidden border-l border-[#e8edf4] bg-white transition-[width] duration-200 ease-in-out ${collapsed ? "w-[48px]" : "w-[320px]"}`}
            >
              {collapsed ? (
                <div className="flex h-full flex-col items-center py-4 gap-4">
                  <button
                    type="button"
                    onClick={() => setCollapsed(false)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#7b8ca1] transition hover:bg-[#f0f4fa] hover:text-[#4b8bf5]"
                    aria-label={"\u5C55\u5F00\u5BFC\u8BFB\u9762\u677F"}
                  >
                    <ChevronLeft />
                  </button>
                  <div
                    className="text-[10px] font-semibold tracking-[0.14em] text-[#9aa8ba]"
                    style={{ writingMode: "vertical-rl" }}
                  >
                    {"\u6587\u6863\u5BFC\u8BFB"}
                  </div>
                </div>
              ) : (
                <div className="hover-scrollbar flex h-full flex-col overflow-auto">
                  {/* Panel header */}
                  <div className="flex items-center justify-between border-b border-[#eef2f7] px-4 py-3">
                    <span className="text-[12px] font-semibold text-[#516072]">
                      {"\u6587\u6863\u5BFC\u8BFB"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCollapsed(true)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[#7b8ca1] transition hover:bg-[#f0f4fa] hover:text-[#4b8bf5]"
                    >
                      <ChevronRight />
                    </button>
                  </div>

                  <div className="flex-1 space-y-px">
                    {/* Stats */}
                    <div className="grid grid-cols-4 border-b border-[#eef2f7]">
                      {[
                        { val: outline.length, label: "\u7AE0\u8282" },
                        { val: codeBlocks, label: "\u4EE3\u7801\u5757" },
                        { val: lineCount, label: "\u884C\u6570" },
                        { val: minutes || "--", label: "\u5206\u949F" },
                      ].map((s) => (
                        <div key={s.label} className="px-2 py-3 text-center">
                          <div className="text-[16px] font-bold text-[#243042]">{s.val}</div>
                          <div className="text-[10px] text-[#9aa8ba]">{s.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Doc info */}
                    <div className="border-b border-[#eef2f7] px-4 py-3">
                      <div className="text-[12px] font-semibold text-[#344256]">
                        {markdownPath ? basename(markdownPath) : "\u672A\u547D\u540D\u6587\u4EF6"}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-[#8ea0b6]">
                        <span>{markdownPath ? fileType(markdownPath) : "Markdown"}</span>
                        <span>&middot;</span>
                        <span>
                          {chars} {"\u5B57\u7B26"}
                        </span>
                        {fm.length > 0 ? (
                          <>
                            <span>&middot;</span>
                            <span>
                              {fm.length} {"\u9879\u5143\u6570\u636E"}
                            </span>
                          </>
                        ) : null}
                      </div>
                      {dir ? (
                        <div
                          className="mt-1.5 truncate font-mono text-[10px] text-[#9aa8ba]"
                          title={dir}
                        >
                          {dir}
                        </div>
                      ) : null}
                    </div>
                    {/* TOC */}
                    <div className="px-4 py-3">
                      <div className="text-[11px] font-semibold text-[#516072]">
                        {"\u76EE\u5F55\u63D0\u7EB2"}
                      </div>
                      {outline.length === 0 ? (
                        <div className="mt-2 text-[11px] text-[#9aa8ba]">
                          {"\u65E0\u6807\u9898\u5C42\u7EA7"}
                        </div>
                      ) : (
                        <div className="mt-2 space-y-0.5">
                          {outline.slice(0, 30).map((item, i) => (
                            <button
                              key={`${item.text}-${i}`}
                              type="button"
                              onClick={() => scrollToOutlineItem(item)}
                              title={item.text}
                              className="block w-full truncate rounded-md px-2 py-1 text-left text-[11px] text-[#516072] transition hover:bg-[#f0f4fa] hover:text-[#344256]"
                              style={{
                                paddingLeft: `${Math.min((item.level - 1) * 12 + 8, 44)}px`,
                              }}
                            >
                              {item.text}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>
    </main>
  );
}
