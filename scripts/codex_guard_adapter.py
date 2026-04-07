#!/usr/bin/env python3

import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from runtime_otlp_common import (
    coerce_iso_timestamp,
    flatten_text,
    load_state,
    safe_json_dumps,
    save_state,
)


GUARD_BASE_URL = "http://127.0.0.1:46358"


@dataclass
class SessionIndexEntry:
    id: str
    updated_at: str
    thread_name: str | None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Bridge Codex local sessions into AOS Runtime Guard."
    )
    parser.add_argument("--codex-home", default=str(Path.home() / ".codex"))
    parser.add_argument("--guard-base-url", default=GUARD_BASE_URL)
    parser.add_argument(
        "--state-file", default=str(Path("data") / "codex_guard_state.json")
    )
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--experimental-soft-stop", action="store_true")
    args = parser.parse_args()

    codex_home = Path(args.codex_home).expanduser()
    state_file = Path(args.state_file).expanduser()
    state = normalize_state(load_state(state_file))

    sync_once(
        codex_home=codex_home,
        state_file=state_file,
        state=state,
        limit=args.limit,
        guard_base_url=args.guard_base_url.rstrip("/"),
        experimental_soft_stop=args.experimental_soft_stop,
    )
    return 0


def normalize_state(raw: dict[str, Any]) -> dict[str, Any]:
    sessions = raw.get("sessions")
    if not isinstance(sessions, dict):
        sessions = {}
    metrics = raw.get("metrics")
    if not isinstance(metrics, dict):
        metrics = {}
    return {"sessions": sessions, "metrics": normalize_metrics(metrics)}


def normalize_metrics(raw: dict[str, Any]) -> dict[str, Any]:
    metrics = default_metrics()
    for key, value in raw.items():
        if key in metrics:
            metrics[key] = value
    return metrics


def default_metrics() -> dict[str, Any]:
    return {
        "processed_events_total": 0,
        "processed_events_last_run": 0,
        "blocked_events_total": 0,
        "blocked_events_last_run": 0,
        "prompt_events_total": 0,
        "prompt_events_last_run": 0,
        "tool_call_events_total": 0,
        "tool_call_events_last_run": 0,
        "output_events_total": 0,
        "output_events_last_run": 0,
        "soft_stop_enabled": False,
        "soft_stop_attempts_total": 0,
        "soft_stop_attempts_last_run": 0,
        "soft_stop_success_total": 0,
        "soft_stop_success_last_run": 0,
        "last_run_at": None,
        "last_blocked_event_at": None,
        "last_soft_stop_at": None,
        "last_soft_stop_result": None,
    }


def reset_last_run_metrics(metrics: dict[str, Any], experimental_soft_stop: bool) -> None:
    metrics["processed_events_last_run"] = 0
    metrics["blocked_events_last_run"] = 0
    metrics["prompt_events_last_run"] = 0
    metrics["tool_call_events_last_run"] = 0
    metrics["output_events_last_run"] = 0
    metrics["soft_stop_attempts_last_run"] = 0
    metrics["soft_stop_success_last_run"] = 0
    metrics["soft_stop_enabled"] = experimental_soft_stop
    metrics["last_run_at"] = current_timestamp()


def current_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def persist_state(
    state_file: Path, sessions_state: dict[str, Any], metrics: dict[str, Any]
) -> None:
    save_state(state_file, {"sessions": sessions_state, "metrics": metrics})


def sync_once(
    codex_home: Path,
    state_file: Path,
    state: dict[str, Any],
    limit: int,
    guard_base_url: str,
    experimental_soft_stop: bool,
) -> None:
    entries = read_session_index(codex_home)
    entries.sort(key=lambda item: item.updated_at, reverse=True)
    sessions_state = state.setdefault("sessions", {})
    metrics = state.setdefault("metrics", default_metrics())
    reset_last_run_metrics(metrics, experimental_soft_stop)
    changed = [
        entry
        for entry in entries
        if should_sync_entry(entry, sessions_state.get(entry.id))
    ][:limit]

    if not changed:
        persist_state(state_file, sessions_state, metrics)
        print("no changed codex guard sessions")
        return

    for entry in changed:
        session_file = find_session_file(codex_home / "sessions", entry.id)
        if session_file is None:
            continue

        process_session(
            session_file=session_file,
            entry=entry,
            sessions_state=sessions_state,
            state_file=state_file,
            guard_base_url=guard_base_url,
            metrics=metrics,
            experimental_soft_stop=experimental_soft_stop,
        )
        print(f"guard-synced {entry.id}")

    metrics["last_run_at"] = current_timestamp()
    persist_state(state_file, sessions_state, metrics)


def should_sync_entry(entry: SessionIndexEntry, saved: Any) -> bool:
    if not isinstance(saved, dict):
        return True
    return saved.get("updated_at") != entry.updated_at


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
                id=str(session_id),
                updated_at=coerce_iso_timestamp(updated_at),
                thread_name=raw.get("thread_name"),
            )
        )
    return entries


def find_session_file(root: Path, session_id: str) -> Path | None:
    if not root.exists():
        return None
    for path in root.rglob("*.jsonl"):
        if session_id in path.name:
            return path
    return None


def process_session(
    session_file: Path,
    entry: SessionIndexEntry,
    sessions_state: dict[str, Any],
    state_file: Path,
    guard_base_url: str,
    metrics: dict[str, Any],
    experimental_soft_stop: bool,
) -> None:
    previous = sessions_state.get(entry.id)
    line_cursor = 0
    if isinstance(previous, dict):
        saved_cursor = previous.get("line_cursor")
        if isinstance(saved_cursor, int) and saved_cursor >= 0:
            line_cursor = saved_cursor

    lines = session_file.read_text(encoding="utf-8").splitlines()
    if line_cursor > len(lines):
        line_cursor = 0

    session_id = f"codex-{entry.id}"
    workspace_path = "~/.codex"
    model = "unknown"
    tool_calls: dict[str, dict[str, Any]] = {}

    checkpoint_session(
        sessions_state,
        state_file,
        entry,
        session_file,
        line_cursor,
        workspace_path,
        metrics,
    )

    for index, line in enumerate(lines):
        if not line.strip():
            checkpoint_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                workspace_path,
                metrics,
            )
            continue

        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            checkpoint_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                workspace_path,
                metrics,
            )
            continue

        record_type = record.get("type", "")
        payload = record.get("payload") or {}
        timestamp = coerce_iso_timestamp(
            record.get("timestamp") or payload.get("timestamp") or entry.updated_at
        )

        if record_type == "session_meta":
            workspace_path = payload.get("cwd") or workspace_path
            checkpoint_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                workspace_path,
                metrics,
            )
            continue

        if record_type == "turn_context":
            model = payload.get("model") or model
            checkpoint_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                workspace_path,
                metrics,
            )
            continue

        if record_type == "response_item":
            payload_type = payload.get("type", "")
            if payload_type == "function_call":
                call_id = str(payload.get("call_id") or "")
                tool_calls[call_id] = {
                    "name": payload.get("name") or "tool",
                    "arguments": payload.get("arguments"),
                    "started_at": timestamp,
                }
                if index >= line_cursor:
                    decision = post_tool_call(
                        guard_base_url=guard_base_url,
                        session_id=session_id,
                        thread_name=entry.thread_name,
                        workspace_path=workspace_path,
                        timestamp=timestamp,
                        tool_name=str(payload.get("name") or "tool"),
                        params=parse_tool_arguments(payload.get("arguments")),
                        model=model,
                    )
                    register_guard_result(metrics, "tool_call", decision, timestamp)
                    if is_blocked_decision(decision) and experimental_soft_stop:
                        command_text = command_candidate_from_params(
                            parse_tool_arguments(payload.get("arguments"))
                        )
                        success, result_label = attempt_soft_stop(
                            tool_name=str(payload.get("name") or "tool"),
                            workspace_path=workspace_path,
                            command_text=command_text,
                        )
                        metrics["soft_stop_attempts_total"] += 1
                        metrics["soft_stop_attempts_last_run"] += 1
                        metrics["last_soft_stop_at"] = timestamp
                        metrics["last_soft_stop_result"] = result_label
                        if success:
                            metrics["soft_stop_success_total"] += 1
                            metrics["soft_stop_success_last_run"] += 1
            elif payload_type == "function_call_output" and index >= line_cursor:
                call_id = str(payload.get("call_id") or "")
                call = tool_calls.get(call_id, {})
                output_text = extract_tool_output_text(payload.get("output"))
                if output_text:
                    decision = post_output(
                        guard_base_url=guard_base_url,
                        session_id=session_id,
                        thread_name=entry.thread_name,
                        workspace_path=workspace_path,
                        timestamp=timestamp,
                        text=output_text,
                        channel="tool_output",
                    )
                    register_guard_result(metrics, "output", decision, timestamp)

            checkpoint_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                workspace_path,
                metrics,
            )
            continue

        if record_type == "event_msg":
            payload_type = payload.get("type", "")
            if payload_type == "user_message" and index >= line_cursor:
                text = flatten_text(payload.get("message"))
                if text:
                    decision = post_prompt(
                        guard_base_url=guard_base_url,
                        session_id=session_id,
                        thread_name=entry.thread_name,
                        workspace_path=workspace_path,
                        timestamp=timestamp,
                        text=text,
                    )
                    register_guard_result(metrics, "prompt", decision, timestamp)
            elif payload_type == "agent_message" and index >= line_cursor:
                text = flatten_text(payload.get("message"))
                if text:
                    decision = post_output(
                        guard_base_url=guard_base_url,
                        session_id=session_id,
                        thread_name=entry.thread_name,
                        workspace_path=workspace_path,
                        timestamp=timestamp,
                        text=text,
                        channel="assistant_message",
                    )
                    register_guard_result(metrics, "output", decision, timestamp)

            checkpoint_session(
                sessions_state,
                state_file,
                entry,
                session_file,
                index + 1,
                workspace_path,
                metrics,
            )
            continue

        checkpoint_session(
            sessions_state,
            state_file,
            entry,
            session_file,
            index + 1,
            workspace_path,
            metrics,
        )


def checkpoint_session(
    sessions_state: dict[str, Any],
    state_file: Path,
    entry: SessionIndexEntry,
    session_file: Path,
    line_cursor: int,
    workspace_path: str,
    metrics: dict[str, Any],
) -> None:
    sessions_state[entry.id] = {
        "updated_at": entry.updated_at,
        "line_cursor": line_cursor,
        "workspace_path": workspace_path,
        "thread_name": entry.thread_name,
        "session_file": str(session_file),
    }
    persist_state(state_file, sessions_state, metrics)


def parse_tool_arguments(arguments: Any) -> Any:
    if isinstance(arguments, dict):
        return arguments
    if isinstance(arguments, list):
        return arguments
    if isinstance(arguments, str):
        stripped = arguments.strip()
        if not stripped:
            return {}
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, (dict, list)):
                return parsed
            return {"raw_value": parsed}
        except json.JSONDecodeError:
            return {"raw_arguments": arguments}
    if arguments is None:
        return {}
    return {"raw_arguments": safe_json_dumps(arguments)}


def extract_tool_output_text(output: Any) -> str:
    decoded = output
    if isinstance(output, str):
        stripped = output.strip()
        if not stripped:
            return ""
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            decoded = output

    text = flatten_text(decoded)
    if text:
        return text
    return safe_json_dumps(decoded)


def register_guard_result(
    metrics: dict[str, Any],
    event_kind: str,
    response: dict[str, Any],
    timestamp: str,
) -> None:
    metrics["processed_events_total"] += 1
    metrics["processed_events_last_run"] += 1
    if event_kind == "prompt":
        metrics["prompt_events_total"] += 1
        metrics["prompt_events_last_run"] += 1
    elif event_kind == "tool_call":
        metrics["tool_call_events_total"] += 1
        metrics["tool_call_events_last_run"] += 1
    elif event_kind == "output":
        metrics["output_events_total"] += 1
        metrics["output_events_last_run"] += 1

    if is_blocked_decision(response):
        metrics["blocked_events_total"] += 1
        metrics["blocked_events_last_run"] += 1
        metrics["last_blocked_event_at"] = timestamp


def is_blocked_decision(response: dict[str, Any]) -> bool:
    decision = response.get("decision")
    if not isinstance(decision, dict):
        return False
    return bool(decision.get("blocked"))


def post_guard_json(endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def post_prompt(
    guard_base_url: str,
    session_id: str,
    thread_name: str | None,
    workspace_path: str,
    timestamp: str,
    text: str,
) -> dict[str, Any]:
    return post_guard_json(
        f"{guard_base_url}/v1/runtime/prompt",
        {
            "session_id": session_id,
            "source": "codex",
            "workspace_path": workspace_path,
            "timestamp": timestamp,
            "requester_id": thread_name,
            "channel": "user_message",
            "verified_owner": False,
            "prompt": text,
        },
    )


def post_tool_call(
    guard_base_url: str,
    session_id: str,
    thread_name: str | None,
    workspace_path: str,
    timestamp: str,
    tool_name: str,
    params: Any,
    model: str,
) -> dict[str, Any]:
    return post_guard_json(
        f"{guard_base_url}/v1/runtime/tool-call",
        {
            "session_id": session_id,
            "source": "codex",
            "workspace_path": workspace_path,
            "timestamp": timestamp,
            "requester_id": thread_name,
            "channel": "function_call",
            "verified_owner": False,
            "tool_name": tool_name,
            "params": {
                "model": model,
                **({"arguments": params} if not isinstance(params, dict) else params),
            },
        },
    )


def post_output(
    guard_base_url: str,
    session_id: str,
    thread_name: str | None,
    workspace_path: str,
    timestamp: str,
    text: str,
    channel: str,
) -> dict[str, Any]:
    payload = {
        "session_id": session_id,
        "source": "codex",
        "workspace_path": workspace_path,
        "timestamp": timestamp,
        "requester_id": thread_name,
        "channel": channel,
        "verified_owner": False,
        "output": text,
    }
    return post_guard_json(f"{guard_base_url}/v1/runtime/output", payload)


def command_candidate_from_params(params: Any) -> str | None:
    if isinstance(params, dict):
        for key in ("command", "cmd", "raw_arguments"):
            value = params.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        arguments = params.get("arguments")
        if isinstance(arguments, str) and arguments.strip():
            return arguments.strip()
    elif isinstance(params, str) and params.strip():
        return params.strip()
    return None


def attempt_soft_stop(
    tool_name: str,
    workspace_path: str,
    command_text: str | None,
) -> tuple[bool, str]:
    if tool_name not in {"exec", "exec_command", "shell_command"}:
        return False, "unsupported_tool"
    if not command_text:
        return False, "missing_command"

    process_ids = matching_process_ids(command_text, workspace_path)
    if not process_ids:
        return False, "no_matching_process"

    stopped_any = False
    for pid in process_ids:
        try:
            os.kill(pid, signal.SIGINT)
            stopped_any = True
        except ProcessLookupError:
            continue
        except OSError:
            continue

    if not stopped_any:
        return False, "signal_failed"

    return True, f"signaled:{','.join(str(pid) for pid in process_ids)}"


def matching_process_ids(command_text: str, workspace_path: str) -> list[int]:
    normalized_command = command_text.strip()
    if not normalized_command:
        return []

    try:
        process_listing = subprocess.run(
            ["ps", "-Ao", "pid=,ppid=,command="],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return []

    full_snippet = normalized_command[:96].lower()
    try:
        tokens = [
            token.lower()
            for token in shlex.split(normalized_command)
            if len(token) >= 3 and not token.startswith("-")
        ]
    except ValueError:
        tokens = [
            part.lower()
            for part in normalized_command.split()
            if len(part) >= 3 and not part.startswith("-")
        ]
    required_tokens = tokens[:2]

    matched: list[int] = []
    current_pid = os.getpid()
    for line in process_listing.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            pid_str, _ppid_str, command = stripped.split(None, 2)
            pid = int(pid_str)
        except ValueError:
            continue

        if pid == current_pid:
            continue

        lower_command = command.lower()
        if "codex_guard_adapter.py" in lower_command:
            continue
        if "ps -ao pid=,ppid=,command=" in lower_command:
            continue
        if "codex app-server" in lower_command:
            continue
        if "codex helper" in lower_command:
            continue

        if full_snippet and full_snippet in lower_command:
            matched.append(pid)
            continue

        if workspace_path and workspace_path.lower() in lower_command and required_tokens and any(
            token in lower_command for token in required_tokens
        ):
            matched.append(pid)
            continue

        if required_tokens and all(token in lower_command for token in required_tokens):
            matched.append(pid)

    return matched


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8"), file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError as error:
        print(f"request failed: {error}", file=sys.stderr)
        raise SystemExit(1)
