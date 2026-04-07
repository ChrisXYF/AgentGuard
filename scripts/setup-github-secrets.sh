#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[setup-github-secrets] %s\n' "$*"
}

fail() {
  printf '[setup-github-secrets] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/setup-github-secrets.sh [--repo owner/name] [--write-file /tmp/file.env] [--apply]

Behavior:
  - Reads signing values from .env.signing.local by default
  - Optionally reads notarization values from .env.notarization.local
  - Converts them into Tauri's standard GitHub Actions secret names
  - Writes a local env file with the generated secret values
  - If --apply is provided and gh is authenticated, pushes those secrets into the target repo

Recognized local env values:
  .env.signing.local
    MACOS_CERTIFICATE_P12_PATH
    MACOS_CERTIFICATE_PASSWORD
    MACOS_SIGN_IDENTITY
    APPLE_TEAM_ID

  .env.notarization.local
    APPLE_API_KEY_ID
    APPLE_API_ISSUER_ID
    APPLE_API_KEY_P8_PATH
    APPLE_ID
    APPLE_APP_SPECIFIC_PASSWORD
    APPLE_TEAM_ID
EOF
}

infer_repo_slug() {
  local remote_url
  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  [[ -n "$remote_url" ]] || fail "could not infer repo from git remote; pass --repo owner/name"

  case "$remote_url" in
    https://github.com/*)
      remote_url="${remote_url#https://github.com/}"
      remote_url="${remote_url%.git}"
      ;;
    git@github.com:*)
      remote_url="${remote_url#git@github.com:}"
      remote_url="${remote_url%.git}"
      ;;
    *)
      fail "unsupported GitHub remote URL: $remote_url"
      ;;
  esac

  printf '%s\n' "$remote_url"
}

repo_slug=""
apply_secrets=0
write_file=""
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sign_env_file="${SIGN_ENV_FILE:-$root_dir/.env.signing.local}"
notarize_env_file="${NOTARIZE_ENV_FILE:-$root_dir/.env.notarization.local}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo_slug="${2:-}"
      shift 2
      ;;
    --write-file)
      write_file="${2:-}"
      shift 2
      ;;
    --apply)
      apply_secrets=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

cd "$root_dir"

[[ -f "$sign_env_file" ]] || fail "signing env file not found: $sign_env_file"

# shellcheck disable=SC1090
set -a
source "$sign_env_file"
if [[ -f "$notarize_env_file" ]]; then
  source "$notarize_env_file"
fi
set +a

repo_slug="${repo_slug:-$(infer_repo_slug)}"
write_file="${write_file:-/tmp/$(basename "$repo_slug")-tauri-github-secrets.env}"

MACOS_CERTIFICATE_P12_PATH="${MACOS_CERTIFICATE_P12_PATH:-}"
MACOS_CERTIFICATE_PASSWORD="${MACOS_CERTIFICATE_PASSWORD:-}"
MACOS_SIGN_IDENTITY="${MACOS_SIGN_IDENTITY:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-}"
APPLE_API_ISSUER_ID="${APPLE_API_ISSUER_ID:-}"
APPLE_API_KEY_P8_PATH="${APPLE_API_KEY_P8_PATH:-}"
APPLE_ID="${APPLE_ID:-}"
APPLE_APP_SPECIFIC_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD:-}"

[[ -n "$MACOS_CERTIFICATE_P12_PATH" ]] || fail "MACOS_CERTIFICATE_P12_PATH is empty"
[[ -f "$MACOS_CERTIFICATE_P12_PATH" ]] || fail "certificate file not found: $MACOS_CERTIFICATE_P12_PATH"
[[ -n "$MACOS_CERTIFICATE_PASSWORD" ]] || fail "MACOS_CERTIFICATE_PASSWORD is empty"

APPLE_CERTIFICATE="$(openssl base64 -A -in "$MACOS_CERTIFICATE_P12_PATH")"
APPLE_API_KEY_P8_BASE64=""
if [[ -n "$APPLE_API_KEY_P8_PATH" ]]; then
  [[ -f "$APPLE_API_KEY_P8_PATH" ]] || fail "APPLE_API_KEY_P8_PATH does not exist: $APPLE_API_KEY_P8_PATH"
  APPLE_API_KEY_P8_BASE64="$(openssl base64 -A -in "$APPLE_API_KEY_P8_PATH")"
fi

mkdir -p "$(dirname "$write_file")"
umask 177
{
  printf 'APPLE_CERTIFICATE=%s\n' "$APPLE_CERTIFICATE"
  printf 'APPLE_CERTIFICATE_PASSWORD=%s\n' "$MACOS_CERTIFICATE_PASSWORD"

  if [[ -n "$MACOS_SIGN_IDENTITY" ]]; then
    printf 'APPLE_SIGNING_IDENTITY=%s\n' "$MACOS_SIGN_IDENTITY"
  fi
  if [[ -n "$APPLE_TEAM_ID" ]]; then
    printf 'APPLE_TEAM_ID=%s\n' "$APPLE_TEAM_ID"
  fi
  if [[ -n "$APPLE_API_KEY_ID" ]]; then
    printf 'APPLE_API_KEY=%s\n' "$APPLE_API_KEY_ID"
  fi
  if [[ -n "$APPLE_API_ISSUER_ID" ]]; then
    printf 'APPLE_API_ISSUER=%s\n' "$APPLE_API_ISSUER_ID"
  fi
  if [[ -n "$APPLE_API_KEY_P8_BASE64" ]]; then
    printf 'APPLE_API_KEY_P8_BASE64=%s\n' "$APPLE_API_KEY_P8_BASE64"
  fi
  if [[ -n "$APPLE_ID" ]]; then
    printf 'APPLE_ID=%s\n' "$APPLE_ID"
  fi
  if [[ -n "$APPLE_APP_SPECIFIC_PASSWORD" ]]; then
    printf 'APPLE_PASSWORD=%s\n' "$APPLE_APP_SPECIFIC_PASSWORD"
  fi
} > "$write_file"

log "wrote local secrets file: $write_file"
log "target repo: $repo_slug"

if [[ "$apply_secrets" == "1" ]]; then
  command -v gh >/dev/null 2>&1 || fail "gh CLI is not installed"
  gh auth status >/dev/null 2>&1 || fail "gh is not authenticated; run 'gh auth login' first"

  while IFS='=' read -r name value; do
    [[ -n "$name" ]] || continue
    gh secret set "$name" --repo "$repo_slug" --body "$value"
    log "updated GitHub secret: $name"
  done < "$write_file"
else
  log "skipped GitHub secret upload; rerun with --apply after 'gh auth login'"
fi

log "required Tauri signing secrets are prepared"
if [[ -z "$APPLE_API_KEY_P8_BASE64" && -z "$APPLE_ID" ]]; then
  log "notarization secrets are still missing"
fi
