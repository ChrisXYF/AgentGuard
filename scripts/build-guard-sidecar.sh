#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[build-guard-sidecar] %s\n' "$*"
}

fail() {
  printf '[build-guard-sidecar] error: %s\n' "$*" >&2
  exit 1
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AOS_CLI_DIR="${AOS_CLI_DIR:-$ROOT_DIR/../agentguard-cli}"
OUT_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"

[[ -f "$AOS_CLI_DIR/Cargo.toml" ]] || fail "agentguard-cli Cargo.toml not found under $AOS_CLI_DIR"
mkdir -p "$OUT_DIR"

detect_target() {
  if [[ -n "${TAURI_ENV_TARGET_TRIPLE:-}" ]]; then
    printf '%s\n' "$TAURI_ENV_TARGET_TRIPLE"
    return
  fi

  if command -v rustc >/dev/null 2>&1; then
    rustc --print host-tuple
    return
  fi

  fail "unable to detect target triple; install rustc or set TAURI_ENV_TARGET_TRIPLE"
}

copy_target_binary() {
  local target="$1"
  local source="$AOS_CLI_DIR/target/$target/release/agentguard"
  local destination="$OUT_DIR/agentguard-$target"

  log "building agentguard sidecar for $target"
  cargo build --manifest-path "$AOS_CLI_DIR/Cargo.toml" --release --bin agentguard --target "$target"
  [[ -f "$source" ]] || fail "expected built binary at $source"
  cp "$source" "$destination"
  chmod +x "$destination"
  log "wrote $destination"
}

TARGET_TRIPLE="$(detect_target)"

if [[ "$TARGET_TRIPLE" == "universal-apple-darwin" ]]; then
  command -v lipo >/dev/null 2>&1 || fail "lipo is required for universal macOS sidecars"
  copy_target_binary "aarch64-apple-darwin"
  copy_target_binary "x86_64-apple-darwin"
  UNIVERSAL_OUT="$OUT_DIR/agentguard-universal-apple-darwin"
  log "creating universal sidecar binary"
  lipo -create \
    "$OUT_DIR/agentguard-aarch64-apple-darwin" \
    "$OUT_DIR/agentguard-x86_64-apple-darwin" \
    -output "$UNIVERSAL_OUT"
  chmod +x "$UNIVERSAL_OUT"
  log "wrote $UNIVERSAL_OUT"
else
  copy_target_binary "$TARGET_TRIPLE"
fi
