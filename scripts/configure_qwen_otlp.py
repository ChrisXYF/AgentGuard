#!/usr/bin/env python3

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_SETTINGS = Path.home() / ".qwen" / "settings.json"
DEFAULT_OTLP_ENDPOINT = "http://127.0.0.1:46357"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Configure Qwen Code telemetry to export to the AOS activity monitor bridge.",
    )
    parser.add_argument(
        "--settings-file",
        default=str(DEFAULT_SETTINGS),
        help="Qwen settings.json path. Defaults to ~/.qwen/settings.json",
    )
    parser.add_argument(
        "--otlp-endpoint",
        default=DEFAULT_OTLP_ENDPOINT,
        help="OTLP base endpoint. Defaults to the local AOS bridge root.",
    )
    parser.add_argument(
        "--log-prompts",
        action="store_true",
        help="Enable prompt text in telemetry logs.",
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


def configure_telemetry(settings: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    telemetry = settings.get("telemetry")
    if not isinstance(telemetry, dict):
        telemetry = {}

    telemetry["enabled"] = True
    telemetry["target"] = "local"
    telemetry["otlpProtocol"] = "http"
    telemetry["otlpEndpoint"] = args.otlp_endpoint
    telemetry["logPrompts"] = bool(args.log_prompts)

    settings["telemetry"] = telemetry
    return settings


def main() -> int:
    args = parse_args()
    settings_path = Path(args.settings_file).expanduser()
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    settings = load_settings(settings_path)
    merged = configure_telemetry(settings, args)

    if args.dry_run:
        print(json.dumps(merged, indent=2, ensure_ascii=False))
        return 0

    settings_path.write_text(
        json.dumps(merged, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"updated {settings_path}")
    print(f"qwen otlp endpoint -> {args.otlp_endpoint}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
