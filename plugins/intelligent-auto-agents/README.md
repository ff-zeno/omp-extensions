# Intelligent auto-agents

This OMP extension routes eligible subagent spawns through Jev, a TypeSafe-backed classifier described by `catalog.json`.

Jev can select a catalog slot, rate task difficulty, fit the slot's effort to the selected model, rank configured backups, and record routing metadata.

Jev keeps routed backups in the retry chain when the patched OMP core is installed.

Jev does not add, remove, reorder, or execute workers.

Jev does not override explicit model requests, per-agent model overrides, explicit effort requests, or `routing: "off"`.

Jev does not change the current chat model.

Jev records routing metadata without persisting assignment text, credentials, or provider errors.

## Patched OMP requirement

The extension requires OMP subagent routing API v2 from the pinned OMP 18.4.6 source commit `8b25ad4a05625dde65df41d057756b4815f4837c`.

On stock OMP, the extension logs a warning and `/auto-agents` reports that routing is unavailable.

Run the installer from this plugin directory with `bash core/install-omp.sh`.

The installer uses `OMP_SOURCE` when set and otherwise clones the pinned source under `${XDG_CACHE_HOME:-$HOME/.cache}/omp-jev/oh-my-pi-v18.4.6`.

The installer uses `OMP_BIN` when set and otherwise installs to the `omp` executable found on `PATH`, or `$HOME/.local/bin/omp` when no executable is found.

The installer refuses symlinked and non-file targets.

The installer backs up an existing unstamped binary under `${XDG_STATE_HOME:-$HOME/.local/state}/omp-jev/omp-stock-<version>` before replacement.

The installer writes a SHA-256 stamp under `${XDG_STATE_HOME:-$HOME/.local/state}/omp-jev/omp-patched`.

The installer prints the exact backup path and rollback instruction after installation.

To roll back, stop OMP, copy the saved `omp-stock-<version>` binary to the installed target, and restart OMP.

If no saved binary exists, reinstall the previous OMP package and restart OMP.

Restart existing OMP sessions after either installation or rollback.

## TypeSafe authentication

Jev evaluates classification requests through TypeSafe.

Authenticate interactively with `/login typesafe` or set `TYPESAFE_API_KEY` before starting OMP.

Without a TypeSafe key, Jev records a baseline decision and keeps each worker's configured model and effort.

The same baseline behavior applies when Jev times out, returns invalid data, has low confidence, is disabled, encounters a locked request, or finds no bound model.

## Model roles

The catalog and bundled agent frontmatter reference these `modelRoles` names.

Use concrete models that are available in your OMP installation.

Merge these keys into `~/.omp/agent/config.yml` without deleting existing role mappings.

```yaml
modelRoles:
  grunt: your-provider/your-fast-model:low
  mechanic: your-provider/your-tool-model:low
  lead: your-provider/your-daily-model:high
  peer-1: your-provider/your-debug-model:high
  fast: your-provider/your-fast-model:low
  secondary-planner: your-provider/your-second-planner:xhigh
  plan: your-provider/your-planner:medium
  plan.peer: your-provider/your-plan-reviewer:high
  design.primary: your-provider/your-primary-designer:high
  design.secondary: your-provider/your-secondary-designer:high
  orchestrator: your-provider/your-coordinator:high
  commit: your-provider/your-git-model:low
  review.frontier-1: your-provider/your-review-model:high
  review.frontier-2: your-provider/your-review-model:high
  review.frontier-3: your-provider/your-review-model:high
```

Role aliases are resolved by OMP, so the placeholder selectors must be replaced with models configured on your machine.

## Bundled agents and discovery

This package bundles `plan`, `plan-review-peer`, `plan-review-frontier-1`, `plan-review-frontier-2`, `plan-review-frontier-3`, `peer-review-frontier-1`, `peer-review-frontier-2`, `peer-review-frontier-3`, `orchestrator`, `design-master`, `design-second`, and `git`.

OMP also supplies its built-in `task`, `scout`, and `reviewer` agents used by the catalog.

OMP 18.4.6 discovers the nearest project `.omp/agents` directory first, then the user agent directory `~/.omp/agent/agents`, then enabled extension package agent directories, and finally bundled agents.

Therefore a project or user agent with the same exact, case-sensitive name wins over this package's bundled copy.

Earlier extension roots also win over later extension roots, and invalid files are skipped with a warning.

See [OMP 18.4.6 task-agent discovery](https://github.com/can1357/oh-my-pi/blob/8b25ad4a05625dde65df41d057756b4815f4837c/docs/task-agent-discovery.md#merge-and-collision-rules) for the precedence and collision rules.

## `/auto-agents`

Use `/auto-agents status` to show whether routing is enabled and the latest routing line.

Use `/auto-agents off` to disable routing for the current session.

Use `/auto-agents on` to enable routing for the current session.

The command never changes the current chat model.

## Editing `catalog.json`

Edit `catalog.json` next to `index.ts` to change catalog profiles, backup order, difficulty wording, readiness wording, limits, or the Jev model selector.

Keep the catalog version and schema valid.

Keep each profile id unique.

Keep each agent name in exactly one profile.

Keep backup references pointed at model-bearing profiles.

A model profile may list `speedPool`: agentless profiles to run while their subscription quota is ahead of pace. `speedPoolPlacement` puts them `before` the profile's own model (it becomes the fallback) or `after` it (they precede its `backups` in the retry chain).
Each entry sets `maxShortUsed` (5-hour or daily window), `minWeeklyHeadroom`, and optionally `minMonthlyHeadroom`; headroom is the elapsed share of the window minus the used share.
A threshold that is set requires its window: a member without that window in its usage report is not eligible.
`speedPoolLimits` holds the shared guardrails: `demoteAt`, `skipAt`, the per-dispatch `burstPenalty`, usage timeout and maximum report age, clock-skew tolerance, and the failure streak and duration for demotion.
Usage comes from the same provider reports as `/usage`. Antigravity is read through its Gemini counter and xAI through its aggregate credit pool. The plugin assumes `providers.antigravityEndpoint` is `auto`.

Run `bun test` from this plugin directory after editing the catalog.
