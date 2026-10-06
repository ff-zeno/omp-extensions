#!/usr/bin/env bash
# Build OMP with the bundled subagent-routing patch and install it as the `omp` on PATH.
#
# By default this targets the currently installed stock OMP version. Override any of:
#   OMP_VERSION=18.6.1   the upstream tag to build (must be an existing release tag)
#   OMP_SOURCE=/path     an existing checkout of that tag; otherwise it is cloned/fetched
#   OMP_BIN=/path        the binary to replace (default: `omp` on PATH)
#
# `omp update` replaces this build with the stock release: rerun this script to repatch.
# On a conflict or a failing test it stops before touching the installed binary and
# points at PATCHING.md for the manual rebase.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM="https://github.com/can1357/oh-my-pi.git"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/omp-jev"
STAMP="$STATE_DIR/omp-patched"
PATCHING_DOC="$HERE/PATCHING.md"

for binary in git bun; do
  command -v "$binary" >/dev/null || { printf 'Required command not found: %s\n' "$binary" >&2; exit 1; }
done

# GNU coreutils ships sha256sum; macOS ships shasum instead. Prefer whichever exists.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  printf 'Required command not found: sha256sum (Linux) or shasum (macOS)\n' >&2
  exit 1
fi

TARGET="${OMP_BIN:-$(command -v omp || printf '%s' "$HOME/.local/bin/omp")}"
if [[ -L "$TARGET" ]]; then
  printf 'Refusing to replace %s: it is a symlink. Point OMP_BIN at the real binary.\n' "$TARGET" >&2
  exit 1
fi
if [[ -e "$TARGET" && ! -f "$TARGET" ]]; then
  printf 'Refusing to replace %s: it is not a regular file.\n' "$TARGET" >&2
  exit 1
fi

# Target the installed stock version unless OMP_VERSION is set. Read it from the binary
# we are about to replace, so `omp update` followed by this script needs no arguments.
VERSION="${OMP_VERSION:-}"
if [[ -z "$VERSION" && -x "$TARGET" ]]; then
  VERSION="$("$TARGET" --version 2>/dev/null | sed 's#^omp/##' | sed -n '1p' || true)"
fi
if [[ -z "$VERSION" ]]; then
  printf 'Cannot detect the installed OMP version. Set OMP_VERSION to the upstream tag to build.\n' >&2
  exit 1
fi

# Prefer the patch bundled for this version; otherwise fall back to the newest bundled one.
# Portable semver-ish compare: numeric dot-separated fields, works on bash 3.2 (no `sort -V`).
version_gt() {
  local a="$1" b="$2" i x y
  local -a av bv
  IFS='.' read -r -a av <<< "$a"
  IFS='.' read -r -a bv <<< "$b"
  local n=${#av[@]}
  (( ${#bv[@]} > n )) && n=${#bv[@]}
  for (( i = 0; i < n; i++ )); do
    x=${av[i]:-0}; y=${bv[i]:-0}
    [[ "$x" =~ ^[0-9]+$ ]] || x=0
    [[ "$y" =~ ^[0-9]+$ ]] || y=0
    (( 10#$x > 10#$y )) && return 0
    (( 10#$x < 10#$y )) && return 1
  done
  return 1
}

PATCH=""
patch_version=""
for candidate in "$HERE"/subagent-routing-v*.patch; do
  [[ -f "$candidate" ]] || continue
  candidate_version="$(basename -- "$candidate")"
  candidate_version="${candidate_version#subagent-routing-v}"
  candidate_version="${candidate_version%.patch}"
  if [[ "$candidate_version" == "$VERSION" ]]; then
    PATCH="$candidate"
    patch_version="$candidate_version"
    break
  fi
  if [[ -z "$patch_version" ]] || version_gt "$candidate_version" "$patch_version"; then
    PATCH="$candidate"
    patch_version="$candidate_version"
  fi
done
if [[ -z "$PATCH" ]]; then
  printf 'No bundled routing patch found in %s.\n' "$HERE" >&2
  exit 1
fi
if [[ "$patch_version" != "$VERSION" ]]; then
  printf 'No patch bundled for OMP %s; using %s. It may not apply.\n' "$VERSION" "$(basename -- "$PATCH")" >&2
fi

SOURCE="${OMP_SOURCE:-${XDG_CACHE_HOME:-$HOME/.cache}/omp-jev/oh-my-pi-v$VERSION}"
TAG="v$VERSION"

# Fetch the release tag into a cached checkout. A shallow single-tag clone carries the
# preimage blobs `git apply --3way` needs, so no full history download is required.
if [[ ! -d "$SOURCE/.git" ]]; then
  printf 'Cloning %s at %s into %s...\n' "$UPSTREAM" "$TAG" "$SOURCE"
  mkdir -p "$(dirname -- "$SOURCE")"
  git clone -q --filter=blob:none --branch "$TAG" --single-branch "$UPSTREAM" "$SOURCE"
fi
if ! git -C "$SOURCE" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  git -C "$SOURCE" fetch -q origin "refs/tags/$TAG:refs/tags/$TAG"
fi
if ! git -C "$SOURCE" rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null 2>&1; then
  printf 'Upstream has no tag %s. Check the release name, or set OMP_VERSION.\n' "$TAG" >&2
  exit 1
fi
COMMIT="$(git -C "$SOURCE" rev-parse "refs/tags/$TAG^{commit}")"
if [[ "$(git -C "$SOURCE" rev-parse HEAD)" != "$COMMIT" ]]; then
  git -C "$SOURCE" checkout -q -f --detach "$TAG"
fi

# Apply the patch if it is not already present on this checkout.
if git -C "$SOURCE" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  printf 'Routing patch already applied to %s.\n' "$SOURCE"
elif git -C "$SOURCE" apply --check "$PATCH" >/dev/null 2>&1; then
  git -C "$SOURCE" apply "$PATCH"
  printf 'Applied %s.\n' "$(basename -- "$PATCH")"
elif git -C "$SOURCE" apply --3way "$PATCH" >/dev/null 2>&1; then
  printf 'Applied %s with a 3-way merge.\n' "$(basename -- "$PATCH")"
else
  printf '\nRouting patch does not apply cleanly to OMP %s (%s).\n' "$VERSION" "$COMMIT" >&2
  if git -C "$SOURCE" ls-files -u | grep -q .; then
    printf 'Conflicts remain in %s (see `git -C %s status`).\n' "$SOURCE" "$SOURCE" >&2
  fi
  printf 'The installed binary at %s was NOT changed.\n' "$TARGET" >&2
  printf 'Rebase the patch by hand, then rerun this script. See:\n  %s\n' "$PATCHING_DOC" >&2
  exit 1
fi

bun --cwd="$SOURCE" install --frozen-lockfile

# The produced binary embeds every addon in packages/natives/native/ and refuses one
# stamped for another release, so supply the matching prebuilt for this version.
native_import='await import("./packages/natives/native/index.js")'
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
    printf 'A matching pi-natives v%s prebuilt was not found. Run the installed `omp` once to populate ~/.omp/natives/%s, or install Rust with rustup, then rerun this script.\n' "$VERSION" "$VERSION" >&2
    exit 1
  fi
fi

# Run every test file the patch touches before building anything.
test_paths=()
while IFS= read -r path; do
  case "$path" in
    packages/coding-agent/*.test.ts)
      test_paths+=("${path#packages/coding-agent/}") ;;
  esac
done < <(sed -n 's|^+++ b/||p' "$PATCH")
if ((${#test_paths[@]})); then
  printf 'Running %d patched test file(s)...\n' "${#test_paths[@]}"
  if ! (cd "$SOURCE/packages/coding-agent" && bun test "${test_paths[@]}"); then
    printf '\nPatched tests failed on OMP %s.\n' "$VERSION" >&2
    printf 'The installed binary at %s was NOT changed.\n' "$TARGET" >&2
    printf 'Fix the patched sources, then rerun this script. See:\n  %s\n' "$PATCHING_DOC" >&2
    exit 1
  fi
fi

bun --cwd="$SOURCE" -e 'import { SUBAGENT_ROUTING_API_VERSION, getSupportedEfforts } from "./packages/coding-agent/src/index.ts"; if (SUBAGENT_ROUTING_API_VERSION !== 2 || typeof getSupportedEfforts !== "function") throw new Error("subagent routing API v2 unavailable");'

bun --cwd="$SOURCE/packages/coding-agent" run build
BUILT="$SOURCE/packages/coding-agent/dist/omp"
built_version="$("$BUILT" --version)"
if [[ "$built_version" != "omp/$VERSION" ]]; then
  printf 'Built binary reports %s, expected omp/%s. The installed binary was NOT changed.\n' "$built_version" "$VERSION" >&2
  exit 1
fi

mkdir -p "$STATE_DIR" "$(dirname -- "$TARGET")"
stamped_sha=""
backup=""
[[ -f "$STAMP" ]] && stamped_sha="$(sed -n 's/^sha256=//p' "$STAMP")"
if [[ -f "$TARGET" ]]; then
  current_sha="$(sha256_file "$TARGET")"
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
  "$(sha256_file "$TARGET")" "$COMMIT" "$VERSION" "$TARGET" >"$STAMP"
printf 'Installed patched omp v%s (subagent routing API v2) at %s.\n' "$VERSION" "$TARGET"
printf 'Restart running OMP sessions to load the patched binary.\n'
if [[ -n "$backup" ]]; then
  printf 'To roll back, stop OMP, copy %s to %s, and restart OMP.\n' "$backup" "$TARGET"
else
  printf 'To roll back, copy a saved %s/omp-stock-* binary to %s, or reinstall the previous OMP package, then restart OMP.\n' "$STATE_DIR" "$TARGET"
fi
