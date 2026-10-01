---
name: intelligent-auto-agents
description: Use when delegating OMP work with intelligent auto-agents enabled, including explicit user agent or model choices, recipes, or questions about automatic model selection.
---

# Intelligent auto-agents

## Terms

- **Model** means the provider and model that runs a worker.
- **Reasoning level** means the effort setting supported by a model, such as `low`, `medium`, `high`, `xhigh`, or `max`.
- **OMP model role** means a name in `modelRoles` from `config.yml`.
- **Role alias** means a selector such as `@grunt` or `@task` that resolves through `modelRoles`.
- **Job** means the worker purpose selected with the `agent` field.
- **Persona** means the working behavior selected by the task text, such as Normal, Brute, or Orchestrate.
- **Recipe** means a workflow template with stages and dependencies.

## Who decides what

| Decision | Owner |
|---|---|
| Inline work, one worker, multiple workers, or an orchestrator | Parent |
| Job selected in `agent` | Parent |
| Persona selected by `# Mode: brute` or `# Mode: orchestrate` | Parent |
| Recipe | Parent |
| Model role and effort | Jev, from `catalog.json` |
| Concrete model and effort validation | OMP, from `modelRoles` |

Jev never adds, removes, or reorders workers.

## Dispatch

1. If the user names a model, role, or reasoning level, pass the matching agent with `routing: "off"`.
2. If no model or role is named, pass only the requested `agent` and an optional persona header.
3. Never pass a model or effort that the user did not request.
4. Fill each stage with concrete assignments, owned paths, shared contracts, and acceptance criteria.
5. Dispatch independent assignments together and let later stages consume earlier results.
6. If a requested role has no configured binding, explain the missing binding instead of substituting another model.

## Recipes

Choose one recipe only when its trigger holds.

- **single-worker** uses one worker for a bounded task with a settled specification.
- **plan-then-implement** uses `plan`, then `plan-review-peer`, then the implementation workers selected by the parent.
- **dual-design** uses `design-master` and `design-second` in parallel when the user requests design alternatives or a second opinion.
- **plan-review** uses `plan-review-frontier-1`, `plan-review-frontier-2`, and `plan-review-frontier-3` when the user requests full frontier plan review.

## What Jev routes

Jev sees the job, assignment, and shared context.
Jev does not see concrete model identifiers.

- `task` uses `grunt` for settled specifications, `lead` when judgment is needed, or `peer` for hard debugging and root-cause work.
- `sonic` and `scout` use the fixed `mechanical` slot at low effort.
- `reviewer` uses the fixed `review` slot at maximum effort.
- `git` uses the fixed `git` slot at low effort.
- `plan` uses the `plan` slot and may be rated for difficulty.
- `plan-review-peer` uses `plan-peer` for ordinary plans and `plan-peer-critical` for critical plans.
- `orchestrator` uses the fixed `orchestrator` seat at high effort.
- Frontier review agents use the `frontier-review` seat.
- Design agents use the `design-primary` or `design-secondary` seats.
- Agents without a catalog slot keep their configured model role.

Jev rates difficulty as Exact, Ordinary, Hard, or Critical according to the catalog ladder.
A planning request first passes the catalog readiness check.
An autonomous planner is allowed only when requirements, target files, acceptance criteria, and technical constraints are concrete.
Otherwise the parent should discuss the open choices with the user first.
Image questions use the configured vision role directly instead of Jev classification.

## TypeSafe authentication and fallback

Jev evaluates routing requests through TypeSafe.
Authenticate with `/login typesafe` or set `TYPESAFE_API_KEY`.
Without a TypeSafe key, Jev records a baseline decision and keeps the configured model and effort.
Jev failures, low confidence, routing disabled, locked requests, and missing slots also keep the baseline configuration.

## Visibility

Each hook outcome is recorded as an `intelligent-auto-agents-decision` session entry.
The entry identifies `jev`, `catalog`, or `baseline` as its source and stores routing metadata rather than assignment text.
`/auto-agents status` shows whether routing is enabled and the latest routing line.
`/auto-agents off` disables routing for the session.
`/auto-agents on` enables routing for the session.
Routing is enabled by default.

## Role configuration

Jev reads its profiles from `catalog.json` next to the extension entrypoint.
Edit the catalog only when changing slot ownership, backup order, difficulty mapping, readiness wording, or limits.
Keep every profile id unique.
Keep each effort ladder at four entries ordered from Exact through Critical.
Keep each agent name in exactly one catalog profile.
