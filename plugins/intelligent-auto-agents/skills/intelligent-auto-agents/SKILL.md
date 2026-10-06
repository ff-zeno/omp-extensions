---
name: intelligent-auto-agents
description: Use when delegating OMP work with intelligent auto-agents enabled, including explicit user agent or model choices, recipes, or questions about automatic model selection.
---

# Intelligent auto-agents

Jev is the router described by `catalog.json` (catalog v8). Before each covered or pinned subagent spawn it selects a task type, rates difficulty, and resolves a concrete model and effort.

## Terms

- **Model** means the provider and model that runs a worker.
- **Effort** means the reasoning level a model supports, such as `low`, `medium`, `high`, `xhigh`, or `max`.
- **OMP model role** means a name in `modelRoles` from `config.yml`.
- **Role alias** means a selector such as `@grunt` or `@frontier-2` that resolves through `modelRoles`.
- **Job** means the worker purpose selected with the `agent` field.
- **Covered agent** means an agent routed through a task type: `task`, `sonic`, `scout`, `reviewer`, `security-reviewer`, `git`, and `plan`.
- **Pinned agent** means an agent that keeps its bound model while Jev sets only effort: `orchestrator`, `design-master`, `design-second`, `review-closer`, `review-verifier`, `review-frontier-1`, `review-frontier-2`, `review-frontier-3`, and the chat-cycle roles `medium` and `slow1`–`slow3`.
- **Task type** means a named kind of work — `mechanical`, `grunt`, `lead`, `vision`, `security-review`, `plan`, `plan-review`, `frontier-review` — with a fixed model or a pool, plus an effort range.
- **Pool** means an ordered member list (`mechanical`, `grunt`, `plan-review`) that Jev ranks by quota before each spawn.
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
| Task type, difficulty, pool order, model role, and effort | Jev, from `catalog.json` |
| Concrete model and effort validation | OMP, from `modelRoles` |

Jev never adds, removes, or reorders workers.

## Precedence

Highest wins:

1. A spawn lock (`modelLocked` or `effortLocked`) keeps the baseline configuration.
2. A `Directive:` line in the brief pins the named role alias, literal model, or task type.
3. A pool ranks its members by difficulty scope and quota for the task type.
4. A fixed task-type model, then the agent's bound `modelRoles` selector.

## Dispatch

1. If the user names a model, role, or reasoning level, pass the matching agent with `routing: "off"`.
2. If no model or role is named, pass only the requested `agent` and an optional persona header.
3. Never pass a model or effort that the user did not request.
4. Fill each stage with concrete assignments, owned paths, shared contracts, and acceptance criteria.
5. Dispatch independent assignments together and let later stages consume earlier results.
6. To steer Jev without disabling routing, add a `Directive: use <alias|model> [effort]` line to the brief.
7. If no routed option resolves, Jev keeps the configured model and effort; the extension never fails a spawn because a role is missing.

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

- `task` uses `grunt` for settled specifications, `lead` when judgment, hard debugging, or root-cause work is needed, and `vision` for image, screenshot, or video analysis.
- `reviewer` uses `grunt` for settled-spec verification of an implemented diff, and `plan-review` (or `frontier-review`) when the assignment reviews a plan.
- `sonic` uses `mechanical` for non-code writes with exact content (docs text, config values, data files) and directed tool runs; any source-code edit, however trivial, goes to `task`.
- `scout` uses `grunt` for read-only investigation.
- `git` uses `grunt` for commits, branches, merges, and pull requests.
- `plan` uses the fixed `plan` model and may be rated for difficulty.
- `security-reviewer` uses `security-review`.

Pinned agents keep their bound `modelRoles`; Jev sets only effort from the model's difficulty-to-effort map:

- `orchestrator` pins `@orchestrator`.
- `design-master` pins `@lead`; `design-second` pins `@frontier-2`.
- `review-closer` and `review-verifier` pin `@lead`.
- Frontier reviewers `review-frontier-1`, `review-frontier-2`, and `review-frontier-3` pin `@frontier-1`, `@frontier-2`, and `@frontier-3`.

Jev rates difficulty as Exact, Ordinary, Hard, or Critical according to the catalog ladder.
A pool member scoped with `difficulties` serves only those levels.
In the grunt pool, `@frontier-3` (Grok) leads while its quota is on pace; when it is skipped, exact work falls to `anthropic/claude-sonnet-5-5` and anything above exact falls to `@lead` (Opus) at low.
Sonnet is named literally with no role and never runs above low.
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
Without a TypeSafe key, Jev records a baseline decision and keeps the configured model and effort.
Jev failures, low confidence, routing disabled, locked requests, and unresolvable pools also keep the baseline configuration.

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
