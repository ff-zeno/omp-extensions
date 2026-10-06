# Patching OMP for Jev subagent routing

This plugin routes eligible subagent spawns through Jev, which can pick a model and a thinking level for each child.
Stock OMP's `before_subagent_spawn` hook only lets an extension return `model`, `block`, and `note`.
It cannot set a thinking level, it hands the handler no cancellation signal, it ignores an explicit opt-out, and it drops routed backups from the child's retry chain.
This patch extends that hook into "subagent routing API v2" and wires the extra fields through task, eval, and workpool spawns.
Upstream merged the base hook in PR #12907 (https://github.com/can1357/oh-my-pi/pull/12907); this patch is the delta on top of it.

The patch file is `subagent-routing-v<version>.patch` next to this document.
It was produced as `git diff --cached` in a checkout of the matching upstream release tag with the patch applied.

## Every OMP update is a rebase

`omp update` installs the stock release binary and overwrites the patched one, so the patch must be reapplied after every update.
Use the scripted path first:

```
core/install-omp.sh
```

It detects the installed stock version, fetches that release tag, applies the newest bundled patch with `git apply --3way`, runs the test files the patch touches, builds, and only then replaces the binary.
If the patch conflicts or a test fails, it stops before touching the installed binary and prints the next step.
If it stops on a conflict, rebase by hand as described below, regenerate the patch, then rerun the script.

Every installation backs up the stock binary it replaced to `$XDG_STATE_HOME/omp-jev/omp-stock-<version>` (default `~/.local/state/omp-jev/`).
To roll back, stop OMP, copy that file over the `omp` on `PATH`, and restart OMP.

## Re-creating the patch on a new version

Run every command below from the same working directory (the repository root), so relative clone paths and the absolute patch path agree.
Set the version numbers and the paths once:

```sh
CORE="$PWD/omp/public/omp-extensions/plugins/intelligent-auto-agents/core"
OLD=18.6.1
NEW=18.7.0
CLONE="$PWD/.tmp/oh-my-pi-v$NEW"
```

1. Clone the new tag into `$CLONE`:
   `git clone --filter=blob:none --branch "v$NEW" --single-branch https://github.com/can1357/oh-my-pi.git "$CLONE"`
2. Apply the current patch, addressed by its absolute path so it resolves the same regardless of the clone:
   `git -C "$CLONE" apply --3way "$CORE/subagent-routing-v$OLD.patch"`
   If the clone is a partial clone and `--3way` reports "repository lacks the necessary blob", run `git -C "$CLONE" fetch --refetch` to materialize the preimage blobs and rerun.
3. Resolve each conflict by keeping both the upstream change and this patch's field or hook, since the patch mostly adds new fields next to upstream's new fields.
   The base hook's extension-api hunks are the ones that need judgment; compare against the previous `subagent-routing-v$OLD.patch` postimage.
4. Install the clone's dependencies before running anything:
   `bun --cwd="$CLONE" install --frozen-lockfile`
5. Supply the matching prebuilt native addon; the tests import it and a build stamped for another release fails to load.
   Copy the addons the installed OMP already cached, or build them (needs Rust):
   `cp -f "$HOME/.omp/natives/$NEW"/pi_natives.*.node "$CLONE/packages/natives/native/"`
   `bun --cwd="$CLONE" run build:native`  # only if the cache copy above is missing
6. Run the test files the patch touches, from the coding-agent package (the installer derives this list from the patch's `+++ b/` lines):
   `bun --cwd="$CLONE/packages/coding-agent" test test/extensions-runner.test.ts test/task/structured-subagent.test.ts test/task/wire-schema.test.ts test/task/workpool.test.ts`
7. Stage the whole tree, then regenerate the patch from the staged diff:
   `git -C "$CLONE" add -A`
   `git -C "$CLONE" diff --cached > "$CORE/subagent-routing-v$NEW.patch"`
   Then remove the old patch file.
8. Update the plugin `README.md` `## Requirements` line to the new OMP version.

## What each changed file does

### docs/extensions.md

Adds five lines under the `before_subagent_spawn` entry describing API v2: routed backups stay in the child retry chain, model and effort locks, the `routing: "off"` opt-out, the task-only `solutionSpace` field, and fail-closed invalid returns.

### packages/coding-agent/CHANGELOG.md

One `[Unreleased]` bullet summarizing the hook extension.

### packages/coding-agent/src/extensibility/extensions/types.ts

Exports `SUBAGENT_ROUTING_API_VERSION = 2` as the compatibility seam the plugin checks at build time.
The marker stays at 2: `solutionSpace` is an optional, additive event field that changes no routing semantics, so the seam contract the plugin gates on is unchanged.
Adds to `BeforeSubagentSpawnEvent`: `assignment`, `context?`, `solutionSpace?`, `thinkingLevel?`, `modelLocked`, `effortLocked`, and `signal?`.
The baseline model patterns are the existing `patterns` field; the event carries no separate `model` copy.
Adds `thinkingLevel?` to `BeforeSubagentSpawnEventResult`.

### packages/coding-agent/src/extensibility/extensions/runner.ts

When dispatching `before_subagent_spawn`, clones the event with the handler's `signal` so a router can abort.
Accumulates `thinkingLevel` from handler results instead of overwriting on the last model result.
Passes a failure mapper so a thrown handler surfaces as a blocked spawn with a reason.

### packages/coding-agent/src/index.ts

Re-exports `SUBAGENT_ROUTING_API_VERSION` and `getSupportedEfforts` from the package entry so a compiled binary exposes them to local extension files.

### packages/coding-agent/src/task/structured-subagent.ts

Adds `routing?: "auto" | "off"` to `StructuredSubagentRequest`.
Adds `resolveRoutingModel` (resolves a returned pattern list to a concrete model or throws a preflight error) and `validateRoutingThinkingLevel` (rejects an unknown or unsupported level).
Rewrites `applySpawnHook` to track `modelLocked`/`effortLocked`, pin the resolved model when a thinking level is chosen, keep the routed backup patterns after the resolved primary, honor `routing: "off"`, forward the task's trimmed `solutionSpace` onto the emitted event, and return the rebuilt `nextPolicy`.
When a route replaces or pins the model, it clears `modelInheritsLiveThinkingLevel`, as stock does, so a routed `:level` suffix is not demoted to an inherited parent effort.

### packages/coding-agent/src/task/index.ts

Adds `validateRouting` for internal or stale-transcript calls that bypass the wire schema.
Validates `routing` in the batch and single spawn paths, copies it onto spawn items, and forwards it to `runStructuredSubagent`.

### packages/coding-agent/src/task/types.ts

Adds `const routingRule = '"auto" | "off"' as const` and a `"routing?"` field to the task item and task wire schemas and to the `WorkPool` create options.

### packages/coding-agent/src/task/workpool.ts

Adds `routing` to `WorkPoolCreateOptions` and forwards it into `runStructuredSubagent`.

### packages/coding-agent/src/task/executor.ts

Builds the fallback chain by unioning the routed selectors (or inherited chain) with the resolved primary's configured model-key chain, preserving routed backups.

### packages/coding-agent/src/session/turn-recovery.ts

Consults a subagent's task-specific retry chain (a `subagent:` role hint) before a model-keyed chain for the same primary.

### packages/coding-agent/src/eval/agent-bridge.ts

Adds `routing` to the eval agent args schema and interface and forwards it into policy resolution.

### packages/coding-agent/src/eval/workpool-bridge.ts

Adds `optionalRouting` (accepts only `"auto"` or `"off"`) and forwards it into policy resolution and pool creation.

### packages/coding-agent/src/eval/js/shared/prelude.txt

Adds `routing` to the allowed-argument lists for the JS `agent()` and `workpool()` helpers.

### packages/coding-agent/src/eval/py/prelude.py

Adds a `routing=None` parameter to the Python `agent()` and `workpool()` helpers and forwards it to the bridge.

### packages/tui/src/tools/task.ts

Adds `routing?: "auto" | "off"` to `TaskItem` and `TaskParams`.

### Test files

`test/agent-session-retry-fallback.test.ts`, `test/extensions-runner.test.ts`, `test/issue-2750-subagent-runtime-fallback.test.ts`, `test/task/structured-subagent.test.ts`, `test/task/wire-schema.test.ts`, and `test/task/workpool.test.ts` cover the new hook behavior, the routing schema, and the routed retry chain.

## Folding this patch into stock OMP instead

Upstream may one day accept these changes.
If a future release already contains the API v2 behavior, drop the corresponding hunks and lower this plugin's requirement to stock OMP.
Until then, every install of this plugin on OMP needs the patched build for Jev routing; the bundled agents, skill, and `/auto-agents` command still work on stock OMP with routing disabled.
