#!/usr/bin/env python3

import argparse
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
class GeminiSessionEntry:
    session_id: str
    path: Path
    updated_at: str
    workspace_path: str


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge Gemini CLI local sessions into AOS Activity Monitor via OTLP JSON.")
    parser.add_argument("--gemini-home", default=str(Path.home() / ".gemini"))
    parser.add_argument("--logs-endpoint", default=LOGS_ENDPOINT)
    parser.add_argument("--traces-endpoint", default=TRACES_ENDPOINT)
    parser.add_argument("--state-file", default=str(Path("data") / "gemini_otlp_state.json"))
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--interval", type=float, default=10.0)
    args = parser.parse_args()

    gemini_home = Path(args.gemini_home).expanduser()
    state_file = Path(args.state_file).expanduser()
    state = load_state(state_file)

    if args.watch:
        while True:
            sync_once(gemini_home, state_file, state, args.limit, args.logs_endpoint, args.traces_endpoint)
            time.sleep(args.interval)
    else:
        sync_once(gemini_home, state_file, state, args.limit, args.logs_endpoint, args.traces_endpoint)
    return 0


def sync_once(
    gemini_home: Path,
    state_file: Path,
    state: dict[str, dict[str, Any]],
    limit: int,
    logs_endpoint: str,
    traces_endpoint: str,
) -> None:
    entries = read_session_entries(gemini_home)
    entries.sort(key=lambda item: item.updated_at, reverse=True)

    changed: list[GeminiSessionEntry] = []
    for entry in entries:
        saved = state.get(entry.session_id)
        if saved and saved.get("updated_at") == entry.updated_at:
            continue
        changed.append(entry)
        if len(changed) >= limit:
            break

    if not changed:
        print("no changed gemini sessions")
        return

    for entry in changed:
        raw = read_json(entry.path, {})
        messages = raw.get("messages") if isinstance(raw, dict) else None
        if not isinstance(messages, list):
            continue
        saved = state.get(entry.session_id) or {}
        start_index = int(saved.get("message_count") or 0)
        if start_index < 0 or start_index > len(messages):
            start_index = 0

        parsed = parse_session(entry, raw, start_index)
        state[entry.session_id] = {
            "message_count": len(messages),
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


def read_session_entries(gemini_home: Path) -> list[GeminiSessionEntry]:
    tmp_root = gemini_home / "tmp"
    if not tmp_root.exists():
        return []

    project_paths = read_project_paths(gemini_home)
    entries: list[GeminiSessionEntry] = []
    for path in tmp_root.rglob("session-*.json"):
        raw = read_json(path, {})
        if not isinstance(raw, dict):
            continue
        session_id = raw.get("sessionId")
        updated_at = raw.get("lastUpdated") or raw.get("startTime")
        if not isinstance(session_id, str) or not session_id or not isinstance(updated_at, str):
            continue
        project_key = path.parent.parent.name
        workspace_path = resolve_workspace_path(gemini_home, project_key, project_paths)
        entries.append(
            GeminiSessionEntry(
                session_id=session_id,
                path=path,
                updated_at=coerce_iso_timestamp(updated_at),
                workspace_path=workspace_path,
            )
        )
    return entries


def read_project_paths(gemini_home: Path) -> dict[str, str]:
    raw = read_json(gemini_home / "projects.json", {})
    projects = raw.get("projects") if isinstance(raw, dict) else None
    if not isinstance(projects, dict):
        return {}

    resolved: dict[str, str] = {}
    for workspace_path, key in projects.items():
        if isinstance(key, str) and key:
            resolved[key] = str(workspace_path)
    return resolved


def resolve_workspace_path(gemini_home: Path, project_key: str, project_paths: dict[str, str]) -> str:
    if project_key in project_paths:
        return project_paths[project_key]

    project_root_path = gemini_home / "history" / project_key / ".project_root"
    if project_root_path.exists():
        try:
            value = project_root_path.read_text(encoding="utf-8").strip()
            if value:
                return value
        except OSError:
            pass

    return str((gemini_home / "tmp" / project_key).expanduser())


def parse_session(
    entry: GeminiSessionEntry,
    raw: dict[str, Any],
    start_index: int,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    session_id = f"gemini-{entry.session_id}"
    messages = raw.get("messages") or []
    logs: list[dict[str, Any]] = []
    spans: list[dict[str, Any]] = []
    last_user_at = coerce_iso_timestamp(raw.get("startTime"), fallback=entry.updated_at)

    for index, message in enumerate(messages):
        if index < start_index:
            if isinstance(message, dict) and message.get("type") == "user":
                last_user_at = coerce_iso_timestamp(message.get("timestamp"), fallback=last_user_at)
            continue

        if not isinstance(message, dict):
            continue
        message_type = str(message.get("type") or "").lower()
        timestamp = coerce_iso_timestamp(message.get("timestamp"), fallback=entry.updated_at)

        if message_type == "user":
            prompt = flatten_text(message.get("content"))
            logs.append(
                log_record(
                    timestamp,
                    "INFO",
                    prompt or "Gemini user prompt",
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

        if message_type == "gemini":
            model = message.get("model") or "gemini"
            tokens = message.get("tokens") if isinstance(message.get("tokens"), dict) else {}
            body = flatten_text(message.get("content"))
            latency_ms = compute_duration_ms(last_user_at, timestamp)
            input_tokens = int(tokens.get("input") or 0)
            output_tokens = int(tokens.get("output") or 0)
            cached_tokens = int(tokens.get("cached") or 0)
            thought_tokens = int(tokens.get("thoughts") or 0)
            tool_tokens = int(tokens.get("tool") or 0)
            if body or input_tokens or output_tokens or cached_tokens or thought_tokens or tool_tokens:
                logs.append(
                    log_record(
                        timestamp,
                        "INFO",
                        body or f"Gemini response from {model}",
                        {
                            "session_id": session_id,
                            "event.name": "gemini_cli.api_response",
                            "model": model,
                            "input_token_count": input_tokens,
                            "output_token_count": output_tokens,
                            "cached_content_token_count": cached_tokens,
                            "thoughts_token_count": thought_tokens,
                            "tool_token_count": tool_tokens,
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
            for tool_call in message.get("toolCalls") or []:
                if not isinstance(tool_call, dict):
                    continue
                tool_time = coerce_iso_timestamp(tool_call.get("timestamp"), fallback=timestamp)
                tool_name = tool_call.get("name") or tool_call.get("displayName") or "tool"
                result_display = flatten_text(tool_call.get("resultDisplay")) or flatten_text(tool_call.get("result"))
                status = str(tool_call.get("status") or "completed").lower()
                logs.append(
                    log_record(
                        tool_time,
                        "WARN" if status in {"error", "failed", "cancelled"} else "INFO",
                        result_display or f"Gemini tool call: {tool_name}",
                        {
                            "session_id": session_id,
                            "event.name": "gemini_cli.tool_call",
                            "tool_name": tool_name,
                            "function_name": tool_name,
                            "function_args": tool_call.get("args"),
                            "status": status,
                            "success": status not in {"error", "failed", "cancelled"},
                            "duration_ms": compute_duration_ms(last_user_at, tool_time),
                        },
                    )
                )
            continue

        if message_type == "error":
            body = flatten_text(message.get("content"))
            logs.append(
                log_record(
                    timestamp,
                    "WARN",
                    body or "Gemini runtime error",
                    {
                        "session_id": session_id,
                        "event.name": "runtime_error",
                    },
                )
            )
            continue

        if message_type == "info":
            body = flatten_text(message.get("content"))
            logs.append(
                log_record(
                    timestamp,
                    "INFO",
                    body or "Gemini runtime info",
                    {
                        "session_id": session_id,
                        "event.name": "runtime_log",
                    },
                )
            )

    if not logs and not spans:
        return None

    return (
        build_logs_payload("gemini-cli", entry.workspace_path, "gemini_cli", logs),
        build_traces_payload("gemini-cli", entry.workspace_path, "gemini_cli", spans),
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
