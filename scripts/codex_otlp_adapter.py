#!/usr/bin/env python3

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOGS_ENDPOINT = "http://127.0.0.1:46357/v1/logs"
TRACES_ENDPOINT = "http://127.0.0.1:46357/v1/traces"


@dataclass
class SessionIndexEntry:
    id: str
    updated_at: str
    thread_name: str | None


@dataclass
class SessionSyncCursor:
    index_updated_at: str | None
    file_mtime_ns: int
    last_synced_line: int


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge Codex local sessions into AOS Activity Monitor via OTLP JSON.")
    parser.add_argument("--codex-home", default=str(Path.home() / ".codex"))
    parser.add_argument("--logs-endpoint", default=LOGS_ENDPOINT)
    parser.add_argument("--traces-endpoint", default=TRACES_ENDPOINT)
    parser.add_argument("--state-file", default=str(Path("data") / "codex_otlp_state.json"))
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--interval", type=float, default=10.0)
    args = parser.parse_args()

    codex_home = Path(args.codex_home).expanduser()
    state_file = Path(args.state_file).expanduser()
    state = load_state(state_file)

    if args.watch:
        while True:
            sync_once(codex_home, state_file, state, args.limit, args.logs_endpoint, args.traces_endpoint)
            time.sleep(args.interval)
    else:
        sync_once(codex_home, state_file, state, args.limit, args.logs_endpoint, args.traces_endpoint)
    return 0


def sync_once(
    codex_home: Path,
    state_file: Path,
    state: dict[str, str],
    limit: int,
    logs_endpoint: str,
    traces_endpoint: str,
) -> None:
    entries = read_session_index(codex_home)
    entry_map = {entry.id: entry for entry in entries}
    session_files = build_session_file_map(codex_home / "sessions")

    changed: list[tuple[SessionIndexEntry, Path, SessionSyncCursor | None, int]] = []
    for session_id, session_file in session_files.items():
        entry = entry_map.get(session_id)
        if entry is None:
            continue
        try:
            file_mtime_ns = session_file.stat().st_mtime_ns
        except OSError:
            continue
        cursor = normalize_cursor(state.get(session_id), session_file, entry.updated_at)
        if cursor is None or cursor.index_updated_at != entry.updated_at or cursor.file_mtime_ns != file_mtime_ns:
            changed.append((entry, session_file, cursor, file_mtime_ns))

    changed.sort(key=lambda item: max(item[0].updated_at, mtime_ns_to_iso(item[3])), reverse=True)
    changed = changed[:limit]
    if not changed:
        print("no changed codex sessions")
        return

    for entry, session_file, cursor, file_mtime_ns in changed:
        resume_after_line = cursor.last_synced_line if cursor else 0
        logs_payload, traces_payload, total_lines = parse_session(session_file, entry, resume_after_line)
        if logs_payload["resourceLogs"][0]["scopeLogs"][0]["logRecords"]:
            post_json(logs_endpoint, logs_payload)
        if traces_payload["resourceSpans"][0]["scopeSpans"][0]["spans"]:
            post_json(traces_endpoint, traces_payload)
        state[entry.id] = serialize_cursor(
            SessionSyncCursor(
                index_updated_at=entry.updated_at,
                file_mtime_ns=file_mtime_ns,
                last_synced_line=total_lines,
            )
        )
        if logs_payload["resourceLogs"][0]["scopeLogs"][0]["logRecords"] or traces_payload["resourceSpans"][0]["scopeSpans"][0]["spans"]:
            print(f"synced {entry.id}")

    save_state(state_file, state)


def read_session_index(codex_home: Path) -> list[SessionIndexEntry]:
    index_path = codex_home / "session_index.jsonl"
    if not index_path.exists():
        return []
    entries: list[SessionIndexEntry] = []
    for line in index_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        session_id = raw.get("id")
        updated_at = raw.get("updated_at")
        if not session_id or not updated_at:
            continue
        entries.append(
            SessionIndexEntry(
                id=session_id,
                updated_at=updated_at,
                thread_name=raw.get("thread_name"),
            )
        )
    return entries


def build_session_file_map(root: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    if not root.exists():
        return files
    for path in root.rglob("*.jsonl"):
        session_id = extract_session_id(path.name)
        if not session_id:
            continue
        files[session_id] = path
    return files


def extract_session_id(name: str) -> str | None:
    match = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", name)
    if match is None:
        return None
    return match.group(1)


def find_session_file(root: Path, session_id: str) -> Path | None:
    if not root.exists():
        return None
    for path in root.rglob("*.jsonl"):
        if session_id in path.name:
            return path
    return None


def normalize_cursor(raw: Any, session_file: Path, index_updated_at: str) -> SessionSyncCursor | None:
    if isinstance(raw, dict):
        try:
            return SessionSyncCursor(
                index_updated_at=raw.get("index_updated_at"),
                file_mtime_ns=int(raw.get("file_mtime_ns") or 0),
                last_synced_line=max(int(raw.get("last_synced_line") or 0), 0),
            )
        except (TypeError, ValueError):
            return None

    if isinstance(raw, str):
        return SessionSyncCursor(
            index_updated_at=index_updated_at,
            file_mtime_ns=0,
            last_synced_line=infer_legacy_last_synced_line(session_file, raw),
        )

    return None


def serialize_cursor(cursor: SessionSyncCursor) -> dict[str, Any]:
    return {
        "index_updated_at": cursor.index_updated_at,
        "file_mtime_ns": cursor.file_mtime_ns,
        "last_synced_line": cursor.last_synced_line,
    }


def infer_legacy_last_synced_line(session_file: Path, legacy_updated_at: str) -> int:
    count = 0
    for line in session_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            count += 1
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            count += 1
            continue
        payload = record.get("payload") or {}
        timestamp = record.get("timestamp") or payload.get("timestamp")
        count += 1
        if not timestamp or timestamp > legacy_updated_at:
            return count - 1
    return count


def parse_session(
    session_file: Path,
    entry: SessionIndexEntry,
    resume_after_line: int = 0,
) -> tuple[dict[str, Any], dict[str, Any], int]:
    session_id = f"codex-{entry.id}"
    cwd = "~/.codex"
    model = "unknown"
    tool_calls: dict[str, dict[str, Any]] = {}
    pending_reasoning_at: str | None = None
    logs: list[dict[str, Any]] = []
    spans: list[dict[str, Any]] = []
    line_count = 0

    for line in session_file.read_text(encoding="utf-8").splitlines():
        line_count += 1
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        record_type = record.get("type", "")
        payload = record.get("payload") or {}
        timestamp = record.get("timestamp") or payload.get("timestamp") or entry.updated_at

        if record_type == "session_meta":
            cwd = payload.get("cwd") or cwd
            continue

        if record_type == "turn_context":
            model = payload.get("model") or model
            continue

        if record_type == "event_msg":
            payload_type = payload.get("type", "")
            if payload_type == "user_message":
                if line_count > resume_after_line:
                    logs.append(
                        log_record(
                            timestamp,
                            "INFO",
                            payload.get("message", ""),
                            {
                                "session_id": session_id,
                                "message.role": "user",
                            },
                        )
                    )
            elif payload_type == "agent_message":
                if line_count > resume_after_line:
                    logs.append(
                        log_record(
                            timestamp,
                            "INFO",
                            payload.get("message", ""),
                            {
                                "session_id": session_id,
                                "message.role": "assistant",
                            },
                        )
                    )
            elif payload_type == "token_count":
                usage = ((payload.get("info") or {}).get("last_token_usage") or {})
                input_tokens = int(usage.get("input_tokens") or 0)
                output_tokens = int(usage.get("output_tokens") or 0)
                cached_input_tokens = int(usage.get("cached_input_tokens") or 0)
                if input_tokens or output_tokens or cached_input_tokens:
                    if line_count > resume_after_line:
                        latency_ms = compute_duration_ms(pending_reasoning_at, timestamp)
                        logs.append(
                            log_record(
                                timestamp,
                                "INFO",
                                "Codex model response",
                                {
                                    "session_id": session_id,
                                    "model": model,
                                    "input_token_count": input_tokens,
                                    "output_token_count": output_tokens,
                                    "cached_input_tokens": cached_input_tokens,
                                    "cost_usd": estimate_cost_usd(model, input_tokens, cached_input_tokens, output_tokens),
                                    "duration_ms": latency_ms,
                                },
                            )
                        )
                        if pending_reasoning_at:
                            spans.append(
                                span_record(
                                    session_id=session_id,
                                    span_name="model.inference",
                                    start_time=pending_reasoning_at,
                                    end_time=timestamp,
                                    attributes={
                                        "session_id": session_id,
                                        "model": model,
                                        "gen_ai.usage.input_tokens": input_tokens,
                                        "gen_ai.usage.output_tokens": output_tokens,
                                        "cost_usd": estimate_cost_usd(model, input_tokens, cached_input_tokens, output_tokens),
                                    },
                                )
                            )
                    pending_reasoning_at = None
            continue

        if record_type == "response_item":
            payload_type = payload.get("type", "")
            if payload_type == "reasoning":
                pending_reasoning_at = timestamp
                if line_count > resume_after_line:
                    logs.append(
                        log_record(
                            timestamp,
                            "INFO",
                            "Codex reasoning step",
                            {
                                "session_id": session_id,
                                "message.role": "reasoning",
                                "model": model,
                            },
                        )
                    )
            elif payload_type == "function_call":
                call_id = payload.get("call_id", "")
                tool_calls[call_id] = {
                    "name": payload.get("name") or "tool",
                    "arguments": payload.get("arguments") or "",
                    "started_at": timestamp,
                }
            elif payload_type == "function_call_output":
                call_id = payload.get("call_id", "")
                call = tool_calls.get(call_id, {})
                raw_output = payload.get("output")
                output = raw_output if isinstance(raw_output, str) else json.dumps(raw_output or "", ensure_ascii=False)
                metadata = {}
                try:
                    output_json = json.loads(output)
                    if isinstance(output_json, dict):
                        metadata = output_json.get("metadata") or {}
                except json.JSONDecodeError:
                    pass
                duration_ms = metadata_duration_ms(metadata) or compute_duration_ms(call.get("started_at"), timestamp)
                success = (metadata.get("exit_code") in (None, 0))
                if line_count > resume_after_line:
                    logs.append(
                        log_record(
                            timestamp,
                            "INFO" if success else "WARN",
                            "Codex tool completed",
                            {
                                "session_id": session_id,
                                "tool_name": call.get("name") or "tool",
                                "status": "completed" if success else "failed",
                                "duration_ms": duration_ms,
                                "success": success,
                                "exit_code": metadata.get("exit_code"),
                            },
                        )
                    )
                    spans.append(
                        span_record(
                            session_id=session_id,
                            span_name=f"tool.{call.get('name') or 'tool'}",
                            start_time=call.get("started_at") or timestamp,
                            end_time=timestamp,
                            attributes={
                                "session_id": session_id,
                                "tool_name": call.get("name") or "tool",
                                "status": "completed" if success else "failed",
                            },
                            status_code=0 if success else 2,
                        )
                    )

    resource_attrs = [
        attr("service.name", "codex-cli"),
        attr("workspace.path", cwd),
    ]

    logs_payload = {
        "resourceLogs": [
            {
                "resource": {"attributes": resource_attrs},
                "scopeLogs": [
                    {
                        "scope": {"name": "codex_runtime"},
                        "logRecords": logs,
                    }
                ],
            }
        ]
    }

    traces_payload = {
        "resourceSpans": [
            {
                "resource": {"attributes": resource_attrs},
                "scopeSpans": [
                    {
                        "scope": {"name": "codex_runtime"},
                        "spans": spans,
                    }
                ],
            }
        ]
    }

    return logs_payload, traces_payload, line_count


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


def load_state(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(path: Path, state: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def iso_to_unix_nanos(value: str) -> str:
    dt = parse_iso(value)
    nanos = int(dt.timestamp() * 1_000_000_000)
    return str(nanos)


def parse_iso(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized).astimezone(timezone.utc)


def compute_duration_ms(started_at: str | None, ended_at: str) -> int:
    if not started_at:
        return 0
    return max(int((parse_iso(ended_at) - parse_iso(started_at)).total_seconds() * 1000), 0)


def metadata_duration_ms(metadata: dict[str, Any]) -> int | None:
    duration_seconds = metadata.get("duration_seconds")
    if duration_seconds is None:
        return None
    return max(int(float(duration_seconds) * 1000), 0)


def estimate_cost_usd(model: str, input_tokens: int, cached_input_tokens: int, output_tokens: int) -> float:
    input_rate, cached_rate, output_rate = pricing_for_model(model)
    non_cached = max(input_tokens - cached_input_tokens, 0)
    return (
        (non_cached / 1_000_000.0) * input_rate
        + (max(cached_input_tokens, 0) / 1_000_000.0) * cached_rate
        + (max(output_tokens, 0) / 1_000_000.0) * output_rate
    )


def pricing_for_model(model: str) -> tuple[float, float, float]:
    if model == "gpt-5.1-codex-mini":
        return (0.3, 0.03, 1.2)
    return (1.5, 0.15, 6.0)


def stable_hex(value: str, length: int) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return digest[:length]


def mtime_ns_to_iso(value: int) -> str:
    return datetime.fromtimestamp(value / 1_000_000_000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8"), file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError as error:
        print(f"request failed: {error}", file=sys.stderr)
        raise SystemExit(1)
