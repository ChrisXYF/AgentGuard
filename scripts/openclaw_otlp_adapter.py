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
    read_json,
    save_state,
    span_record,
)


@dataclass
class OpenClawSessionEntry:
    session_id: str
    session_file: Path
    updated_at: str
    workspace_path: str


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge OpenClaw local sessions into AOS Activity Monitor via OTLP JSON.")
    parser.add_argument("--logs-endpoint", default=LOGS_ENDPOINT)
    parser.add_argument("--traces-endpoint", default=TRACES_ENDPOINT)
    parser.add_argument("--state-file", default=str(Path("data") / "openclaw_otlp_state.json"))
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

    changed: list[OpenClawSessionEntry] = []
    for entry in entries:
        saved = state.get(entry.session_id)
        if saved and saved.get("updated_at") == entry.updated_at:
            continue
        changed.append(entry)
        if len(changed) >= limit:
            break

    if not changed:
        print("no changed openclaw sessions")
        return

    for entry in changed:
        lines = entry.session_file.read_text(encoding="utf-8").splitlines()
        saved = state.get(entry.session_id) or {}
        start_index = int(saved.get("line_count") or 0)
        if start_index < 0 or start_index > len(lines):
            start_index = 0

        parsed = parse_session(entry, lines, start_index)
        state[entry.session_id] = {
            "line_count": len(lines),
            "updated_at": entry.updated_at,
            "path": entry.session_file.as_posix(),
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


def read_session_entries() -> list[OpenClawSessionEntry]:
    entries: list[OpenClawSessionEntry] = []
    seen_files: set[str] = set()
    for root in candidate_roots():
        if not root.exists():
            continue
        for index_path in root.rglob("sessions.json"):
            raw = read_json(index_path, {})
            if not isinstance(raw, dict):
                continue
            for value in raw.values():
                if not isinstance(value, dict):
                    continue
                session_id = value.get("sessionId")
                session_file_value = value.get("sessionFile")
                if not isinstance(session_id, str) or not session_id or not isinstance(session_file_value, str):
                    continue
                session_file = Path(session_file_value).expanduser()
                if not session_file.exists():
                    session_file = index_path.parent.joinpath(Path(session_file_value).name)
                    if not session_file.exists():
                        continue
                normalized = session_file.as_posix()
                if normalized in seen_files:
                    continue
                seen_files.add(normalized)
                entries.append(
                    OpenClawSessionEntry(
                        session_id=session_id,
                        session_file=session_file,
                        updated_at=coerce_iso_timestamp(session_file.stat().st_mtime),
                        workspace_path=infer_workspace_path(root, session_file),
                    )
                )
    return entries


def candidate_roots() -> list[Path]:
    home = Path.home()
    return [
        home / ".openclaw",
        home / ".clawdbot",
        home / ".moltbot",
        home / ".moldbot",
    ]


def infer_workspace_path(root: Path, session_file: Path) -> str:
    for part in session_file.parents:
        if part.name == "sessions":
            return part.parent.as_posix()
    return root.as_posix()


def parse_session(
    entry: OpenClawSessionEntry,
    lines: list[str],
    start_index: int,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    session_id = f"openclaw-{entry.session_id}"
    logs: list[dict[str, Any]] = []
    spans: list[dict[str, Any]] = []
    current_model = "unknown"
    current_provider = "unknown"
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
        if record_type == "model_change":
            current_provider = str(record.get("provider") or current_provider)
            current_model = str(record.get("modelId") or record.get("model") or current_model)
            continue

        if record_type == "message":
            message = record.get("message") if isinstance(record.get("message"), dict) else {}
            role = str(message.get("role") or record.get("role") or "").lower()
            timestamp = coerce_iso_timestamp(message.get("timestamp") or record.get("timestamp"), fallback=entry.updated_at)
            if role == "user":
                prompt = flatten_text(message.get("content")) or flatten_text(message.get("parts")) or flatten_text(message.get("text"))
                logs.append(
                    log_record(
                        timestamp,
                        "INFO",
                        prompt or "OpenClaw user prompt",
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

            if role == "assistant":
                usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
                model = message.get("modelId") or record.get("modelId") or current_model
                provider = message.get("provider") or record.get("provider") or current_provider
                body = flatten_text(message.get("content")) or flatten_text(message.get("parts")) or flatten_text(message.get("text"))
                latency_ms = compute_duration_ms(last_user_at, timestamp) if last_user_at else 0
                input_tokens = int(usage.get("input") or usage.get("inputTokens") or 0)
                output_tokens = int(usage.get("output") or usage.get("outputTokens") or 0)
                cached_tokens = int(usage.get("cacheRead") or ((usage.get("cache") or {}).get("read")) or 0)
                cost_total = usage.get("cost")
                if isinstance(cost_total, dict):
                    cost_total = cost_total.get("total")
                logs.append(
                    log_record(
                        timestamp,
                        "INFO",
                        body or f"OpenClaw response from {provider}/{model}",
                        {
                            "session_id": session_id,
                            "event.name": "openclaw.api_response",
                            "provider": provider,
                            "model": model,
                            "input_token_count": input_tokens,
                            "output_token_count": output_tokens,
                            "cached_input_tokens": cached_tokens,
                            "cost_usd": float(cost_total or 0.0),
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
                                "cost_usd": float(cost_total or 0.0),
                            },
                        )
                    )
                continue

        if record_type in {"tool", "tool_call", "tool_result"}:
            timestamp = coerce_iso_timestamp(record.get("timestamp"), fallback=entry.updated_at)
            tool_name = record.get("toolName") or record.get("tool_name") or record.get("name") or "tool"
            status = str(record.get("status") or "completed").lower()
            logs.append(
                log_record(
                    timestamp,
                    "WARN" if status in {"error", "failed", "cancelled"} else "INFO",
                    flatten_text(record.get("result")) or flatten_text(record.get("content")) or f"OpenClaw tool call: {tool_name}",
                    {
                        "session_id": session_id,
                        "event.name": "openclaw.tool_call",
                        "tool_name": tool_name,
                        "status": status,
                    },
                )
            )

    if not logs and not spans:
        return None

    return (
        build_logs_payload("openclaw", entry.workspace_path, "openclaw_runtime", logs),
        build_traces_payload("openclaw", entry.workspace_path, "openclaw_runtime", spans),
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
