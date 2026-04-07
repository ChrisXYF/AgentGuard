#!/usr/bin/env python3

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_SETTINGS = Path.home() / ".claude" / "settings.json"
DEFAULT_LOGS_ENDPOINT = "http://127.0.0.1:46357/v1/logs"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Configure Claude Code to export OTLP logs to the AOS activity monitor bridge.",
    )
    parser.add_argument(
        "--settings-file",
        default=str(DEFAULT_SETTINGS),
        help="Claude settings.json path. Defaults to ~/.claude/settings.json",
    )
    parser.add_argument(
        "--logs-endpoint",
        default=DEFAULT_LOGS_ENDPOINT,
        help="OTLP logs endpoint. Defaults to the local AOS bridge.",
    )
    parser.add_argument(
        "--enable-user-prompts",
        action="store_true",
        help="Enable OTEL_LOG_USER_PROMPTS=1 so prompt text is exported.",
    )
    parser.add_argument(
        "--enable-tool-details",
        action="store_true",
        help="Enable OTEL_LOG_TOOL_DETAILS=1 so MCP tool and skill details are exported.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the merged settings JSON without writing it.",
    )
    return parser.parse_args()


def load_settings(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def configure_env(settings: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    env = settings.get("env")
    if not isinstance(env, dict):
        env = {}

    env["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
    env["OTEL_LOGS_EXPORTER"] = "otlp"
    env["OTEL_EXPORTER_OTLP_LOGS_PROTOCOL"] = "http/json"
    env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] = args.logs_endpoint

    if args.enable_user_prompts:
        env["OTEL_LOG_USER_PROMPTS"] = "1"
    if args.enable_tool_details:
        env["OTEL_LOG_TOOL_DETAILS"] = "1"

    settings["env"] = env
    return settings


def main() -> int:
    args = parse_args()
    settings_path = Path(args.settings_file).expanduser()
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    settings = load_settings(settings_path)
    merged = configure_env(settings, args)

    if args.dry_run:
        print(json.dumps(merged, indent=2, ensure_ascii=False))
        return 0

    settings_path.write_text(
        json.dumps(merged, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"updated {settings_path}")
    print(f"claude logs endpoint -> {args.logs_endpoint}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
