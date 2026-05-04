#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/setup-worktree.sh [options]

Prepare a Stella git worktree for local agent/development runs.

Options:
  --source PATH      Existing Stella checkout to copy ignored local env files from.
                     Defaults to $STELLA_SOURCE_REPO, then /Users/rahulnanda/projects/stella.
  --with-backend     Also run bun install in backend/ for Convex work.
  --skip-install     Copy local files and verify tools, but do not install packages.
  -h, --help         Show this help.

Environment:
  STELLA_SOURCE_REPO     Same as --source.
  STELLA_SETUP_BACKEND   Set to 1 to behave like --with-backend.
USAGE
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
source_repo="${STELLA_SOURCE_REPO:-/Users/rahulnanda/projects/stella}"
with_backend="${STELLA_SETUP_BACKEND:-0}"
skip_install=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      if [[ $# -lt 2 ]]; then
        echo "error: --source requires a path" >&2
        exit 2
      fi
      source_repo="$2"
      shift 2
      ;;
    --with-backend)
      with_backend=1
      shift
      ;;
    --skip-install)
      skip_install=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() {
  printf '[setup-worktree] %s\n' "$1"
}

require_file() {
  if [[ ! -f "$repo_root/$1" ]]; then
    echo "error: expected Stella repo root at $repo_root; missing $1" >&2
    exit 1
  fi
}

copy_if_missing() {
  local relative_path="$1"
  local source_path="$source_repo/$relative_path"
  local target_path="$repo_root/$relative_path"

  if [[ -f "$target_path" ]]; then
    log "keeping existing $relative_path"
    return
  fi

  if [[ ! -f "$source_path" ]]; then
    log "no source $relative_path found; skipping"
    return
  fi

  mkdir -p "$(dirname -- "$target_path")"
  cp -p "$source_path" "$target_path"
  log "copied $relative_path from $source_repo"
}

require_file "package.json"
require_file "bun.lock"

cd "$repo_root"

if ! command -v bun >/dev/null 2>&1; then
  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "error: bun was not found. Install Bun first or add it to PATH." >&2
    exit 1
  fi
fi

log "repo: $repo_root"
log "bun: $(command -v bun)"

if [[ -f "$repo_root/DEV-CONTEXT.md" ]]; then
  log "DEV-CONTEXT.md present"
else
  log "DEV-CONTEXT.md not found; continuing"
fi

if [[ -f "$repo_root/desktop/package.json" || -f "$repo_root/runtime/package.json" ]]; then
  log "desktop/runtime package manifests found; root install still runs first"
else
  log "root package owns desktop/runtime dependencies"
fi

if [[ -d "$source_repo" && "$source_repo" != "$repo_root" ]]; then
  copy_if_missing "desktop/.env.local"
  copy_if_missing "backend/.env.local"
else
  log "source checkout is this worktree; skipping local env copy"
fi

if [[ "$skip_install" == "1" ]]; then
  log "skipping package install"
else
  log "installing root Bun package"
  bun install --frozen-lockfile

  if [[ "$with_backend" == "1" ]]; then
    require_file "backend/package.json"
    require_file "backend/bun.lock"
    log "installing backend Bun project"
    (cd backend && bun install --frozen-lockfile)
  else
    log "backend install skipped; pass --with-backend for Convex work"
  fi
fi

log "done"
