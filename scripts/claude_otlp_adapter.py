#!/usr/bin/env python3

import argparse
import json
import sys
import time
import urllib.error
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from runtime_otlp_common import (
    LOGS_ENDPOINT,
    TRACES_ENDPOINT,
    build_logs_payload,
    build_traces_payload,
    coerce_iso_timestamp,
    compute_duration_ms,
    flatten_text,
    load_state,
    log_record,
    post_json,
    save_state,
    span_record,
)


@dataclass
class ClaudeSessionEntry:
    session_id: str
    path: Path
    updated_at: str
    workspace_path: str


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge Claude Code local sessions into AOS Activity Monitor via OTLP JSON.")
    parser.add_argument("--logs-endpoint", default=LOGS_ENDPOINT)
    parser.add_argument("--traces-endpoint", default=TRACES_ENDPOINT)
    parser.add_argument("--state-file", default=str(Path("data") / "claude_otlp_state.json"))
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--interval", type=float, default=10.0)
    args = parser.parse_args()

    state_file = Path(args.state_file).expanduser()
    state = load_state(state_file)

    if args.watch:
        while True:
            sync_once(state_file, state, args.limit, args.logs_endpoint, args.traces_endpoint)
            time.sleep(args.interval)
    else:
        sync_once(state_file, state, args.limit, args.logs_endpoint, args.traces_endpoint)
    return 0


def sync_once(
    state_file: Path,
    state: dict[str, dict[str, Any]],
    limit: int,
    logs_endpoint: str,
    traces_endpoint: str,
) -> None:
    entries = read_session_entries()
    entries.sort(key=lambda item: item.updated_at, reverse=True)

    changed: list[ClaudeSessionEntry] = []
    for entry in entries:
        saved = state.get(entry.session_id)
        if saved and saved.get("updated_at") == entry.updated_at:
            continue
        changed.append(entry)
        if len(changed) >= limit:
            break

    if not changed:
        print("no changed claude sessions")
        return

    for entry in changed:
        lines = entry.path.read_text(encoding="utf-8").splitlines()
        saved = state.get(entry.session_id) or {}
        start_index = int(saved.get("line_count") or 0)
        if start_index < 0 or start_index > len(lines):
            start_index = 0

        parsed = parse_session(entry, lines, start_index)
        state[entry.session_id] = {
            "line_count": len(lines),
            "updated_at": entry.updated_at,
            "path": entry.path.as_posix(),
        }
        if parsed is None:
            continue

        logs_payload, traces_payload = parsed
        if logs_payload["resourceLogs"][0]["scopeLogs"][0]["logRecords"]:
            post_json(logs_endpoint, logs_payload)
        if traces_payload["resourceSpans"][0]["scopeSpans"][0]["spans"]:
            post_json(traces_endpoint, traces_payload)
        print(f"synced {entry.session_id}")

    save_state(state_file, state)


def read_session_entries() -> list[ClaudeSessionEntry]:
    entries: list[ClaudeSessionEntry] = []
    for root in candidate_roots():
        if not root.exists():
            continue
        for path in root.rglob("*.jsonl"):
            updated_at = coerce_iso_timestamp(path.stat().st_mtime)
            session_id = path.stem
            entries.append(
                ClaudeSessionEntry(
                    session_id=session_id,
                    path=path,
                    updated_at=updated_at,
                    workspace_path=infer_workspace_path(root, path),
                )
            )
    return entries


def candidate_roots() -> list[Path]:
    home = Path.home()
    return [
        home / ".claude" / "projects",
        home / ".config" / "claude" / "projects",
    ]


def infer_workspace_path(root: Path, path: Path) -> str:
    try:
        relative_parent = path.parent.relative_to(root)
    except ValueError:
        return path.parent.as_posix()

    flattened = relative_parent.as_posix().strip("/")
    if not flattened:
        return path.parent.as_posix()
    if flattened.startswith("-"):
        candidate = "/" + flattened[1:].replace("-", "/")
        return candidate
    return path.parent.as_posix()


def parse_session(
    entry: ClaudeSessionEntry,
    lines: list[str],
    start_index: int,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    session_id = f"claude-{entry.session_id}"
    logs: list[dict[str, Any]] = []
    spans: list[dict[str, Any]] = []
    last_user_at: str | None = None

    for index, line in enumerate(lines):
        if index < start_index or not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue

        record_type = str(record.get("type") or "").lower()
        timestamp = coerce_iso_timestamp(record.get("timestamp"), fallback=entry.updated_at)
        message = record.get("message") if isinstance(record.get("message"), dict) else {}

        if record_type == "user":
            prompt = flatten_text(message.get("content")) or flatten_text(message.get("text")) or flatten_text(record.get("text"))
            logs.append(
                log_record(
                    timestamp,
                    "INFO",
                    prompt or "Claude user prompt",
                    {
                        "session_id": session_id,
                        "event.name": "user_prompt",
                        "prompt": prompt,
                        "prompt_length": len(prompt),
                    },
                )
            )
            last_user_at = timestamp
            continue

        if record_type == "assistant":
            usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
            model = message.get("model") or record.get("model") or "unknown"
            body = flatten_text(message.get("content")) or flatten_text(message.get("text")) or flatten_text(record.get("content"))
            input_tokens = int(usage.get("input_tokens") or usage.get("inputTokens") or 0)
            output_tokens = int(usage.get("output_tokens") or usage.get("outputTokens") or 0)
            cached_tokens = int(usage.get("cache_read_input_tokens") or usage.get("cacheReadInputTokens") or 0)
            latency_ms = compute_duration_ms(last_user_at, timestamp) if last_user_at else 0
            logs.append(
                log_record(
                    timestamp,
                    "INFO",
                    body or f"Claude response from {model}",
                    {
                        "session_id": session_id,
                        "event.name": "claude.api_response",
                        "model": model,
                        "input_token_count": input_tokens,
                        "output_token_count": output_tokens,
                        "cached_input_tokens": cached_tokens,
                        "duration_ms": latency_ms,
                    },
                )
            )
            if latency_ms > 0:
                spans.append(
                    span_record(
                        session_id=session_id,
                        span_name="model.inference",
                        start_time=last_user_at,
                        end_time=timestamp,
                        attributes={
                            "session_id": session_id,
                            "model": model,
                            "gen_ai.usage.input_tokens": input_tokens,
                            "gen_ai.usage.output_tokens": output_tokens,
                        },
                    )
                )
            continue

        if record_type in {"tool", "tool_use", "tool_result"}:
            tool_name = record.get("tool_name") or record.get("name") or flatten_text(message.get("name")) or "tool"
            logs.append(
                log_record(
                    timestamp,
                    "INFO",
                    flatten_text(record.get("content")) or flatten_text(message.get("content")) or f"Claude tool call: {tool_name}",
                    {
                        "session_id": session_id,
                        "event.name": "claude.tool_call",
                        "tool_name": tool_name,
                        "status": str(record.get("status") or "completed").lower(),
                    },
                )
            )

    if not logs and not spans:
        return None

    return (
        build_logs_payload("claude-code", entry.workspace_path, "claude_runtime", logs),
        build_traces_payload("claude-code", entry.workspace_path, "claude_runtime", spans),
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8"), file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError as error:
        print(f"request failed: {error}", file=sys.stderr)
        raise SystemExit(1)
