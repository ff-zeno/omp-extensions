#!/usr/bin/env bash
# Build pinned OMP with the subagent-routing patch and install it as the `omp` on PATH.
# `omp update` replaces this build with the stock release: rebase the patch, bump the pin, rerun.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${OMP_SOURCE:-${XDG_CACHE_HOME:-$HOME/.cache}/omp-jev/oh-my-pi-v18.4.6}"
UPSTREAM="https://github.com/can1357/oh-my-pi.git"
VERSION="18.4.6"
COMMIT="8b25ad4a05625dde65df41d057756b4815f4837c"
PATCH="$HERE/subagent-routing-v18.4.6.patch"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/omp-jev"
STAMP="$STATE_DIR/omp-patched"

for binary in git bun sha256sum; do
  command -v "$binary" >/dev/null || { printf 'Required command not found: %s\n' "$binary" >&2; exit 1; }
done

TARGET="${OMP_BIN:-$(command -v omp || printf '%s' "$HOME/.local/bin/omp")}"
if [[ -L "$TARGET" ]]; then
  printf 'Refusing to replace symlinked %s (package-manager install). Set OMP_BIN to a regular-file omp.\n' "$TARGET" >&2
  exit 1
fi
if [[ -e "$TARGET" && ! -f "$TARGET" ]]; then
  printf 'Refusing to replace non-file %s.\n' "$TARGET" >&2
  exit 1
fi

if [[ ! -e "$SOURCE" ]]; then
  mkdir -p "$(dirname -- "$SOURCE")"
  git clone --filter=blob:none --no-checkout "$UPSTREAM" "$SOURCE"
  git -C "$SOURCE" checkout --detach "$COMMIT"
fi
if [[ ! -d "$SOURCE/.git" ]]; then
  printf 'Refusing to use a non-git source directory: %s\n' "$SOURCE" >&2
  exit 1
fi
actual_commit="$(git -C "$SOURCE" rev-parse HEAD)"
if [[ "$actual_commit" != "$COMMIT" ]]; then
  printf 'OMP source must be pinned to %s (found %s); choose a fresh OMP_SOURCE.\n' "$COMMIT" "$actual_commit" >&2
  exit 1
fi

if git -C "$SOURCE" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  printf 'Routing patch already applied.\n'
elif git -C "$SOURCE" apply --check "$PATCH" >/dev/null 2>&1; then
  git -C "$SOURCE" apply "$PATCH"
else
  printf 'Routing patch does not apply cleanly to pinned OMP v%s.\n' "$VERSION" >&2
  exit 1
fi

bun --cwd="$SOURCE" install --frozen-lockfile
native_import='await import("./packages/natives/native/index.js")'
# The binary build embeds every addon in native/ and refuses one stamped for another release.
native_ready() {
  bun --cwd="$SOURCE" -e "$native_import" >/dev/null 2>&1 || return 1
  local addon
  for addon in "$SOURCE"/packages/natives/native/pi_natives.*.node; do
    [[ -e "$addon" ]] || continue
    LC_ALL=C grep -qaF "PI_NATIVES_VERSION_STAMP:$VERSION" "$addon" || return 1
  done
}
if ! native_ready; then
  cached_native_dir="$HOME/.omp/natives/$VERSION"
  native_platform=""
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) native_platform="linux-x64" ;;
    Linux:aarch64) native_platform="linux-arm64" ;;
    Darwin:x86_64) native_platform="darwin-x64" ;;
    Darwin:arm64) native_platform="darwin-arm64" ;;
  esac
  if [[ -n "$native_platform" && -d "$cached_native_dir" ]]; then
    shopt -s nullglob
    cached_addons=("$cached_native_dir"/pi_natives."$native_platform"-*.node)
    shopt -u nullglob
    if ((${#cached_addons[@]})); then
      cp -f -- "${cached_addons[@]}" "$SOURCE/packages/natives/native/"
    fi
  fi
fi
if ! native_ready; then
  if command -v cargo >/dev/null; then
    bun --cwd="$SOURCE" run build:native
  else
    printf 'A matching pi-natives v%s prebuilt was not found. Install Rust with rustup, then rerun this script.\n' "$VERSION" >&2
    exit 1
  fi
fi
bun --cwd="$SOURCE" -e 'import { SUBAGENT_ROUTING_API_VERSION, getSupportedEfforts } from "./packages/coding-agent/src/index.ts"; if (SUBAGENT_ROUTING_API_VERSION !== 2 || typeof getSupportedEfforts !== "function") throw new Error("subagent routing API v2 unavailable");'

bun --cwd="$SOURCE/packages/coding-agent" run build
BUILT="$SOURCE/packages/coding-agent/dist/omp"
built_version="$("$BUILT" --version)"
if [[ "$built_version" != "omp/$VERSION" ]]; then
  printf 'Built binary reports %s, expected omp/%s.\n' "$built_version" "$VERSION" >&2
  exit 1
fi

mkdir -p "$STATE_DIR" "$(dirname -- "$TARGET")"
stamped_sha=""
backup=""
[[ -f "$STAMP" ]] && stamped_sha="$(sed -n 's/^sha256=//p' "$STAMP")"
if [[ -f "$TARGET" ]]; then
  current_sha="$(sha256sum "$TARGET" | cut -d' ' -f1)"
  if [[ "$current_sha" != "$stamped_sha" ]]; then
    current_version="$("$TARGET" --version 2>/dev/null | sed 's#^omp/##' || true)"
    backup="$STATE_DIR/omp-stock-${current_version:-unknown}"
    cp -f -- "$TARGET" "$backup"
    printf 'Backed up the previous omp to %s\n' "$backup"
  fi
fi

tmp="$(mktemp "${TARGET}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cp -f -- "$BUILT" "$tmp"
chmod 0755 "$tmp"
mv -f -- "$tmp" "$TARGET"
trap - EXIT

printf 'sha256=%s\ncommit=%s\nversion=%s\npath=%s\n' \
  "$(sha256sum "$TARGET" | cut -d' ' -f1)" "$COMMIT" "$VERSION" "$TARGET" >"$STAMP"
printf 'Installed patched omp v%s (subagent routing API v2) at %s.\n' "$VERSION" "$TARGET"
printf 'Restart running OMP sessions to load the patched binary.\n'
if [[ -n "$backup" ]]; then
  printf 'To roll back, stop OMP, copy %s to %s, and restart OMP.\n' "$backup" "$TARGET"
else
  printf 'To roll back, copy a saved %s/omp-stock-* binary to %s, or reinstall the previous OMP package, then restart OMP.\n' "$STATE_DIR" "$TARGET"
fi
