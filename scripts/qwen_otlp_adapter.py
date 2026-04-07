#!/usr/bin/env python3

import argparse
import hashlib
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


LOGS_ENDPOINT = "http://127.0.0.1:46357/v1/logs"
TRACES_ENDPOINT = "http://127.0.0.1:46357/v1/traces"


@dataclass
class ChatEntry:
    session_id: str
    path: Path
    updated_at: str


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge Qwen Code local sessions into AOS Activity Monitor via OTLP JSON.")
    parser.add_argument("--qwen-home", default=str(Path.home() / ".qwen"))
    parser.add_argument("--logs-endpoint", default=LOGS_ENDPOINT)
    parser.add_argument("--traces-endpoint", default=TRACES_ENDPOINT)
    parser.add_argument("--state-file", default=str(Path("data") / "qwen_otlp_state.json"))
    parser.add_argument("--db-path", default="")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--interval", type=float, default=10.0)
    args = parser.parse_args()

    qwen_home = Path(args.qwen_home).expanduser()
    state_file = Path(args.state_file).expanduser()
    db_path = Path(args.db_path).expanduser() if args.db_path else None
    state = load_state(state_file)

    if args.watch:
        while True:
            sync_once(qwen_home, state_file, state, db_path, args.limit, args.logs_endpoint, args.traces_endpoint)
            time.sleep(args.interval)
    else:
        sync_once(qwen_home, state_file, state, db_path, args.limit, args.logs_endpoint, args.traces_endpoint)
    return 0


def sync_once(
    qwen_home: Path,
    state_file: Path,
    state: dict[str, dict[str, Any]],
    db_path: Path | None,
    limit: int,
    logs_endpoint: str,
    traces_endpoint: str,
) -> None:
    entries = read_chat_entries(qwen_home)
    entries.sort(key=lambda item: item.updated_at, reverse=True)
    existing_sessions = read_existing_sessions(db_path)

    changed: list[ChatEntry] = []
    for entry in entries:
        saved = state.get(entry.session_id)
        if saved and saved.get("updated_at") == entry.updated_at:
            continue
        changed.append(entry)
        if len(changed) >= limit:
            break

    if not changed:
        print("no changed qwen sessions")
        return

    for entry in changed:
        lines = entry.path.read_text(encoding="utf-8").splitlines()
        line_count = len(lines)
        db_updated_at = existing_sessions.get(f"qwen-{entry.session_id}")
        saved = state.get(entry.session_id) or {}

        if not saved and db_updated_at:
            state[entry.session_id] = {"line_count": line_count, "updated_at": entry.updated_at}
            continue

        start_index = int(saved.get("line_count") or 0)
        if start_index < 0 or start_index > line_count:
            start_index = 0

        parsed = parse_chat(lines, entry.session_id, start_index)
        state[entry.session_id] = {"line_count": line_count, "updated_at": entry.updated_at}
        if parsed is None:
            continue

        logs_payload, traces_payload = parsed
        if logs_payload["resourceLogs"][0]["scopeLogs"][0]["logRecords"]:
            post_json(logs_endpoint, logs_payload)
        if traces_payload["resourceSpans"][0]["scopeSpans"][0]["spans"]:
            post_json(traces_endpoint, traces_payload)
        print(f"synced {entry.session_id}")

    save_state(state_file, state)


def read_chat_entries(qwen_home: Path) -> list[ChatEntry]:
    chats_root = qwen_home / "projects"
    if not chats_root.exists():
        return []

    entries: list[ChatEntry] = []
    for path in chats_root.rglob("*.jsonl"):
        updated_at = detect_last_timestamp(path)
        if not updated_at:
            continue
        entries.append(ChatEntry(session_id=path.stem, path=path, updated_at=updated_at))
    return entries


def read_existing_sessions(db_path: Path | None) -> dict[str, str]:
    if db_path is None or not db_path.exists():
        return {}

    sessions: dict[str, str] = {}
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(str(db_path))
        rows = connection.execute(
            """
            SELECT id, COALESCE(source_updated_at, ended_at, started_at)
            FROM runtime_sessions
            WHERE source = 'qwen'
            """
        )
        for session_id, updated_at in rows:
            if session_id and updated_at:
                sessions[str(session_id)] = str(updated_at)
    except sqlite3.Error:
        return {}
    finally:
        try:
            if connection is not None:
                connection.close()
        except Exception:
            pass
    return sessions


def detect_last_timestamp(path: Path) -> str | None:
    last_timestamp: str | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        timestamp = record.get("timestamp")
        if isinstance(timestamp, str) and timestamp:
            last_timestamp = timestamp
    return last_timestamp


def parse_chat(lines: list[str], raw_session_id: str, start_index: int) -> tuple[dict[str, Any], dict[str, Any]] | None:
    session_id = f"qwen-{raw_session_id}"
    cwd = "~/.qwen"
    logs: list[dict[str, Any]] = []
    spans: list[dict[str, Any]] = []

    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        timestamp = record.get("timestamp")
        if not isinstance(timestamp, str) or not timestamp:
            continue

        cwd = record.get("cwd") or cwd
        if index < start_index:
            continue

        record_type = record.get("type")
        if record_type == "user":
            prompt = flatten_parts(((record.get("message") or {}).get("parts") or []))
            logs.append(
                log_record(
                    timestamp,
                    "INFO",
                    prompt or "Qwen user prompt",
                    {
                        "session_id": session_id,
                        "event.name": "qwen-code.user_prompt",
                        "prompt": prompt,
                        "prompt_length": len(prompt),
                    },
                )
            )
            continue

        if record_type == "system" and record.get("subtype") == "ui_telemetry":
            ui_event = (((record.get("systemPayload") or {}).get("uiEvent")) or {})
            if ui_event.get("event.name") != "qwen-code.api_response":
                continue
            event_time = ui_event.get("event.timestamp") or timestamp
            model = ui_event.get("model") or record.get("model") or "unknown"
            duration_ms = int(ui_event.get("duration_ms") or 0)
            end_time = parse_iso(event_time)
            start_time = (end_time - timedelta(milliseconds=duration_ms)).isoformat().replace("+00:00", "Z")
            body = f"API response from {model}. Status: {ui_event.get('status_code') or '-'}."
            logs.append(
                log_record(
                    event_time,
                    "INFO" if int(ui_event.get("status_code") or 0) < 400 else "WARN",
                    body,
                    {
                        "session_id": session_id,
                        "event.name": "qwen-code.api_response",
                        "model": model,
                        "duration_ms": duration_ms,
                        "status_code": int(ui_event.get("status_code") or 0),
                        "input_token_count": int(ui_event.get("input_token_count") or 0),
                        "output_token_count": int(ui_event.get("output_token_count") or 0),
                        "cached_content_token_count": int(ui_event.get("cached_content_token_count") or 0),
                        "thoughts_token_count": int(ui_event.get("thoughts_token_count") or 0),
                        "tool_token_count": int(ui_event.get("tool_token_count") or 0),
                        "prompt_id": ui_event.get("prompt_id") or "",
                        "auth_type": ui_event.get("auth_type") or "",
                    },
                )
            )
            spans.append(
                span_record(
                    session_id=session_id,
                    span_name="model.inference",
                    start_time=start_time,
                    end_time=event_time,
                    attributes={
                        "session_id": session_id,
                        "model": model,
                        "gen_ai.usage.input_tokens": int(ui_event.get("input_token_count") or 0),
                        "gen_ai.usage.output_tokens": int(ui_event.get("output_token_count") or 0),
                    },
                )
            )

    if not logs and not spans:
        return None

    resource_attrs = [
        attr("service.name", "qwen-code"),
        attr("workspace.path", cwd),
    ]
    logs_payload = {
        "resourceLogs": [
            {
                "resource": {"attributes": resource_attrs},
                "scopeLogs": [{"scope": {"name": "qwen_runtime"}, "logRecords": logs}],
            }
        ]
    }
    traces_payload = {
        "resourceSpans": [
            {
                "resource": {"attributes": resource_attrs},
                "scopeSpans": [{"scope": {"name": "qwen_runtime"}, "spans": spans}],
            }
        ]
    }
    return logs_payload, traces_payload


def flatten_parts(parts: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for part in parts:
        text = part.get("text")
        if isinstance(text, str) and text.strip():
            chunks.append(text.strip())
    return "\n".join(chunks).strip()


def log_record(timestamp: str, severity: str, body: str, attrs: dict[str, Any]) -> dict[str, Any]:
    return {
        "timeUnixNano": iso_to_unix_nanos(timestamp),
        "severityText": severity,
        "body": {"stringValue": body},
        "attributes": [attr(key, value) for key, value in attrs.items() if value is not None],
    }


def span_record(
    session_id: str,
    span_name: str,
    start_time: str,
    end_time: str,
    attributes: dict[str, Any],
    status_code: int = 0,
) -> dict[str, Any]:
    trace_id = stable_hex(f"{session_id}:trace", 32)
    span_id = stable_hex(f"{session_id}:{span_name}:{start_time}:{end_time}", 16)
    return {
        "traceId": trace_id,
        "spanId": span_id,
        "name": span_name,
        "startTimeUnixNano": iso_to_unix_nanos(start_time),
        "endTimeUnixNano": iso_to_unix_nanos(end_time),
        "attributes": [attr(key, value) for key, value in attributes.items() if value is not None],
        "status": {"code": status_code},
    }


def attr(key: str, value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        wrapped = {"boolValue": value}
    elif isinstance(value, int):
        wrapped = {"intValue": str(value)}
    elif isinstance(value, float):
        wrapped = {"doubleValue": value}
    else:
        wrapped = {"stringValue": str(value)}
    return {"key": key, "value": wrapped}


def post_json(endpoint: str, payload: dict[str, Any]) -> None:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()


def load_state(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(path: Path, state: dict[str, dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def iso_to_unix_nanos(value: str) -> str:
    dt = parse_iso(value)
    nanos = int(dt.timestamp() * 1_000_000_000)
    return str(nanos)


def parse_iso(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized).astimezone(timezone.utc)


def stable_hex(value: str, length: int) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return digest[:length]


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8"), file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError as error:
        print(f"request failed: {error}", file=sys.stderr)
        raise SystemExit(1)
