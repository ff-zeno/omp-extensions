---
name: intelligent-auto-agents
description: Use when delegating OMP work with intelligent auto-agents enabled, including explicit user agent or model choices, recipes, or questions about automatic model selection.
---

# Intelligent auto-agents

Jev is the router described by `catalog.json` (catalog v9). Eligible automatic worker spawns get task-type/difficulty routing or pinned-worker effort selection; operator chat choices stay unchanged.

## Terms

- **Model** means the provider and model that runs a worker.
- **Effort** means the reasoning level a model supports, such as `low`, `medium`, `high`, `xhigh`, or `max`.
- **OMP model role** means a name in `modelRoles` from `config.yml`.
- **Role alias** means a selector such as `@fast` or `@frontier-2` that resolves through `modelRoles`.
- **Job** means the worker purpose selected with the `agent` field.
- **Covered agent** means an agent routed through a task type: `task`, `sonic`, `scout`, `reviewer`, `security-reviewer`, `git`, and `plan`.
- **Pinned agent** means a worker that keeps its bound model while Jev sets only effort: `orchestrator`, `design-master`, `design-second`, `review-closer`, `review-verifier`, `review-frontier-1`, `review-frontier-2`, and `review-frontier-3`. Medium/slow1–3 are chat-only choices; automatic worker selectors using them are declined with guidance to choose a supported job.
- **Task type** means a named kind of work — `mechanical`, `commit`, `code`, `review`, `lead`, `vision`, `security-review`, `plan`, `plan-review`, `frontier-review` — with a fixed model or a pool, plus an effort range.
- **Pool** means an ordered member list (`mechanical`, `commit`, `code`, `review`, `lead`, `plan-review`) that Jev ranks by quota before each spawn.
- **Difficulty** means `exact`, `ordinary`, `hard`, or `critical`, rated from the work itself.
- **Difficulty-to-effort map** means the per-model effort for each difficulty; the task-type range clamps it and the model's supported efforts trim it.
- **Directive** means a `Directive:` line in the brief naming a role alias, literal model, or task type, with an optional effort.
- **Plan metadata** means the `plan:` front matter naming `authored-by`, `reviews`, and `synthesized-by` models.
- **Persona** means the working behavior selected by the task text, such as Normal, Brute, or Orchestrate.
- **Recipe** means a workflow template with stages and dependencies.

## Who decides what

| Decision | Owner |
|---|---|
| Inline work, one worker, multiple workers, or an orchestrator | Parent |
| Job selected in `agent` | Parent |
| Persona selected by `# Mode: brute` or `# Mode: orchestrate`: Brute for settled narrow work done as told, Normal for investigation, design choice, or review, Orchestrate only with a ready plan whose lanes run 2+ parallel streams | Parent |
| Persona when the parent named none: Normal or Brute for `task`, `sonic`, and `git` workers, never Orchestrate; Normal when Jev is unsure or unavailable | Jev, from `catalog.json` `personas` |
| Recipe | Parent |
| Task type, difficulty, pool order, model role, and effort | Jev, from `catalog.json`, except `git`, which pins the `commit` task type |
| Concrete model and effort validation | OMP, from `modelRoles` |

Jev never adds, removes, or reorders workers.

## Precedence

Highest wins:

1. A spawn lock (`modelLocked` or `effortLocked`) keeps the baseline configuration.
2. A `Directive:` line in the brief pins the named role alias, literal model, or task type.
3. The agent's pinned task type from `agents.taskTypes` (a directive model skips it; a directive task type overrides it).
4. A pool ranks its members by difficulty scope and quota for the task type.
5. A fixed task-type model, then the agent's bound `modelRoles` selector.

## Dispatch

1. If the user names a model, role, or reasoning level, pass the matching agent with `routing: "off"`.
2. If no model or role is named, pass only the requested `agent` and an optional persona header.
3. Never pass a model or effort that the user did not request.
4. Fill each stage with concrete assignments, owned paths, shared contracts, acceptance criteria, and a `solutionSpace` describing the assigned slice rather than the surrounding problem.
5. Delegate useful substantive evidence/execution before doing the bulk in the parent; dispatch independent assignments together. Keep conversation, trivial actions, decisions and integration inline. A bounded worker executes its assignment directly, without recursive delegation ceremony.
6. To steer Jev without disabling routing, add a `Directive: use <alias|model> [effort]` line to the brief.
7. When automatic type/difficulty is uncertain or classification is unavailable, use the block reason to sharpen the assignment once from existing context. Ask the operator only for a material decision; do not resend unchanged or do the blocked bulk task inline.

## Recipes

Choose one recipe only when its trigger holds.

- **single-worker** uses one worker for a bounded task with a settled specification, in the Brute persona when the work is done as told.
- **orchestrated-lanes** uses one `orchestrator` per slice only when a ready plan already defines independent lanes and that slice runs two or more of them in parallel; its lane workers run Brute unless a lane needs judgment. Never an orchestrator over one worker.
- **plan-then-implement** uses `plan` to write the plan (its `plan:` front matter names the authored-by models), then a stock `reviewer` on the `plan-review` task type — never on the plan's author model — then the implementation workers selected by the parent.
- **dual-design** uses `design-master` (`@lead`) and `design-second` (`@frontier-2`) in parallel when the user requests design alternatives or a second opinion.
- **plan-review** uses one stock `reviewer` per non-author frontier model (`@frontier-1`, `@frontier-2`, `@frontier-3`) when the user requests full frontier plan review.
- **frontier-review** uses `review-frontier-1`, `review-frontier-2`, and `review-frontier-3` for an independent end-of-batch diff or plan review; the brief's directive names the model.

## What Jev routes

Jev sees the job, assignment, and shared context.
Jev does not see concrete model identifiers.

Covered agents resolve a task type, then that type's pool or fixed model:

- `task` uses `code` for settled specifications, `lead` when judgment, hard debugging, or root-cause work is needed, `vision` for image, screenshot, or video analysis, and `mechanical` or `commit` when the brief is exact non-code work or git operations.
- `reviewer` uses `review` for settled-spec verification of an implemented diff, and `plan-review` (or `frontier-review`) when the assignment reviews a plan.
- `sonic` uses `mechanical` for non-code writes with exact content (docs text, config values, data files) and directed tool runs; any source-code edit, however trivial, goes to `task`.
- `scout` uses economical `mechanical` exact/ordinary workers for bounded read-only evidence collection. Rate that slice, not the surrounding problem; architecture/root-cause judgment or hard/critical work must be reframed or assigned separately.
- `git` is pinned to `commit` for commits, branches, merges, and pull requests.
- `plan` uses the quota-aware `lead` pool at medium to xhigh and may be rated for difficulty.
- `security-reviewer` uses `security-review`, sharing the quota-aware `lead` pool at high to xhigh.

Pinned agents keep their bound `modelRoles`; Jev sets only effort from the model's difficulty-to-effort map:

- `orchestrator` pins `@orchestrator`.
- `design-master` pins `@lead`; `design-second` pins `@frontier-2`.
- `review-closer` and `review-verifier` pin `@lead`.
- Frontier reviewers `review-frontier-1`, `review-frontier-2`, and `review-frontier-3` pin `@frontier-1`, `@frontier-2`, and `@frontier-3`.

Jev rates difficulty as Exact, Ordinary, Hard, or Critical according to the catalog ladder.
A pool member scoped with `difficulties` serves only those levels.
The `mechanical`, `commit`, `code`, and `review` pools list one member per provider per difficulty, tried Anthropic, then xAI, then OpenAI, because Haiku, Sonnet, and Opus share one Anthropic quota, so rolling over inside a provider buys nothing.
The `mechanical` and `commit` pools fall back to `deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017` low when every member is quota-skipped. The `code` and `review` pools use that same fallback at high.
The `lead`, `plan`, and `security-review` task types share the `lead` pool: `@frontier-1` → `@frontier-2` → `@frontier-3` → `google-antigravity/gemini-4-argon`. Anthropic uses the same quota gates as other worker pools; the other members use weekly headroom 0. Opus keeps its model-map effort, clamped to high–xhigh for lead/security review and medium–xhigh for planning. Both frontier rollover members set `effortFrom: "@frontier-1"`; frontier-2 matches that effort, while frontier-3 sets `effortStep: 1` for one level higher, capped at xhigh. Argon uses its own map (low, medium, high, high) under the same clamp. Members do not pin effort. Remaining eligible members stay in the provider-failure retry chain. The all-skipped fallback is `deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017:high`.

| Pool | Difficulty | Anthropic | xAI (Grok) | OpenAI |
|---|---|---|---|---|
| `mechanical` | exact | Haiku xhigh | Grok low | Luna xhigh |
| `mechanical` | ordinary | Haiku xhigh | Grok low | Luna xhigh |
| `mechanical` | hard | Sonnet low | Grok high | Luna max |
| `mechanical` | critical | Opus medium | Grok high | Luna max |
| `commit` | exact | Haiku xhigh | Grok low | Luna xhigh |
| `commit` | ordinary | Haiku xhigh | Grok low | Luna xhigh |
| `commit` | hard | Opus low | Grok high | Luna max |
| `commit` | critical | Opus medium | Grok xhigh | Luna max |
| `code` | exact | Haiku xhigh | Grok low | Luna max |
| `code` | ordinary | Sonnet low | Grok high | Luna max |
| `code` | hard | Opus medium | Grok high | Sol low |
| `code` | critical | Opus high | Grok xhigh | Sol medium |
| `review` | exact | Sonnet low | Grok low | Sol low |
| `review` | ordinary | Sonnet low | Grok high | Sol medium |
| `review` | hard | Opus medium | Grok high | Sol high |
| `review` | critical | Opus high | Grok xhigh | Sol xhigh |

Gemini 4 Argon (`google-antigravity/gemini-4-argon`) is the last member, as frontier rollover: in `code` after Luna for ordinary (low) and after Sol for hard (medium) and critical (high); in `review` after Sol at every difficulty (low, medium, high, high); and in the `lead` pool (lead, plan, security-review) after Grok, where plan runs it at medium for exact and ordinary and high above, and lead and security review at high.

Sonnet is named literally with no role and never runs above low.
Anthropic members are eligible while weekly headroom is at least 0.10 (`minWeeklyHeadroom` 0.1); Anthropic no longer reports a 5-hour window, so no member has a 5-hour gate.
xAI (`@frontier-3`, Grok) and OpenAI (`openai-codex/gpt-5.6-luna` in mechanical and commit, `openai-codex/gpt-6.1-sol` in code and review) share one gate: `minWeeklyHeadroom` 0, so they are eligible while weekly usage is not ahead of the weekly pace.
Neither has a monthly gate; both report only a 7-day window.
Every provider's in-flight burst penalty counts against its weekly window.
Argon's gate is also `minWeeklyHeadroom` 0, read only from its own `gemini-argon-*` weekly bucket in Antigravity's report; the shared Gemini windows that Gemini 3.8 Flash spends do not gate Argon, and Argon's bucket does not gate other Gemini models. Gemini's 5-hour window is not gated.
A gated member with no usage report, or a report that lacks a valid gated window, gets `no-usage` and is ranked last after crowded members; stale and partial reports still exclude.
A window at or above `demoteAt` 0.8 crowds a member; at or above `skipAt` 0.95, or exhausted, it is skipped.
Within 12 hours of a weekly reset, weekly crowding is lifted; within 5 hours, the weekly pace check and weekly `skipAt` are lifted (weekly exhaustion still stops new work), and Anthropic's short-window cap rises from 0.7 to `demoteAt` 0.8.
Ungated members (the `plan-review` pool) have no usage-window gates; only failure demotion applies.
Protected aliases (`@frontier-2`, `@slow2`, `@advisor`, `@manager`) are restricted to the `plan-review` and `lead` pools by `reviewOnly`; they remain rejected in ordinary worker pools. Literal Sol serves code and review; the lead pool uses role references, so role rebinding changes its models.
`openai-codex/gpt-5.6-luna` is blocked as a `Directive:` target but serves the `mechanical` and `commit` pools; the `web` role also names it literally.
A planning request first passes the catalog readiness check.
An autonomous planner is allowed only when requirements, target files, acceptance criteria, and technical constraints are concrete.
Otherwise the parent should discuss the open choices with the user first.
Image questions use the configured vision role directly instead of Jev classification.

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

The `plan-review` pool sets `excludePlanAuthors`. Jev drops every model named as an author and prefers a member that has not already reviewed the plan, so a plan is never reviewed by its author model.
A missing or unparsable document leaves the pool order unchanged.

## Media tasks

Delegate image and video analysis to `task`; other agents keep their normal routing.
Jev reads the brief and picks the `vision` task type (Gemini first, Claude Opus as backup) when the work is mainly looking at visual media.
A code change that merely mentions an image or video stays on its normal task type.
There is no keyword or file-extension detector; to force media routing, add `Directive: use vision` to the brief.

## TypeSafe authentication and fallback

Jev evaluates routing requests through TypeSafe.
Authenticate with `/login typesafe` or set `TYPESAFE_API_KEY`.
Without a TypeSafe key, ordinary automatic jobs return a routing-unavailable block/reason to the parent instead of silently keeping the configured model.
Jev failure or uncertain required type/difficulty also blocks ordinary automatic jobs. Task-type directives still require confident necessary difficulty. Deliberate named-model/pinned review requests retain their explicit choices; routing disabled, explicit model/effort locks and unresolvable pools preserve their existing baseline behavior.
Quota is not a global dispatch cap: `plan-review` members are ungated, missing usage can still select Anthropic, and a failed usage fetch preserves pool order. Fixed `vision` keeps its provider-failure `@lead` backup without quota checks; named models and pinned agents intentionally bypass pool gates. All-skipped worker fallbacks do not recheck quota. The shipped catalog no longer exempts Codex from normal quota ranking. Catalog.json is re-read on each spawn when its mtime changes.

## Visibility

Each hook outcome is recorded as an `intelligent-auto-agents-decision` session entry.
The entry identifies `jev`, `catalog`, or `baseline` as its source and stores routing metadata rather than assignment text.
`/auto-agents status` shows whether routing is enabled, the catalog version, the Jev model, and the latest routing line.
`/auto-agents off` disables routing for the session.
`/auto-agents on` enables routing for the session.
Routing is enabled by default.

## Role configuration

Jev reads its pools, task types, directive targets, and difficulty maps from `catalog.json` next to the extension entrypoint.
Edit it only when changing pool membership or order, task-type ownership, the difficulty-to-effort maps, readiness wording, limits, or the Jev model selector.
Keep the catalog version and schema valid.
Point each pool's fallback at a resolvable role alias or literal model.
Keep each task type bound to exactly one pool or model.
