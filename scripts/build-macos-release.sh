#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[build-macos-release] %s\n' "$*"
}

fail() {
  printf '[build-macos-release] error: %s\n' "$*" >&2
  exit 1
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

[[ "$(uname -s)" == "Darwin" ]] || fail "this script must run on macOS"

SIGN_ENV_FILE="${MACOS_SIGN_ENV_FILE:-$ROOT_DIR/.env.signing.local}"
NOTARIZE_ENV_FILE="${MACOS_NOTARIZE_ENV_FILE:-$ROOT_DIR/.env.notarization.local}"
TEMP_DIR=""

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

if [[ -f "$SIGN_ENV_FILE" ]]; then
  log "loading signing values from $(basename "$SIGN_ENV_FILE")"
  # shellcheck disable=SC1090
  set -a
  source "$SIGN_ENV_FILE"
  set +a
fi

if [[ -f "$NOTARIZE_ENV_FILE" ]]; then
  log "loading notarization values from $(basename "$NOTARIZE_ENV_FILE")"
  # shellcheck disable=SC1090
  set -a
  source "$NOTARIZE_ENV_FILE"
  set +a
fi

MACOS_CERTIFICATE_P12_PATH="${MACOS_CERTIFICATE_P12_PATH:-}"
MACOS_CERTIFICATE_PASSWORD="${MACOS_CERTIFICATE_PASSWORD:-}"
MACOS_SIGN_IDENTITY="${MACOS_SIGN_IDENTITY:-}"
APPLE_APP_SPECIFIC_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD:-}"
APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-}"
APPLE_API_ISSUER_ID="${APPLE_API_ISSUER_ID:-}"
APPLE_API_KEY_P8_BASE64="${APPLE_API_KEY_P8_BASE64:-}"
APPLE_API_KEY_P8_PATH="${APPLE_API_KEY_P8_PATH:-}"
APPLE_ID="${APPLE_ID:-}"
APPLE_PASSWORD="${APPLE_PASSWORD:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"

if [[ -n "$MACOS_CERTIFICATE_P12_PATH" ]]; then
  [[ -f "$MACOS_CERTIFICATE_P12_PATH" ]] || fail "certificate file not found: $MACOS_CERTIFICATE_P12_PATH"
  [[ -n "$MACOS_CERTIFICATE_PASSWORD" ]] || fail "MACOS_CERTIFICATE_PASSWORD is empty"
  export APPLE_CERTIFICATE
  APPLE_CERTIFICATE="$(openssl base64 -A -in "$MACOS_CERTIFICATE_P12_PATH")"
  export APPLE_CERTIFICATE_PASSWORD="$MACOS_CERTIFICATE_PASSWORD"
  log "prepared APPLE_CERTIFICATE from local .p12"
fi

if [[ -n "$MACOS_SIGN_IDENTITY" ]]; then
  export APPLE_SIGNING_IDENTITY="$MACOS_SIGN_IDENTITY"
fi

if [[ -n "$APPLE_APP_SPECIFIC_PASSWORD" && -z "$APPLE_PASSWORD" ]]; then
  export APPLE_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD"
fi

if [[ -n "$APPLE_API_KEY_ID" ]]; then
  export APPLE_API_KEY="$APPLE_API_KEY_ID"
fi

if [[ -n "$APPLE_API_ISSUER_ID" ]]; then
  export APPLE_API_ISSUER="$APPLE_API_ISSUER_ID"
fi

if [[ -n "$APPLE_API_KEY_P8_BASE64" ]]; then
  TEMP_DIR="$(mktemp -d)"
  APPLE_API_KEY_P8_PATH="$TEMP_DIR/AuthKey_${APPLE_API_KEY_ID:-tauri}.p8"
  printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$APPLE_API_KEY_P8_PATH"
fi

if [[ -n "$APPLE_API_KEY_P8_PATH" ]]; then
  [[ -f "$APPLE_API_KEY_P8_PATH" ]] || fail "APPLE_API_KEY_P8_PATH does not exist: $APPLE_API_KEY_P8_PATH"
  export APPLE_API_KEY_PATH="$APPLE_API_KEY_P8_PATH"
fi

build_args=("$@")

if [[ "${#build_args[@]}" -eq 0 ]]; then
  build_args=(--bundles app,dmg)
fi

log "running Tauri build with args: ${build_args[*]}"
npx tauri build "${build_args[@]}"
