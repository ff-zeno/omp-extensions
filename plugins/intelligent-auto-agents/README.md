# Intelligent auto-agents

This OMP extension routes eligible subagent spawns through Jev, a TypeSafe-backed classifier described by `catalog.json` (catalog v9).

**The user's explicit model choice always overrides automatic routing.** `Directive: use <task type>` overrides the agent's pin; `Directive: use <model>` (a `directiveTargets` alias or a literal `provider/model`, with an optional effort) overrides everything, including quota skips, effort caps, the scout rule, planning readiness, and review author exclusion. Only OMP core's own `modelLocked`/`effortLocked` can stop it. Automated routing is only the default.

Jev selects a task type, rates task difficulty against the catalog ladder, resolves the model's effort from its difficulty-to-effort map, ranks pool members by quota, and records routing metadata.

When the parent names no persona, Jev also suggests one for the worker (Normal or Brute) in the same classifier call; see [Persona suggestions](#persona-suggestions).

A brief can steer Jev with a `Directive: use <alias|model> [effort]` line. Precedence is an OMP core spawn lock, then a directive model, then a directive task type, then the agent's pinned `agents.taskTypes` entry, then pool, then a fixed task-type model, then the agent's bound `modelRoles` selector.

Jev keeps routed backups in the retry chain when the patched OMP core is installed.

Jev does not add, remove, reorder, or execute workers.

Jev does not override explicit model requests, per-agent model overrides, explicit effort requests, or `routing: "off"`.

Automatic `medium`, `slow1`, `slow2`, and `slow3` selectors are chat-only and decline with guidance to choose a supported worker job instead; they never dispatch a worker through Jev. Deliberate named or pinned review requests keep their explicit baseline behavior. Scout assignments are bounded, read-only evidence collection and stay on economical mechanical exact/ordinary work; architecture or root-cause judgment must be reframed.

Jev does not change the current chat model.

Jev records routing metadata without persisting assignment text, credentials, or provider errors.

## Install

The extension has two parts.
The plugin (bundled agents, the skill, `/auto-agents`, and the routing hook) loads on stock OMP.
The patched OMP build lets the hook set each subagent's model and thinking level; without it the plugin loads and Jev routing stays disabled.

Requirements:
- OMP 19.1.1. The bundled patch targets that release; another release needs a rebased patch (see [core/PATCHING.md](core/PATCHING.md)).
- `git` and Bun 1.4.4 or newer to build the patched OMP (OMP 19.1.1 declares `bun@>=1.4.4`). Running the plugin needs only OMP.
- `sha256sum` (Linux) or `shasum` (macOS) for the installer.
- Rust `cargo` from rustup only when no matching prebuilt native addon is in `~/.omp/natives/<version>`; running the stock `omp` once fills that directory.
- A TypeSafe API key for Jev (see [TypeSafe authentication](#typesafe-authentication)). Without one, ordinary automatic spawns (`task`, `sonic`, `scout`, and the other covered agents) stop and ask the parent to clarify instead of running; pinned agents and briefs that name a model keep their configured model.

### Setup checklist

Run these steps in order and check each result before the next; an AI agent setting this up can follow them as written.

1. Install stock OMP 19.1.1 and confirm `omp --version` prints `omp/19.1.1`:
   ```
   curl -fsSL https://omp.sh/install | sh -s -- --binary --ref v19.1.1
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
7. Spawn one `task` subagent, then run `/auto-agents status` again. The latest routing line names a task type and model. A line with `fallback · routing auth · baseline kept` means OMP found no TypeSafe key, and the spawn returns a routing-unavailable reason to the parent.

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

The extension requires OMP subagent routing API v2 from the pinned OMP 19.1.1 source commit `31ffee513f27a01bba7d4dfbe12bae239cdc646a`.
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

Without a key, each ordinary automatically routed spawn records a baseline decision with reason `routing-auth` and blocks with a parent-clarification reason instead of silently using the configured model. The same block behavior applies when Jev times out, returns invalid data, or leaves task type or difficulty unclear. Chat-only `medium`/`slow1`/`slow2`/`slow3` selectors decline before classification with guidance to choose a supported worker job. Explicit model requests, routing locks, intentional `routing: "off"`, and deliberate named/pinned review requests retain their existing behavior.

Media tasks follow the same rules: Jev picks the `vision` task type from the brief, and `Directive: use vision` forces it.

## Model roles

The catalog and bundled agent frontmatter reference these `modelRoles` names.

`frontier-1`, `frontier-2`, and `frontier-3` are the three frontier models. `lead` aliases one of them, and the pinned `review-frontier-1`, `review-frontier-2`, and `review-frontier-3` agents pin one frontier role each. `fast` is the cheap Anthropic member that follows OpenAI in the exact and ordinary cells of the worker pools, `task` is the unrouted baseline worker (`@frontier-1:low`, Opus), `vision` serves the `vision` task type, and `orchestrator` binds the bundled `orchestrator` agent.

Coding work goes through three slots: Mechanical, Moderate difficulty, and Feature work. Each slot has one pool per mode (see [Mode: speed or cost](#mode-speed-or-cost)) whose members fix model and effort per provider and are tried in order Anthropic → OpenAI (`openai-codex/gpt-6.1-terra` or `openai-codex/gpt-6.1-sol`) → Grok 4.6 → `opencode-go/hy4-flash-free` → `opencode-go/deepseek-v4.1-flash`. Difficulty never changes a slot's effort. The author chose these values on 2026-11-25; edit the `slots` pools in `catalog.json` to use your own.

Sonnet has no role. The catalog names it as the literal `anthropic/claude-sonnet-5-5`; it is no longer capped at low.

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
  fast: your-provider/your-fast-model
  vision: your-provider/your-vision-model:high
  orchestrator: your-provider/your-fast-model
  task: "@frontier-1:low"
```

Role aliases are resolved by OMP, so the placeholder selectors must be replaced with models configured on your machine.

OMP's built-in roles `plan` and `commit` are used by the bundled `plan` and `git` agents and need no entry unless you want to override them.

Every pool member or task type whose role stays unbound is skipped, and a spawn with no resolvable option keeps its configured model and effort; the extension never fails a spawn because a role is missing.

## Bundled agents and discovery

This package bundles `orchestrator`, `design-master`, `design-second`, `review-frontier-1`, `review-frontier-2`, `review-frontier-3`, `plan`, and `git`.

OMP also supplies its built-in `task`, `scout`, `sonic`, `reviewer`, and `security-reviewer` agents used by the catalog. The pinned `review-closer` and `review-verifier` agents are profile agents, not bundled here.

OMP 19.1.1 discovers the nearest project `.omp/agents` directory first, then the user agent directory `~/.omp/agent/agents`, then enabled extension package agent directories, and finally bundled agents.

Therefore a project or user agent with the same exact, case-sensitive name wins over this package's bundled copy.

Earlier extension roots also win over later extension roots, and invalid files are skipped with a warning.

See [OMP 19.1.1 task-agent discovery](https://github.com/can1357/oh-my-pi/blob/31ffee513f27a01bba7d4dfbe12bae239cdc646a/docs/task-agent-discovery.md#merge-and-collision-rules) for the precedence and collision rules.

## `/auto-agents`

Use `/auto-agents status` to show whether routing is enabled, the catalog version, the Jev model, and the latest routing line.

Use `/auto-agents off` to disable routing for the current session.

Use `/auto-agents on` to enable routing for the current session.

The command never changes the current chat model.

## Split test

No split test is running; the `worker-split-2026-11` test ended on 2026-11-25 and its `experiment` block was removed from `catalog.json`.
The rotation code stays: adding an `experiment` block to the catalog starts a new test, which replaces the named pools with a round-robin rotation of its candidates until its end date.

## Editing `catalog.json`

`catalog.json` next to `index.ts` holds every routing decision: pools, task types, directive targets, difficulty-to-effort maps, Jev's instructions, readiness wording, model restrictions, quota limits, and the Jev model selector.
The TypeScript validates and applies the catalog but carries no model names or routing preferences of its own, so change routing here rather than in code.
Each `before_subagent_spawn` and `/auto-agents` re-reads `catalog.json` when its mtime changes, so pool and quota edits apply to the next `task` spawn in an already-open session.
Invalid JSON or a catalog that fails validation keeps the last valid catalog.
TypeScript or plugin-code changes still need a new OMP process.

Workers pin OAuth logins from the machine-local file `~/.omp/agent/account-pin.yml`. That file is not part of this plugin and must not hold emails in the repo. Each key is an OMP provider; each value is the login email. `account:` applies to every provider that has that login. The main chat is unchanged. The next worker spawn reads the file.


Keep the catalog version and schema valid; the plugin refuses to load a catalog that fails validation.

`jevInstructions` holds the instructions Jev receives for the task-type question (`route`) and the difficulty rating (`difficulty`). The instructions distinguish bounded scout evidence collection, settled document drafting, requirements-grounded case writing, and open architecture or root-cause judgment. `difficulty` describes each level, and `nuances` lists judgment notes passed to Jev verbatim.

`planningReadiness` gates planning spawns: for a top-level spawn of an agent in `agents`, Jev answers `instructions` with one of `routes` (`autonomous-plan` or `discuss-with-user`), and `discuss-with-user` blocks the spawn so the main chat settles the open questions first.

`pools` names ordered worker pools; the shipped catalog has `mechanical`, `commit`, `code`, `review`, `lead`, and `plan-review`. Each pool lists ordered `members`, each naming a role alias or a literal `provider/model`, plus a `fallback`. A member may set `effort` (pins its effort), `difficulties` (the levels it serves; absent means every level), and the quota gates `maxShortUsed`, `minWeeklyHeadroom`, and `minMonthlyHeadroom`. A pool with `excludePlanAuthors` drops every model named in the plan's `plan:` front matter and prefers a member that has not already reviewed the plan.

Pool members may set `effortFrom` to use another role/model's mapped, task-range-clamped effort as their base and `effortStep` to raise it by a nonnegative number of levels, capped by the task-type range. Target model effort ceilings and supported levels still apply. These fields cannot be combined with pinned `effort`; a missing source model excludes that member. Only the shipped `lead` pool uses them; other pools and global model maps are unchanged.

`taskTypes` binds each kind of work (`mechanical`, `commit`, `code`, `investigation`, `review`, `lead`, `vision`, `security-review`, `plan`, `plan-review`, `frontier-review`, `scout`) to exactly one existing pool, a fixed `model`, or a coding `slot`, plus an optional `effort` range and `backups`. `slot` names a slot id or `ask`; a slot task type names no pool or model. `mechanical` and `commit` use the Mechanical slot, `code` asks Jev, and `scout` uses the Mechanical slot with `fixedOnly: true`, so Jev never offers it and only the `scout` agent pin or a directive reaches it. A spawn that may land on an `ask` task type gets the slot question in the same Jev call as the task type and difficulty; there is no extra call. A confident answer wins; an answer under `minConfidence` takes the higher of the two likeliest slots; no usable answer takes Feature work. A slot answer never sends the spawn back to the parent.

`investigation` (finding a cause, not fixing it) uses the `investigation` pool, and Jev rates its difficulty: exact and ordinary go Sonnet 5.5 high → Sol 6.1 medium → Grok 4.7 high; hard and critical go Opus 5.5 high → Sol 6.1 high → Grok 4.7 high. Fable 5.2 and Astra 6.2 are never chosen automatically; a brief's `Directive:` naming the literal model still routes to it.

`lead` (open design decisions and root-cause work), `plan` (writing implementation plans), and `security-review` share the quota-aware `lead` pool: `@frontier-1` → `@frontier-2` → `@frontier-3`. Anthropic uses `minWeeklyHeadroom: 0.05`; the other members use `minWeeklyHeadroom: 0`. The primary's difficulty-map effort is clamped to high–xhigh for lead/security review and medium–xhigh for planning. Both frontier rollover members set `effortFrom: "@frontier-1"`: frontier-2 matches the primary's effort, while frontier-3 sets `effortStep: 1` and runs one step higher, capped by the task type's xhigh ceiling. No member pins effort. Remaining eligible members stay in the provider-failure retry chain; the all-skipped fallback is `opencode-go/deepseek-v4.1-flash:high`.

Quota checks are not a hard global dispatch cap. `plan-review` members are ungated; missing usage is ranked last (a failed usage fetch preserves pool order); uncertain or failed automatic task-type or difficulty classification blocks for parent clarification, while routing off and deliberate named/pinned review requests retain their explicit behavior. Fixed `vision` retains its provider-failure `@lead` backup without quota checks. When every member is skipped, each pool uses its `fallback`, `opencode-go/deepseek-v4.1-flash` (high for `lead`, `review`, `investigation`, and the Mechanical slot pools; low for the Feature work and Moderate difficulty slot pools), without rechecking the fallback's quota. A `Directive: use <model>` is never refused, skipped, or rerouted by any of this, even with routing off; chat-only `medium`/`slow1`/`slow2`/`slow3` selectors decline before classification only when no directive model is present. For `poolLimits.ignoreQuota` see [ignoreQuota](#ignorequota).

`models` holds each model's `supports` list and its difficulty-to-effort map for `exact`, `ordinary`, `hard`, and `critical`; `*` is the fallback map. The task-type effort range clamps the map, then the model's `supports` list trims it. An optional `maxEffort` caps the model even when a pool member pins a higher effort, but never caps an effort named by a directive. `opencode-go/deepseek-v4.1-flash` supports `low`, `high`, and `max`, which covers the efforts its pool fallbacks use.

`reviewOnly` restricts protected model references. A reference matching `reviewOnly.models` or containing a `reviewOnly.containing` substring may appear only in pools named in `reviewOnly.pools`, never in fixed task-type models or backups. The shipped allowlist is `plan-review` and `lead`, so `@frontier-2` can serve the lead pool but remains rejected in code and mechanical pools. The literal Sol id remains allowed in ordinary worker pools.

`agents.covered` lists the agents routed through task types; `agents.pinned` lists the agents that keep their bound model and receive only effort. Chat-only `medium`, `slow1`, `slow2`, and `slow3` selectors decline before Jev classification; deliberate named/pinned review requests retain their bound model when Jev is unavailable. A directive model applies to every agent, covered, pinned, chat-only, or unknown. `agents.taskTypes` pins a fixed task type to a covered agent (`git` → `commit`); a directive model skips it and a `Directive: use <task type>` overrides it. A pin on an uncovered agent or an unknown task type is rejected. Other covered agents, `reviewer` included, still get every task type Jev offers. `directiveTargets` maps a `Directive:` alias to a role, and `blockedDirectiveTargets` lists case-insensitive substrings no catalog alias definition may contain. It only constrains the aliases the catalog defines; a user's `Directive: use <literal provider/model>` naming such a model (Astra, Luna) is always followed.

`personas` controls the persona suggestion: `agents` lists the agents Jev suggests a persona for, `instructions` and `criteria` (one description per persona, `normal` and `brute`) go to Jev verbatim, and `maxDifficulty` caps Brute: a worker rated harder than this level, or not rated at all, gets Normal.

A gated member whose provider has no usage report, or whose report lacks a valid gated window, gets status `no-usage` and is ranked last, after crowded members.
Below-pace, stale, and partial reports still exclude a member.
The pace (headroom) check compares real usage with elapsed window time; in-flight burst penalties count toward crowding and skipping only, so a freshly reset window is not pushed behind pace by its own dispatches.
No shipped member sets `minMonthlyHeadroom`.
`poolLimits` holds the shared guardrails: `demoteAt`, `skipAt`, the per-dispatch `burstPenalty`, `burstPenaltyWindow` (which quota window a provider's in-flight burst penalty counts against, keyed by provider with a required `*` default; the shipped catalog sets `*` to `weekly`, because no gated provider reports a 5-hour window any more), `finalWindowMs`, `weeklyCrowdLiftMs`, usage timeout and maximum report age, clock-skew tolerance, the failure streak and duration for demotion, and `ignoreQuota` (provider ids that skip usage ranking).
Within `weeklyCrowdLiftMs` of a weekly reset, weekly crowding at `demoteAt` is lifted.
Within `freshWindowMs` (6 hours) after a reset, a window whose real usage is below `freshWindowMaxUsed` (3%) counts as exactly on pace (headroom 0), because elapsed time is still near zero. A member that needs extra headroom, such as Anthropic's 0.05 reserve, stays gated; all other gates still apply.
Within `finalWindowMs` (the last 5 hours) of a weekly reset, the weekly pace check and the weekly `skipAt` are lifted (only exhaustion still stops new work), burst penalties also count against the weekly window, and the short-window cap rises to `demoteAt`. A provider listed in `finalWindowReserve` keeps that share of its weekly quota for chat sessions: in the final window its members are skipped once weekly use reaches 1 minus the share. The shipped catalog sets `anthropic: 0.05`, so Anthropic takes no workers once less than 5% of its week remains; other providers get the full lift.
Usage comes from the same provider reports as `/usage`. xAI is read through its aggregate credit pool, and Anthropic through its shared weekly windows (Anthropic no longer reports a 5-hour window). A member that sets `maxShortUsed` requires a 5-hour window, so a provider without one ranks that member as `no-usage`; no shipped member sets it.

### Mode: speed or cost

`mode` in `catalog.json` picks which slot table coding work uses: `"speed"` (the default) or `"cost"`. Cost differs from speed only where the Cost table differs (Haiku 5.5 instead of Sonnet 5.5 for Anthropic in every slot, and a few efforts). To switch, edit `mode` by hand; the catalog is re-read on the next spawn, so the change applies to new spawns at once. `slots.pools` maps each mode and slot to its pool; `modeDescription` repeats these instructions in the file.

### ignoreQuota

`poolLimits.ignoreQuota` lists provider ids whose members skip all usage-based ranking (pace, crowding, `skipAt`, headroom); failure demotion still applies. The shipped catalog sets it to `[]`, so every provider, OpenAI included, is paced. To turn it on for a provider, add its id, for example `"ignoreQuota": ["openai-codex"]`; to turn it off, remove the id or set `[]`. `ignoreQuotaDescription` repeats this in the file.

## Subagent rules, guidance lines and leaf tool sets

`guidance.json` beside `catalog.json` holds what the plugin adds to a task subagent in its `before_agent_start` handler (`guidance.ts`).
Main sessions and `/tan` clones are never touched; the plugin decides that a session is a child from `ctx.agent` only.

- **Subagent block** (`block`): the `<subagent-rules>` text, inserted after `<project-context>`. Children receive no `AGENTS.md`, so the block carries the operator rules they lack. Its rows tagged `G1` (the scope rule) and `R1` (the repository-read sentence) can be switched off on their own.
- **Guidance lines** (`lines`): each has an ID, a scope (`all`, `family`, `models` or `roles`), text, evidence and an `enabled` flag. A `family` or `models` scope may also list `roles`; then the model and the role must both match. Selected lines go in one `<worker-guidance>` block at the end of the prompt, ordered shared, family, model, role. `editFormat: "hash-anchored"` limits a line to children whose `edit` tool is the hashline one.
- **Leaf tool set** (`toolSets.G8`): implementer, scout, reviewer, verifier, git and design roles lose `task` and `wait`. A set only removes tools from the child's active set, so it never adds one. Planners and orchestrators (agent `orchestrator`, or a `# Mode: orchestrate` child) keep them. The eval `agent()` and `workpool` helpers are not closed by this set; see the limits below.

Every switch ships on except `G13` and `G17`: `block`, `G1`, `R1`, `G8` and every other line. The operator switched them on 2026-11-25.
`G13` and `G17` ship off since 2026-11-25 because they repeat the SYSTEM.md Tool Policy; the Bash Interceptor also enforces `G17`.
To switch entries off for one run, set `IAA_GUIDANCE_OVERRIDES` with `false` values (see below). The release and rollback rules in the later notes §6 ("Production defaults in the extension") still say when a switch should go back off.

Family and model lines key on the model the request goes to. OMP does not rerun `before_agent_start` after a retry fallback, so these lines attach only when every model in the child's known chain is in their scope. The known chain is the list the parent's `before_subagent_spawn` saw: core's `patterns`, replaced by Jev's list when Jev routes. When that hook did not fire (`routing: "off"`), the chain is unknown and the child gets shared and role lines only, as does a chain that crosses families.

The role is resolved once per child session and reused for the tool set, role lines and the record. A child's persona mode comes from session-persona's `resolveChildMode`, which settles the mode on first read and caches it, so `mode: "orchestrate"` without a header resolves the same whichever plugin's handler runs first. Without session-persona, a `# Mode:` header in the assignment is read instead. Running the handler again rebuilds the same prompt and tool set.

Each child appends one `intelligent-auto-agents-decision` entry with `source: "guidance"`: the role, the model the lines were keyed on, the chain, the block switches, the line IDs, the tool set with the tools it removed, and `openSpawnRoutes`: the routes in `guidance.json` `spawnRoutes` whose tools the child still has. OMP's spawn policy and depth limit can still refuse a route listed there.

### Switching entries per run

Set `IAA_GUIDANCE_OVERRIDES` to a JSON object of ID to boolean before OMP starts, for example `{"R1":false,"G8":false}`. A `false` value switches that entry off for the run.
IDs: `block`, `G1`, `R1`, `G8`, and every line ID in `guidance.json`. A missing ID keeps its default; an unknown ID logs a warning; malformed JSON or a non-boolean value fails at load.
The variable only changes which entries attach. A switched-on line still attaches only within its scope.

### Known limits

- Known open route: a leaf with `eval` can still spawn through `agent()` and `workpool` (`spawnRoutes` entries with `knownOpen`). Those helpers check the session spawn policy, which OMP fixes from the agent's `spawns` front matter when it creates the child; an extension cannot change it, and `routing: "off"` skips `before_subagent_spawn`.
- A chain from `retry.fallbackChains` for the primary selector, role or `default` is appended by core into the child's settings (`task/executor.ts:345-383`). The extension API exposes no settings, so that part is not in the known chain. A child pinned to one model whose config has such an entry can still receive family lines.

## Review notes on returned results

`review-notes.json` holds per-model checks that `review-notes.ts` adds to a returned subagent result.
When a result arrives, a `context` handler puts a `<review-note>` just before the block's `</task-result>`.
The note names the model and its effort, flags a retry fallback, and lists 1 to 5 checks to run before accepting the work.
Example: ``Returned by GPT-6.1 Terra (medium). Before you accept: It adds test files outside the brief: run `git status` and compare the file list with the brief. …``

- Each entry is keyed by a model family and matches with the same patterns and matcher as `guidance.json`. Families missing from `guidance.json` are defined in the file's own `families`.
- Each check cites `MT-xxx` findings from the model-traits digest. A model with no logged findings has no entry and gets no note.
- A check warns about a habit logged for that model and gives one small action. The coordinator does that action from the returned report or with one cheap command: `git status`, `git diff --stat`, running the tests, or one grep. A check never asks the coordinator to read a transcript, an error trail or a whole diff.
- Advice that holds for every model does not belong in a note, so an entry can have a single check.
- The handler reads only `task` and `wait` tool results and `async-result` notices. It skips a block without a `model` attribute, and it never adds a second note to a block.
- It runs in every session. A child sees `<task-result>` blocks only for agents it started, so a coordinating child gets notes for its own workers.

Every entry ships on. The operator switched all of them on 2026-11-25.
To switch entries off for one run, set `IAA_REVIEW_NOTE_OVERRIDES` to a JSON object of ID to boolean before OMP starts, for example `{"RN-terra":false,"RN-luna-6":false}`.
A missing ID keeps its default; an unknown ID logs a warning; malformed JSON fails at load.

The note needs the patched OMP (see [Patched OMP requirement](#patched-omp-requirement)).
Stock OMP writes no `model` attribute on `<task-result>`, so no block matches and nothing is added.

## Persona suggestions

Jev answers one extra question per spawn of an agent in `personas.agents`: should the worker run Normal or Brute.
An answer below `minConfidence` is dropped, and Brute above `personas.maxDifficulty` becomes Normal.
Jev never suggests Orchestrate; that needs a ready plan with parallel lanes, which one assignment cannot show.

The suggestion goes into the `Symbol.for("omp.persona-suggestions.v1")` registry, a `Map` keyed by `<parent agent id>:<spawn key>` holding `{ persona, createdAt }`; entries expire after 60 seconds.
For `task` spawns the spawn key is the child's agent id, so the child finds its entry as `<parentId>:<id>`.
The companion `session-persona` plugin reads and removes the entry when the child starts, and applies it only when the parent gave no explicit persona.
Without `session-persona`, the registry is written and ignored.
The routing line shows `suggests brute persona` when Jev suggested Brute, and the decision record carries `persona` and `personaConfidence`.

## Development

Change routing in `catalog.json`; change the TypeScript only for new mechanics. Then run the plugin tests:

```
bun test
```

The tests need only Bun; they mock the `@oh-my-pi/*` imports, so no OMP checkout or `bun install` is required.
CI also runs `bash -n core/install-omp.sh` and `jq empty` on the catalog and package manifests.
Changing the core patch is a separate job: rebuild it in an OMP checkout as described in [core/PATCHING.md](core/PATCHING.md).
