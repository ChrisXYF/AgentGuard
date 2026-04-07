#!/usr/bin/env python3

import argparse
import sys
import time
import urllib.error
from pathlib import Path
from typing import Any

from runtime_otlp_common import (
    LOGS_ENDPOINT,
    build_logs_payload,
    coerce_iso_timestamp,
    flatten_text,
    load_state,
    log_record,
    post_json,
    read_json,
    save_state,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge OpenCode local sessions into AOS Activity Monitor via OTLP JSON.")
    parser.add_argument("--opencode-data", default=str(Path.home() / ".local" / "share" / "opencode"))
    parser.add_argument("--logs-endpoint", default=LOGS_ENDPOINT)
    parser.add_argument("--state-file", default=str(Path("data") / "opencode_otlp_state.json"))
    parser.add_argument("--limit", type=int, default=120)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--interval", type=float, default=10.0)
    args = parser.parse_args()

    data_root = Path(args.opencode_data).expanduser()
    state_file = Path(args.state_file).expanduser()
    state = load_state(state_file)

    if args.watch:
        while True:
            sync_once(data_root, state_file, state, args.limit, args.logs_endpoint)
            time.sleep(args.interval)
    else:
        sync_once(data_root, state_file, state, args.limit, args.logs_endpoint)
    return 0


def sync_once(
    data_root: Path,
    state_file: Path,
    state: dict[str, Any],
    limit: int,
    logs_endpoint: str,
) -> None:
    message_files = find_message_files(data_root)
    message_files.sort(key=lambda path: path.stat().st_mtime, reverse=True)

    changed = [path for path in message_files if state.get(path.as_posix()) != path.stat().st_mtime_ns][:limit]
    if not changed:
        print("no changed opencode messages")
        return

    for path in changed:
        payload = parse_message_file(path)
        state[path.as_posix()] = path.stat().st_mtime_ns
        if payload is None:
            continue
        post_json(logs_endpoint, payload)
        print(f"synced {path.parent.name}:{path.name}")

    save_state(state_file, state)


def find_message_files(data_root: Path) -> list[Path]:
    if not data_root.exists():
        return []

    files: list[Path] = []
    for storage_dir in data_root.rglob("storage/message"):
        for path in storage_dir.rglob("*.json"):
            files.append(path)
    return files


def parse_message_file(path: Path) -> dict[str, Any] | None:
    raw = read_json(path, {})
    if not isinstance(raw, dict):
        return None

    session_id_raw = raw.get("sessionID") or raw.get("sessionId") or path.parent.name
    if not isinstance(session_id_raw, str) or not session_id_raw:
        return None

    role = str(raw.get("role") or "").lower()
    timestamp = coerce_iso_timestamp(((raw.get("time") or {}).get("created")) or raw.get("timestamp") or raw.get("createdAt"))
    workspace_path = infer_workspace_path(path, raw)
    session_id = f"opencode-{session_id_raw}"

    logs: list[dict[str, Any]] = []
    if role == "user":
        prompt = flatten_text(raw.get("content")) or flatten_text(raw.get("message"))
        logs.append(
            log_record(
                timestamp,
                "INFO",
                prompt or "OpenCode user prompt",
                {
                    "session_id": session_id,
                    "event.name": "user_prompt",
                    "prompt": prompt,
                    "prompt_length": len(prompt),
                },
            )
        )
    elif role == "assistant":
        tokens = raw.get("tokens") if isinstance(raw.get("tokens"), dict) else {}
        model = raw.get("modelID") or raw.get("model") or "unknown"
        provider = raw.get("providerID") or raw.get("provider") or "unknown"
        body = flatten_text(raw.get("content")) or flatten_text(raw.get("message"))
        logs.append(
            log_record(
                timestamp,
                "INFO",
                body or f"OpenCode response from {provider}/{model}",
                {
                    "session_id": session_id,
                    "event.name": "opencode.api_response",
                    "model": model,
                    "provider": provider,
                    "input_token_count": int(tokens.get("input") or 0),
                    "output_token_count": int(tokens.get("output") or 0),
                    "cached_input_tokens": int(((tokens.get("cache") or {}).get("read")) or 0),
                    "cache_write_tokens": int(((tokens.get("cache") or {}).get("write")) or 0),
                    "thoughts_token_count": int(tokens.get("reasoning") or 0),
                    "cost_usd": _extract_cost(tokens),
                },
            )
        )
    else:
        tool_name = raw.get("toolName") or raw.get("tool_name") or raw.get("name")
        if tool_name:
            result_body = flatten_text(raw.get("content")) or flatten_text(raw.get("result")) or flatten_text(raw.get("message"))
            status = str(raw.get("status") or "completed").lower()
            logs.append(
                log_record(
                    timestamp,
                    "WARN" if status in {"error", "failed", "cancelled"} else "INFO",
                    result_body or f"OpenCode tool call: {tool_name}",
                    {
                        "session_id": session_id,
                        "event.name": "opencode.tool_call",
                        "tool_name": tool_name,
                        "status": status,
                        "metadata": raw.get("metadata"),
                    },
                )
            )
        else:
            body = flatten_text(raw.get("content")) or flatten_text(raw.get("message"))
            if body:
                logs.append(
                    log_record(
                        timestamp,
                        "INFO",
                        body,
                        {
                            "session_id": session_id,
                            "event.name": "runtime_log",
                            "role": role or "unknown",
                        },
                    )
                )

    if not logs:
        return None

    return build_logs_payload("opencode", workspace_path, "opencode_runtime", logs)


def infer_workspace_path(path: Path, raw: dict[str, Any]) -> str:
    for key in ("workspacePath", "projectPath", "cwd", "path"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, dict):
            for nested_key in ("root", "cwd", "workspace"):
                nested = value.get(nested_key)
                if isinstance(nested, str) and nested:
                    return nested

    storage_dir = next((parent for parent in path.parents if parent.name == "storage"), None)
    if storage_dir is not None and storage_dir.parent.name not in {"project", "global", "message"}:
        return storage_dir.parent.as_posix()

    return path.parent.parent.as_posix()


def _extract_cost(tokens: dict[str, Any]) -> float:
    cost = tokens.get("cost")
    if isinstance(cost, dict):
        total = cost.get("total")
        if isinstance(total, (int, float)):
            return float(total)
    return 0.0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8"), file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError as error:
        print(f"request failed: {error}", file=sys.stderr)
        raise SystemExit(1)
