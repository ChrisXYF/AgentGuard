#!/usr/bin/env python3

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Send OTLP JSON payloads to AOS activity monitor.")
    parser.add_argument(
        "--endpoint",
        default="http://127.0.0.1:46357/v1/logs",
        help="Bridge endpoint, typically /v1/logs or /v1/traces",
    )
    parser.add_argument(
        "--file",
        required=True,
        help="Path to JSON payload file",
    )
    args = parser.parse_args()

    payload_path = Path(args.file).expanduser().resolve()
    body = payload_path.read_text(encoding="utf-8")
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as error:
        print(f"invalid json in {payload_path}: {error}", file=sys.stderr)
        return 1

    request = urllib.request.Request(
        args.endpoint,
        data=json.dumps(parsed).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            print(response.read().decode("utf-8"))
        return 0
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8"), file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"request failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
