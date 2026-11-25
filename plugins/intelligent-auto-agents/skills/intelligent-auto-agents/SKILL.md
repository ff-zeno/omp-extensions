---
name: intelligent-auto-agents
description: Use when delegating OMP work with intelligent auto-agents enabled, including explicit user agent or model choices, recipes, or questions about automatic model selection.
---

# Intelligent auto-agents

The catalog (`catalog.json` next to the extension entrypoint, catalog v9) owns effort; OMP `modelRoles` supply models by reference; Jev routes.
Eligible automatic worker spawns get task-type/difficulty routing or pinned-worker effort selection.
Operator chat choices stay unchanged.

**The user's explicit model choice always overrides automatic routing.** `Directive: use <task type>` overrides the agent's pin; `Directive: use <model>` overrides everything except OMP core spawn locks.
Automated routing is only the default.

## Terms

- **Model**: the provider and model that runs a worker, such as `anthropic/claude-opus-5-5`.
- **Reasoning level (effort)**: a native setting the model supports: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- **OMP model role**: a name in `modelRoles` (`config.yml`). A binding (`@fast`, `@frontier-1`, `@frontier-3`, `@vision`) names one model; a role alias (`@task` = `@frontier-1:low`, `@lead` = `@frontier-1`) adds an effort or points at a binding.
- **Task type**: the kind of work Jev assigns, from the catalog `taskTypes`: `mechanical`, `commit`, `code`, `investigation`, `review`, `lead`, `vision`, `security-review`, `plan`, `plan-review`, `frontier-review`, `scout`.
- **Difficulty**: Jev's rating of the work itself on the catalog scale: `exact`, `ordinary`, `hard`, `critical`. It sets effort for mapped non-coding types; it never changes a coding slot's effort.
- **Coding slot**: one of Mechanical, Moderate difficulty, or Feature work. Jev answers it in the same call as the task type and difficulty. Each slot has one pool per mode, and each member fixes its model and effort.
- **Mode**: `speed` (default) or `cost`, the catalog `mode` field. It picks which slot pools coding work uses. Edit it by hand.
- **Per-model effort map**: the catalog `models` map from difficulty to effort, keyed by concrete provider/model id, so rebinding an OMP role picks up the new model's own map. `*` covers a resolved model with no entry, and the router reports when it uses it.
- **Pool**: an ordered model list a task type or slot draws from. Pools include `investigation`, `review`, `lead`, `plan-review`, and one per coding slot and mode. Members are ranked by quota and skipped on quota gates or difficulty exclusions. A pinned `effort` overrides the model map and task-type range. Alternatively, `effortFrom` names another role/model's mapped, range-clamped effort as the base; `effortStep` raises it within the task-type range. Target model ceilings and supported levels still apply.
- **Pinned agent**: an agent whose file fixes the model; Jev sets only its effort. Worker pins include `orchestrator`, `design-master`, `design-second`, `review-closer`, `review-verifier`, and `review-frontier-1..3`. Medium and slow1–3 remain operator chat choices, not automatic worker jobs. Automatic worker selectors using them are declined with guidance to choose a supported job.
- **Directive**: an optional marked line at the top of the task text, `Directive: use <frontier-1|frontier-2|frontier-3|lead|vision|provider/model> [effort]` or `Directive: use <task type>`.
- **Agent (job)**: what the worker is for, passed as `agent`: `task`, `sonic`, `scout`, `reviewer`, `security-reviewer`, `git`, `plan`, the `review-frontier-1..3` reviewers, and the pinned agents. The name is a hint to Jev, never a skip, except `git`, which pins `commit`, and `scout`, which pins `scout`; a `Directive: use <task type>` overrides the pin.
- **Covered agent**: an agent routed through a task type: `task`, `sonic`, `scout`, `reviewer`, `security-reviewer`, `git`, and `plan`.
- **Plan metadata**: the `plan:` front matter naming `authored-by`, `reviews`, and `synthesized-by` models.
- **Persona**: working behavior from the system prompt: Normal, Brute, or Orchestrate.
- **Recipe**: a workflow template of stages and dependencies.

A worker's effort is the resolved model's map at the rated difficulty, clamped to the task type's effort range, then fitted to a level the model supports.
A task type whose pool pins every member's effort needs no range.
Coding slots and the `investigation` pool pin every member's effort.

## Who decides what

| Decision | Owner |
|---|---|
| Inline, one worker, N workers, or an orchestrator | Parent, using the Delegation ladder in the system prompt |
| Agent (`agent`) | Parent |
| Persona | Parent: `# Mode: brute` / `# Mode: orchestrate` at the top of the task text; the `orchestrator` agent is Orchestrate. Brute for settled narrow work done as told, Normal for investigation, design choice, or review, Orchestrate only with a ready plan whose lanes run 2+ parallel streams (system prompt Delegation section). With no header, Jev picks Normal or Brute for `task`, `sonic`, and `git` workers from the catalog `personas` criteria, never Orchestrate; Normal when Jev is unsure or unavailable |
| Recipe | Parent |
| Task type and difficulty | Jev, per covered worker, except `git`, which pins the `commit` task type, and `scout`, which pins `scout`; a `Directive: use <task type>` overrides either pin. Jev also answers the coding slot |
| Pool order, model role, and effort source | Catalog and router, using the precedence below |
| Concrete model and effort validation | OMP, from `modelRoles` |

Jev never adds, removes, or reorders workers.

## Precedence

For a covered spawn the sources rank highest first:

1. An OMP core spawn lock (`modelLocked` or `effortLocked`) keeps the baseline configuration; the plugin never imposes one.
2. A `Directive:` line in the brief: `Directive: use <model|role>` names the model and always wins over quota skips, effort caps, the scout rule, planning readiness, and review author exclusion. The directive effort is fitted only to levels the model supports. `Directive: use <task type>` names the task type.
3. The agent's pinned task type from `agents.taskTypes` (`git` → `commit`, `scout` → `scout`; a directive model skips it; a directive task type overrides it).
4. The task type's pool, ranked by difficulty scope and quota.
5. The task type's fixed model.
6. The agent's own bound model.

Jev routes every unlocked spawn of the covered agents.
Workers pin OAuth logins from the machine-local account-pin file by login email, not from the catalog.
The main chat is unchanged.

## Dispatch

1. If the user names a model, role, or reasoning level, use the matching configured agent and pass `routing: "off"` on those task entries or eval agent/workpool calls.
   If nothing matches, explain the missing binding; do not substitute a model or edit global configuration.
   Example: "Independent Sol/Opus design alternatives" is a `task` batch with `design-master` and `design-second`, each with `routing: "off"`, when those roles match.
2. Otherwise pass only `agent` (job) and, when needed, a persona header. Never pass `model` or `effort`.
3. Write a `Directive:` line only when the operator named it or a skill or rule requires it, such as the frontier fan-out. This steers Jev without disabling routing. Jev ignores model names written anywhere else in the brief. One exception: after a substantive failure (a failed check or a rejected result), the second attempt may carry `Directive: use <the first attempt's model> <one reasoning level higher>`. A payment error, an unavailable dependency, an unclear permission or a broken check is not a substantive failure: fix or report it instead of raising. At the cap, keep a pinned model and the role floor and report the failure to the operator. Split only independent items with disjoint outputs; keep coupled steps with one worker and one integration owner.
4. State `solutionSpace` for the assigned slice: `one fix: ...` when its contract is fixed, `design open: ...` when its design is open. For evidence collection, name the bounded facts to gather and the decisions left to the parent; an unknown root cause in the wider project does not make collecting those facts a hard judgment job.
5. Fill each stage with concrete assignments, owned paths, shared contracts, and acceptance criteria. Dispatch independent assignments together; later stages consume earlier outputs.
6. Delegate substantive evidence collection and execution before doing its bulk in the parent. Keep conversation, decisions, integration, and genuinely trivial actions inline. Choose jobs independently of the main chat model; Medium/slow roles remain chat choices, not automatic worker selectors. A bounded worker executes its assignment directly, without recursive delegation for ceremony.
7. After a Jev intercept, retry once with a sharpened assignment from existing context: explicit difficulty and solution space; `# Mode: brute` for mechanical work; evidence-only framing for scouts. If it still blocks, report it in the turn's status line instead of doing the bulk work inline. Do not repeat an unchanged assignment. Ask the operator only for a material product, authority, or risk decision.
8. When the root cause is unknown, the parent runs two parallel root-cause agents (`investigation`) itself; Jev never adds workers.

## Recipes

Pick one only when its trigger holds.

- **single-worker**: one bounded task with settled requirements. Stage: one job worker, `# Mode: brute` when the work is done as told. No planning or review for ceremony.
- **orchestrated-lanes**: a ready plan already defines independent lanes (owned paths, contracts, acceptance) and a slice runs 2+ of them in parallel under its own integration owner. Stage: one `orchestrator` per such slice; its lane workers run `# Mode: brute` unless a lane needs judgment. Never an orchestrator over one worker.
- **plan-then-implement**: unsettled architecture. Stages: `plan` → plan review → implementation workers the parent decomposes. The plan's `plan:` front matter names the author models. The review stage is the `plan-review` task type, which the pool resolves to a non-author frontier model on a stock `reviewer` agent.
- **dual-design**: the user asked for design alternatives or a second opinion. Stage: `design-master` (`@lead`) and `design-second` (`@frontier-2`) in parallel; parent synthesizes. Not for backend work.
- **plan-review**: the user explicitly asked for full frontier plan review. Stage: one stock `reviewer` per non-author frontier model (`@frontier-1`, `@frontier-2`, `@frontier-3`), with the brief's directive naming the model. Ordinary plan review is the `plan-review` task type on one stock `reviewer` agent, not this recipe.
- **frontier-review**: independent end-of-batch diff, plan, or changed-contract review. Stage: `review-frontier-1`, `review-frontier-2`, and `review-frontier-3`; the brief's directive names each model. Each agent pins its frontier model with `thinkingLevel: high`.

## What Jev routes

Jev reads the agent name, the assignment, `solutionSpace`, and the shared batch context.
It never sees model ids.

- `task`: Jev picks the task type from the brief: `code` (settled-spec code edits, settled document drafting, requirements-grounded case writing, new tests, and bounded investigation toward a stated fix), `investigation` (finding an unknown cause, with reporting or a fix), `lead` (interfaces or architecture, trade-offs, migrations with interacting parts), `vision` (image, screenshot, or video analysis), `mechanical` (exact lookups, directed tool runs, non-code writes with exact content), `commit` (git operations), or `review` (verifying an implemented diff against a settled spec). A brief that asks to investigate but already names the fix is code, not investigation or lead. For `code`, Jev also answers the coding slot (see below).
- `git`: pinned to the `commit` task type, which uses the Mechanical slot, for commits, branches, merges, pull requests, and other git operations; `Directive: use <task type>` overrides the pin. Git operations still need explicit user authorization.
- `scout`: pinned to the `scout` task type, which uses the Mechanical slot and is never offered to Jev; `Directive: use <task type>` overrides the pin. Scouts do bounded, read-only evidence collection, never lead or hard/critical judgment. Rate the collection slice, not the surrounding project's unresolved problem; reframe assignments that ask the scout to decide architecture or root cause.
- `sonic`: Jev picks the task type; `mechanical` for non-code writes with exact content (docs text, config values, data files) and directed tool runs, and `code`, `commit`, or `review` for source work. Use `task` for source-code edits. A lookup whose targets are fully specified can rate exact.
- `reviewer`: uses `review` for reviewing an implemented diff against a settled spec, and `plan-review` (or `frontier-review`) when the assignment reviews a plan; `Directive: use lead` when judging whether the design itself is right.
- `security-reviewer`: `security-review`, sharing the quota-aware `lead` pool at high to xhigh.
- `plan`: the `plan` task type, sharing the quota-aware `lead` pool at medium to xhigh. A top-level `plan` spawn first gets a readiness check that can pause it for discussion with the user.
- `plan-review`: the `plan-review` task type. Its pool is `@frontier-2`, then `@frontier-1`, then `@frontier-3`, and the router drops any member whose model authored the plan. Plan documents carry front matter under the `plan` key with `authored-by`, `reviews`, and `synthesized-by`; the router prefers members absent from `reviews`, reuses the first non-author when every non-author has reviewed, and falls back to the first pool member with `plan author unknown` when it finds no metadata.
- `review-frontier-*`: pinned frontier reviewers review either a diff or a plan as their brief directs. Jev sets only effort from the bound model's map unless a directive names a model. The `frontier-review` task type's range is high to xhigh.

Pinned agents keep their bound `modelRoles`; Jev sets only effort from the model's difficulty-to-effort map:

- `orchestrator` pins `@orchestrator`.
- `design-master` pins `@lead`; `design-second` pins `@frontier-2`.
- `review-closer` and `review-verifier` pin `@lead`.
- Frontier reviewers `review-frontier-1`, `review-frontier-2`, and `review-frontier-3` pin `@frontier-1`, `@frontier-2`, and `@frontier-3`.

A pool member scoped with `difficulties` serves only those levels.
Coding work uses three slots: Mechanical, Moderate difficulty, and Feature work.
`mechanical`, `commit`, and `scout` use Mechanical.
`code` asks Jev, in the same call that picks the task type and difficulty.
A confident answer wins; when Jev is unsure, the higher of its two likeliest slots wins; with no usable answer the slot is Feature work.
A slot answer never bounces the spawn back to the parent.
Each slot has one pool per mode.
Members fix model and effort per provider and are tried in the order Anthropic, OpenAI, Grok 4.6, HY4 Flash, DeepSeek V4.1 Flash.
This is the operator's decision of 2026-11-25; it replaces the 2026-11-15 OpenAI-first order.
Difficulty never changes a slot's effort.
Urgent coding uses Sonnet 5.5 high.
HY4 Flash and DeepSeek V4.1 Flash come through provider `opencode-go` (`opencode-go/hy4-flash-free`, `opencode-go/deepseek-v4.1-flash`) and have no quota gates.
The `review`, `lead`, `investigation`, and coding-slot pools fall back to `opencode-go/deepseek-v4.1-flash` when every member is skipped: high for `review`, `lead`, `investigation`, and the Mechanical slot; low for Moderate difficulty and Feature work.
The ungated `plan-review` pool instead falls back to `@frontier-2`.

Speed (default):

| Slot | Anthropic | OpenAI | Grok | HY4 Flash | DeepSeek V4.1 Flash |
|---|---|---|---|---|---|
| Feature work | Sonnet 5.5 high | Sol 6.1 medium | Grok 4.6 high | high | low |
| Moderate difficulty | Sonnet 5.5 low | Terra 6.1 high | Grok 4.6 low | low | low |
| Mechanical | Sonnet 5.5 low | Terra 6.1 low | Grok 4.6 low | high | high |

Cost differs only where shown: Anthropic is Haiku 5.5 in every slot, and a few efforts change.

| Slot | Anthropic | OpenAI | Grok | HY4 Flash | DeepSeek V4.1 Flash |
|---|---|---|---|---|---|
| Feature work | Haiku 5.5 high | Sol 6.1 medium | Grok 4.6 high | high | low |
| Moderate difficulty | Haiku 5.5 high | Terra 6.1 high | Grok 4.6 low | low | low |
| Mechanical | Haiku 5.5 low | Terra 6.1 low | Grok 4.6 low | low | high |

The `investigation` task type finds an unknown cause, and Jev rates its difficulty.
Exact and ordinary go Sonnet 5.5 high, then Sol 6.1 medium, then Grok 4.7 high.
Hard and critical go Opus 5.5 high, then Sol 6.1 high, then Grok 4.7 high.
Fable 5.2 and Astra 6.2 are chosen only when a `Directive:` names them.

The `review` pool keeps its earlier order, Anthropic, then xAI, then OpenAI (Sol 6.1).
Use a reviewer other than the model that wrote the plan or code.
The `lead`, `plan`, and `security-review` task types share the `lead` pool: `@frontier-1` → `@frontier-2` → `@frontier-3`.
Anthropic uses `minWeeklyHeadroom` 0.05; the other members use weekly headroom 0.
Opus keeps its model-map effort, clamped to high to xhigh for lead/security review and medium to xhigh for planning.
Both frontier rollover members set `effortFrom: "@frontier-1"`; frontier-2 matches that effort, while frontier-3 sets `effortStep: 1` for one level higher, capped at xhigh.
Members do not pin effort.
Remaining eligible members stay in the provider-failure retry chain.
The all-skipped fallback is `opencode-go/deepseek-v4.1-flash:high`.
Luna 5.6 is in no pool.
Gemini 4 Argon was removed on 2026-11-16.

The `review` pool, by difficulty:

| Pool | Difficulty | Anthropic | xAI (Grok) | OpenAI |
|---|---|---|---|---|
| `review` | exact | Sonnet low | Grok low | Sol low |
| `review` | ordinary | Sonnet low | Grok high | Sol medium |
| `review` | hard | Opus medium | Grok high | Sol high |
| `review` | critical | Opus high | Grok xhigh | Sol xhigh |

- Anthropic members are eligible while weekly headroom is at least 0.05 (`minWeeklyHeadroom` 0.05); Anthropic no longer reports a 5-hour window, so no member has a 5-hour gate.
- xAI (`@frontier-3`, Grok 4.6) and OpenAI (`openai-codex/gpt-6.1-terra` for Mechanical and Moderate difficulty, `openai-codex/gpt-6.1-sol` for Feature work, review, and investigation) share `minWeeklyHeadroom` 0: eligible while weekly usage is not ahead of the weekly pace. Neither has a monthly gate; both report only a 7-day window. Neither has a short-window gate. OpenCode Go members have no gates.
- Every provider's in-flight burst penalty counts against its weekly window for crowding and skipping, but not for the pace (headroom) check, so a freshly reset window stays on pace while dispatches are in flight.
- Within 6 hours after a reset, a window with less than 3% real usage counts as exactly on pace (`freshWindowMs`, `freshWindowMaxUsed`); Anthropic's 0.05 reserve still applies, so Anthropic subagents stay gated early in the week.
- A gated member with no usage report, or a report that lacks a valid gated window, gets `no-usage` and is ranked last after crowded members; stale and partial reports still exclude.
- A window at or above `demoteAt` 0.8 crowds a member; at or above `skipAt` 0.95, or exhausted, it is skipped.
- Within 12 hours of a weekly reset, weekly crowding is lifted; within 5 hours, the weekly pace check and weekly `skipAt` are lifted for every provider except Anthropic (weekly exhaustion still stops new work). Anthropic skips workers once its weekly use is 95% or more, which keeps 5% for chat (`finalWindowReserve`).
- `poolLimits.ignoreQuota` lists providers that skip all usage ranking; it is `[]`, so every provider, OpenAI included, is paced. Failure demotion still applies. Add a provider id to turn it on; remove the id to turn it off.
- Ungated members (the `plan-review` pool) have no usage-window gates; only failure demotion applies.
- `@fast` (Haiku 5.5) always runs at xhigh, never max (catalog `maxEffort: xhigh`) when a pool names it without a pinned effort; the slot pools pin their own efforts.
- `anthropic/claude-sonnet-5-5` has no OMP role. It is no longer capped at low.
- `reviewOnly` restricts protected aliases (`@frontier-2`, `@slow2`, `@advisor`, `@manager`) to the `plan-review` and `lead` pools; the slot and mechanical pools still reject them. Literal Terra and Sol serve the worker pools.
- `blockedDirectiveTargets` excludes Luna and Astra from catalog directive alias definitions, not from the user's directives. Luna is in no pool; the `web` role still names it literally. Explicit literal-model directives bypass automatic routing.
- Fable 5.2 and Astra 6.2 are never routed automatically; a `Directive:` naming the literal model still reaches it.
- Every rule above lives in the plugin's `catalog.json`; change routing there, not in the plugin's TypeScript.
- Design and frontier seats keep their bound model; Jev sets only effort.
- Only fixed `vision` carries a provider-failure `@lead` backup without quota checks; `lead`, `plan`, and `security-review` use their quota-ranked pool retry chain.

A top-level planning request first passes the catalog readiness check.
An autonomous planner is allowed only when requirements, target files, acceptance criteria, and technical constraints are concrete.
The planner must not need to guess product preferences or architectural trade-offs.
Otherwise the parent should discuss the open choices with the user first.

Image questions do not go through Jev: `read <image>?q=` and attached-image descriptions use the configured `vision` role directly.

## Plan review

Plan documents open with `plan:` YAML front matter naming the models that worked on them:

```yaml
---
plan:
  authored-by:
    - model: anthropic/claude-opus-5-5
      effort: high
  reviews:
    - model: openai-codex/gpt-6.1-sol
      kind: adversarial            # adversarial | peer | frontier
      verdict: changes-requested   # passed | changes-requested
---
```

The `plan-review` pool sets `excludePlanAuthors`.
The router drops every model named as an author and prefers a member that has not already reviewed the plan.
A missing or unparsable document leaves the pool order unchanged and reports `plan author unknown`.
Explicit model directives bypass this exclusion.

## Media tasks

Image or video analysis that needs a worker goes to `task`; other agents keep their normal routing.
Jev reads the brief and picks the `vision` task type (`@vision`, Claude Opus, with `@lead` as backup) when the work is mainly looking at visual media.
The task type's effort range is medium to high.
A code change that merely mentions an image or video stays on its normal task type.
There is no keyword or file-extension detector.
To force media routing, add `Directive: use vision` to the brief.

## TypeSafe authentication

Jev evaluates routing requests through TypeSafe.
Authenticate with `/login typesafe` or set `TYPESAFE_API_KEY`.
Without a TypeSafe key, ordinary automatic jobs return a routing-unavailable block/reason to the parent instead of silently keeping the configured model.
Task-type directives still require confident necessary difficulty.

## Visibility and fallback

Every hook outcome is recorded as an `intelligent-auto-agents-decision` session entry: `source: "jev"` (classified), `"catalog"` (fixed task-type model, no Jev call), or `"baseline"` with a reason (Jev failure, low confidence, routing off, locked, no qualifying pool member).
The entry stores routing metadata rather than assignment text.
`/auto-agents status` shows on/off, the catalog version, the Jev model, and the last routing line.
`/auto-agents off` disables routing for the session.
`/auto-agents on` enables routing for the session.
Routing is on by default.
General automatic jobs return a clarification/block reason when type or required difficulty is uncertain or classification is unavailable, rather than silently retaining the configured premium model.
The parent clarifies once using existing context.
Intentional named-model and pinned review jobs keep their explicit model choices; existing workers and the current chat keep their models.
Routing disabled, explicit model/effort locks, and unresolvable pools preserve their baseline behavior.
The configured `task` baseline remains `@frontier-1:low` for deliberate routing opt-outs; it is no longer the uncertainty fallback for general automatically routed jobs.
Quota is not a global dispatch cap: `plan-review` members are ungated, missing usage can still select Anthropic, and a failed usage fetch preserves pool order.
Directive models and pinned agents intentionally bypass pool gates.
All-skipped worker fallbacks do not recheck quota.
The shipped catalog no longer exempts Codex from the existing quota-ranking mechanism.
`catalog.json` is re-read on each spawn when its mtime changes.
TypeScript changes still need a new OMP process.
The portable OMP profile also keeps provider-failure chains without quota checks: web search can fall back to Anthropic Haiku 4.5.
These are profile retry settings, not Jev pool policy.
The Gemini 3.8 Flash → Opus chain was removed with the banned Antigravity account on 2026-11-16.

## Role configuration

Jev reads its pools, task types, directive targets, and difficulty maps from `catalog.json` next to the extension entrypoint.
Edit it only when changing pool membership or order, task-type ownership, difficulty-to-effort maps, readiness wording, limits, or the Jev model selector.
Keep the catalog version and schema valid.
Point each pool's fallback at a resolvable role alias or literal model.
Keep each task type bound to exactly one pool, model, or coding slot; `frontier-review` instead uses the named model from the brief.
