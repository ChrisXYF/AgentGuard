#!/usr/bin/env python3

import hashlib
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOGS_ENDPOINT = "http://127.0.0.1:46357/v1/logs"
TRACES_ENDPOINT = "http://127.0.0.1:46357/v1/traces"


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def read_json(path: Path, default: Any) -> Any:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    return raw


def post_json(endpoint: str, payload: dict[str, Any]) -> None:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()


def safe_json_dumps(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except TypeError:
        return str(value)


def coerce_iso_timestamp(value: Any, fallback: str | None = None) -> str:
    if isinstance(value, datetime):
        dt = value.astimezone(timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")

    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(_to_seconds(float(value)), tz=timezone.utc).isoformat().replace("+00:00", "Z")

    if isinstance(value, str):
        raw = value.strip()
        if raw:
            if raw.isdigit():
                return datetime.fromtimestamp(_to_seconds(float(raw)), tz=timezone.utc).isoformat().replace("+00:00", "Z")
            try:
                return datetime.fromtimestamp(_to_seconds(float(raw)), tz=timezone.utc).isoformat().replace("+00:00", "Z")
            except ValueError:
                pass
            normalized = raw.replace("Z", "+00:00")
            try:
                dt = datetime.fromisoformat(normalized)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            except ValueError:
                pass

    if fallback:
        return coerce_iso_timestamp(fallback)

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def iso_to_unix_nanos(value: Any) -> str:
    dt = datetime.fromisoformat(coerce_iso_timestamp(value).replace("Z", "+00:00"))
    return str(int(dt.timestamp() * 1_000_000_000))


def stable_hex(value: str, length: int) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return digest[:length]


def compute_duration_ms(start: Any, end: Any) -> int:
    if start is None or end is None:
        return 0
    start_dt = datetime.fromisoformat(coerce_iso_timestamp(start).replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(coerce_iso_timestamp(end).replace("Z", "+00:00"))
    return max(0, int((end_dt - start_dt).total_seconds() * 1000))


def attr(key: str, value: Any) -> dict[str, Any]:
    return {"key": key, "value": wrap_value(value)}


def wrap_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [wrap_value(item) for item in value]}}
    if isinstance(value, dict):
        return {
            "kvlistValue": {
                "values": [{"key": key, "value": wrap_value(item)} for key, item in value.items()]
            }
        }
    return {"stringValue": str(value)}


def log_record(timestamp: Any, severity: str, body: str, attrs: dict[str, Any]) -> dict[str, Any]:
    return {
        "timeUnixNano": iso_to_unix_nanos(timestamp),
        "severityText": severity,
        "body": {"stringValue": body},
        "attributes": [attr(key, value) for key, value in attrs.items() if value is not None],
    }


def span_record(
    session_id: str,
    span_name: str,
    start_time: Any,
    end_time: Any,
    attributes: dict[str, Any],
    status_code: int = 0,
) -> dict[str, Any]:
    start_iso = coerce_iso_timestamp(start_time)
    end_iso = coerce_iso_timestamp(end_time)
    return {
        "traceId": stable_hex(f"{session_id}:trace", 32),
        "spanId": stable_hex(f"{session_id}:{span_name}:{start_iso}:{end_iso}", 16),
        "name": span_name,
        "startTimeUnixNano": iso_to_unix_nanos(start_iso),
        "endTimeUnixNano": iso_to_unix_nanos(end_iso),
        "attributes": [attr(key, value) for key, value in attributes.items() if value is not None],
        "status": {"code": status_code},
    }


def flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        parts = [flatten_text(item) for item in value]
        return "\n".join(part for part in parts if part).strip()
    if isinstance(value, dict):
        for key in ("text", "content", "output", "resultDisplay", "description", "subject", "prompt", "body"):
            nested = flatten_text(value.get(key))
            if nested:
                return nested
        return safe_json_dumps(value)
    return str(value)


def build_logs_payload(service_name: str, workspace_path: str, scope_name: str, logs: list[dict[str, Any]]) -> dict[str, Any]:
    resource_attrs = [
        attr("service.name", service_name),
        attr("workspace.path", workspace_path or "~"),
    ]
    return {
        "resourceLogs": [
            {
                "resource": {"attributes": resource_attrs},
                "scopeLogs": [{"scope": {"name": scope_name}, "logRecords": logs}],
            }
        ]
    }


def build_traces_payload(
    service_name: str,
    workspace_path: str,
    scope_name: str,
    spans: list[dict[str, Any]],
) -> dict[str, Any]:
    resource_attrs = [
        attr("service.name", service_name),
        attr("workspace.path", workspace_path or "~"),
    ]
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": resource_attrs},
                "scopeSpans": [{"scope": {"name": scope_name}, "spans": spans}],
            }
        ]
    }


def _to_seconds(value: float) -> float:
    return value / 1000 if value > 1_000_000_000_000 else value
