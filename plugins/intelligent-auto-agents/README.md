# Intelligent auto-agents

This OMP extension routes eligible subagent spawns through Jev, a TypeSafe-backed classifier described by `catalog.json` (catalog v7).

Jev selects a task type, rates task difficulty against the catalog ladder, resolves the model's effort from its difficulty-to-effort map, ranks pool members by quota, and records routing metadata.

A brief can steer Jev with a `Directive: use <alias|model> [effort]` line. Precedence is spawn lock, then directive, then pool, then a fixed task-type model, then the agent's bound `modelRoles` selector.

Jev keeps routed backups in the retry chain when the patched OMP core is installed.

Jev does not add, remove, reorder, or execute workers.

Jev does not override explicit model requests, per-agent model overrides, explicit effort requests, or `routing: "off"`.

Jev does not change the current chat model.

Jev records routing metadata without persisting assignment text, credentials, or provider errors.

## Install

The extension has two parts.
The plugin (bundled agents, the skill, `/auto-agents`, and the routing hook) loads on stock OMP.
The patched OMP build lets the hook set each subagent's model and thinking level; without it the plugin loads and Jev routing stays disabled.

Requirements:
- OMP 18.6.1. The bundled patch targets that release; another release needs a rebased patch (see [core/PATCHING.md](core/PATCHING.md)).
- `git` and Bun 1.4 or newer to build the patched OMP (OMP 18.6.1 declares `bun@>=1.4`). Running the plugin needs only OMP.
- `sha256sum` (Linux) or `shasum` (macOS) for the installer.
- Rust `cargo` from rustup only when no matching prebuilt native addon is in `~/.omp/natives/<version>`; running the stock `omp` once fills that directory.
- A TypeSafe API key for Jev (see [TypeSafe authentication](#typesafe-authentication)). Without one, every spawn keeps its configured model and effort.

### Setup checklist

Run these steps in order and check each result before the next; an AI agent setting this up can follow them as written.

1. Install stock OMP 18.6.1 and confirm `omp --version` prints `omp/18.6.1`:
   ```
   curl -fsSL https://omp.sh/install | sh -s -- --binary --ref v18.6.1
   ```
2. Clone this repository and build the patched OMP. The installer replaces the `omp` on `PATH` only after the patched tests pass, and prints the backup path and rollback command:
   ```
   git clone https://github.com/ff-zeno/omp-extensions.git
   bash omp-extensions/plugins/intelligent-auto-agents/core/install-omp.sh
   ```
3. Install the plugin from the marketplace or link the clone ([Marketplace install](#marketplace-install), [Local install](#local-install)).
4. Bind the `modelRoles` keys in `~/.omp/agent/config.yml` ([Model roles](#model-roles)).
5. Store a TypeSafe key: run `/login typesafe` inside OMP, or export `TYPESAFE_API_KEY` before starting OMP.
6. Restart OMP. `omp plugin list` lists `intelligent-auto-agents`, and `/auto-agents status` reports `Auto-agents on`.
7. Spawn one `task` subagent, then run `/auto-agents status` again. The latest routing line names a task type and model. A line with `fallback · routing auth · baseline kept` means OMP found no TypeSafe key.

Every `omp update` replaces the patched binary with the stock release; rerun step 2 after each update.
If the installer stops on a patch conflict, rebase the patch by hand as described in [core/PATCHING.md](core/PATCHING.md) and rerun it.

### Marketplace install

From a running OMP:

```
/marketplace add ff-zeno/omp-extensions
/marketplace install intelligent-auto-agents@omp-extensions
```

Or from a shell:

```
omp plugin marketplace add ff-zeno/omp-extensions
omp plugin install intelligent-auto-agents@omp-extensions
```

### Local install

```
git clone https://github.com/ff-zeno/omp-extensions.git
omp plugin link ./omp-extensions/plugins/intelligent-auto-agents
```

`omp plugin link` symlinks the plugin into `~/.omp/agent/plugins/node_modules/`, enables it, and wires the bundled agents and skill.
Symlinking the plugin folder into `~/.omp/agent/extensions/` also loads the extension entrypoint, but `omp plugin link` is preferred because it registers the bundled agents and skill.

### Verify it loaded

```
omp plugin list
omp plugin doctor
```

Then inside OMP run `/auto-agents status`.
On the patched build it reports routing enabled and the latest routing line.
On stock OMP it reports that routing is unavailable.

### Configure

Add the `modelRoles` keys listed under [Model roles](#model-roles) to `~/.omp/agent/config.yml`, and store a TypeSafe key as described under [TypeSafe authentication](#typesafe-authentication).

### Update

With the marketplace install, rerun `omp plugin install intelligent-auto-agents@omp-extensions`.
With the local install, run `git pull` in the clone.
Restart OMP after either.

### Uninstall

```
omp plugin uninstall intelligent-auto-agents
```

Remove any `modelRoles` keys you added for this plugin.
To remove the patched OMP build, follow the rollback steps under [Patched OMP requirement](#patched-omp-requirement).

## Patched OMP requirement

The extension requires OMP subagent routing API v2 from the pinned OMP 18.6.1 source commit `2a2c6dcbbb558c0f8145f67f28b3370984f2bf60`.
The bundled patch in `core/` targets that release; [core/PATCHING.md](core/PATCHING.md) explains what it changes and how to rebase it onto a future release.

On stock OMP, the extension logs a warning and `/auto-agents` reports that routing is unavailable.

Run the installer from this plugin directory with `bash core/install-omp.sh`.
It targets the installed OMP version by default, fetches that release tag, applies the newest bundled patch with `git apply --3way`, and runs the test files the patch touches before it replaces the binary.
If the patch conflicts or a patched test fails, it stops without touching the installed binary and points at [core/PATCHING.md](core/PATCHING.md).
Set `OMP_VERSION` to build a different release when a matching patch exists.

This replaces the `omp` binary on your `PATH` with a locally built binary; it does not modify your OMP configuration or `~/.omp`.
The installer refuses to replace a symlinked or non-file target, so a package-manager OMP is not overwritten in place.
It builds the pinned source with `bun` and, when no matching prebuilt native addon is cached, with Rust `cargo`.
Hashing uses `sha256sum` when available, otherwise `shasum` (macOS).
`omp update` overwrites this build with the stock release and disables Jev routing until you rerun the installer.

The installer uses `OMP_SOURCE` when set and otherwise clones the target release under `${XDG_CACHE_HOME:-$HOME/.cache}/omp-jev/oh-my-pi-v<version>`.

The installer uses `OMP_BIN` when set and otherwise installs to the `omp` executable found on `PATH`, or `$HOME/.local/bin/omp` when no executable is found.

The installer refuses symlinked and non-file targets.

The installer backs up an existing unstamped binary under `${XDG_STATE_HOME:-$HOME/.local/state}/omp-jev/omp-stock-<version>` before replacement.

The installer writes a SHA-256 stamp under `${XDG_STATE_HOME:-$HOME/.local/state}/omp-jev/omp-patched`.

The installer prints the exact backup path and rollback instruction after installation.

To roll back, stop OMP, copy the saved `omp-stock-<version>` binary to the installed target, and restart OMP.

If no saved binary exists, reinstall the previous OMP package and restart OMP.

Restart existing OMP sessions after either installation or rollback.

## TypeSafe authentication

Jev is TypeSafe's judgment model; `catalog.json` selects it with `"jevModel": "jev-latest"`.
The plugin calls it through the TypeSafe client built into OMP, so it needs no extra package, only a key:

1. Create an API key at https://console.typesafe.ai/.
2. Inside OMP run `/login typesafe` and paste the key. OMP checks it against TypeSafe's models endpoint and stores it with its other provider credentials.
   Alternatively, set `TYPESAFE_API_KEY` in the environment that starts OMP.

The plugin uses the key stored by `/login typesafe` first and `TYPESAFE_API_KEY` second.
OMP's TypeSafe client reads `TYPESAFE_BASE_URL` to override the API root, for example to route through a gateway.
Each eligible spawn sends one classification request to TypeSafe, limited to `maxInputBytes` (24000) of brief and context and `timeoutMs` (2000) of wait.

Without a key, each spawn records a baseline decision with reason `routing-auth` and keeps the worker's configured model and effort.
The same baseline behavior applies when Jev times out, returns invalid data, has low confidence, is disabled, encounters a locked request, or finds no bound model.

Media tasks follow the same rules: Jev picks the `vision` task type from the brief, and `Directive: use vision` forces it.

## Model roles

The catalog and bundled agent frontmatter reference these `modelRoles` names.

`frontier-1`, `frontier-2`, and `frontier-3` are the three frontier models. `lead` aliases one of them, and the pinned `review-frontier-1`, `review-frontier-2`, and `review-frontier-3` agents pin one frontier role each. `grunt` is the cheap worker and the pools' fallback, `vision` serves the `vision` task type, and `orchestrator` binds the bundled `orchestrator` agent.

Sonnet has no role. The catalog names it as the literal `anthropic/claude-sonnet-5-5`, scoped to exact grunt work and never above low.

The shipped `models` map also lists the author's literal provider models with their difficulty-to-effort maps; an entry for a provider you do not use has no effect, and `*` covers every model it does not name.

The `directiveTargets` map lets a brief's `Directive:` line name any of these aliases; it also accepts a literal `provider/model` or a task-type name.

Use concrete models that are available in your OMP installation.

Merge these keys into `~/.omp/agent/config.yml` without deleting existing role mappings.

```yaml
modelRoles:
  frontier-1: your-provider/your-first-frontier-model
  frontier-2: your-provider/your-second-frontier-model
  frontier-3: your-provider/your-third-frontier-model
  lead: "@frontier-1"
  grunt: your-provider/your-fast-model
  vision: your-provider/your-vision-model:high
  orchestrator: your-provider/your-fast-model
```

Role aliases are resolved by OMP, so the placeholder selectors must be replaced with models configured on your machine.

OMP's built-in roles `plan` and `commit` are used by the bundled `plan` and `git` agents and need no entry unless you want to override them.

Every pool member or task type whose role stays unbound is skipped, and a spawn with no resolvable option keeps its configured model and effort; the extension never fails a spawn because a role is missing.

## Bundled agents and discovery

This package bundles `orchestrator`, `design-master`, `design-second`, `review-frontier-1`, `review-frontier-2`, `review-frontier-3`, `plan`, and `git`.

OMP also supplies its built-in `task`, `scout`, `sonic`, `reviewer`, and `security-reviewer` agents used by the catalog. The pinned `review-closer` and `review-verifier` agents are profile agents, not bundled here.

OMP 18.6.1 discovers the nearest project `.omp/agents` directory first, then the user agent directory `~/.omp/agent/agents`, then enabled extension package agent directories, and finally bundled agents.

Therefore a project or user agent with the same exact, case-sensitive name wins over this package's bundled copy.

Earlier extension roots also win over later extension roots, and invalid files are skipped with a warning.

See [OMP 18.6.1 task-agent discovery](https://github.com/can1357/oh-my-pi/blob/2a2c6dcbbb558c0f8145f67f28b3370984f2bf60/docs/task-agent-discovery.md#merge-and-collision-rules) for the precedence and collision rules.

## `/auto-agents`

Use `/auto-agents status` to show whether routing is enabled, the catalog version, the Jev model, and the latest routing line.

Use `/auto-agents off` to disable routing for the current session.

Use `/auto-agents on` to enable routing for the current session.

The command never changes the current chat model.

## Editing `catalog.json`

Edit `catalog.json` next to `index.ts` to change pools, task types, directive targets, the difficulty-to-effort maps, readiness wording, limits, or the Jev model selector.

Keep the catalog version and schema valid.

`pools` holds `mechanical`, `grunt`, and `plan-review`. Each pool lists ordered `members`, each naming a role alias or a literal `provider/model`, plus a `fallback`. A member may set `effort` (pins its effort), `difficulties` (the levels it serves; absent means every level), and the quota gates `maxShortUsed`, `minWeeklyHeadroom`, and `minMonthlyHeadroom`. The `plan-review` pool sets `excludePlanAuthors`, so Jev drops every model named in the plan's `plan:` front matter and prefers a member that has not already reviewed the plan.

`taskTypes` binds each kind of work (`mechanical`, `grunt`, `lead`, `vision`, `security-review`, `plan`, `plan-review`, `frontier-review`) to exactly one pool or fixed `model`, plus an optional `effort` range and `backups`.

`models` holds each model's `supports` list and its difficulty-to-effort map for `exact`, `ordinary`, `hard`, and `critical`; `*` is the fallback map. The task-type effort range clamps the map, then the model's `supports` list trims it.

`agents.covered` lists the agents routed through task types; `agents.pinned` lists the agents that keep their bound model and receive only effort. `directiveTargets` maps a `Directive:` alias to a role.

Each quota threshold that is set requires its window: a member without that window in its usage report is not eligible.
`poolLimits` holds the shared guardrails: `demoteAt`, `skipAt`, the per-dispatch `burstPenalty`, `finalWindowMs`, usage timeout and maximum report age, clock-skew tolerance, and the failure streak and duration for demotion.
Within `finalWindowMs` of a weekly reset, unused weekly quota would be lost, so the weekly pace check and weekly crowding are lifted and the short-window cap rises to `demoteAt`.
In that stretch, in-flight burst penalties also count against the weekly window, and `skipAt` stops new work, so running tasks keep `1 - skipAt` of the quota to finish.
Usage comes from the same provider reports as `/usage`. Antigravity is read through its Gemini counter, xAI through its aggregate credit pool, and Anthropic through its shared 5-hour and weekly windows. The plugin assumes `providers.antigravityEndpoint` is `auto`.

## Development

Edit `catalog.json` and the TypeScript sources in place, then run the plugin tests:

```
bun test
```

The tests need only Bun; they mock the `@oh-my-pi/*` imports, so no OMP checkout or `bun install` is required.
CI also runs `bash -n core/install-omp.sh` and `jq empty` on the catalog and package manifests.
Changing the core patch is a separate job: rebuild it in an OMP checkout as described in [core/PATCHING.md](core/PATCHING.md).
