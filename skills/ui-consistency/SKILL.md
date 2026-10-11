---
name: ui-consistency
description: Use when adding or changing UI in a repo that already has a kit or tokens. Not for greenfield visual design, CSS layout bugs, or animation.
---

# UI consistency

This is the entry point for any edit that adds or changes UI in a repo that already has a kit or tokens.
`css-craft`, `motion`, and `ui-stress` defer here for which component, token, and variant to use.
A missing design doc does not make the repo greenfield.

## The project wins

- The project's existing kit, tokens and conventions win over any value or technique in this skill.
- Example values are placeholders bound to the project's scale.
- A default from this skill applies only when the project has none.

## 1. Locate the system

Search in this order. Read the token file and one sibling screen before editing.

| Look for | What it tells you |
| --- | --- |
| `components.json` | `aliases.ui` is the kit. `tailwind.css` is the token file. `cssVariables: true` means semantic tokens are the vocabulary. |
| `packages/ui`, `components/ui`, `src/components/ui` | The kit, when there is no `components.json`. |
| `.storybook/` | The components and variants that already exist. |
| `@theme` blocks | Tailwind v4 tokens, including `@theme inline`. |
| `:root` custom properties | Semantic tokens, including repos that are not on Tailwind. |
| `tailwind.config` `theme.extend` | Tokens in a Tailwind v3 config. |
| CSS-in-JS theme objects, `tokens.json` | Tokens when there is no stylesheet entry. |
| Kit `cva` / `variant` / `size` APIs | The variants you may use. Read them before inventing a class. |

## 2. Write the identity lock

Before any edit, write one sentence that names the real values from those files:

`Surface {token}, accent {token}, type roles {roles}, radius {token}, elevation {border or shadow token}, kit already on sibling screens {names}.`

That sentence is the check for every later choice.
Fill every slot from the repo.
If a slot is missing, say so. Do not invent a value for it.

## 3. Edit with the kit

- Use an existing component before raw markup.
- Use a built-in `variant` or `size` before a `className` override.
- Use `className` for layout only. Do not override a component's color, type, radius, or shadow from the callsite.
- Restyle by editing the component's variants. Keep existing variant names.
- Do not add a color, font, radius, shadow, size, or primitive the surface does not already own.
- If the system cannot express the change, stop and ask. Name the exact addition and the job it does.
- Extend the project's tokens. A parallel easing, duration, spacing, or type scale is a defect.
- Use the project's hover, tint, and alpha mechanism: an opacity modifier such as `hover:bg-primary/90`, a hover token, or a kit variant. If the project has none, derive the missing shade with `color-mix()` in the token file, after the user agrees. Do not add a second literal in a component.
- Outer radius is the inner radius token plus the padding. Do not pick a second radius.
- Fluid math lives in the token. A component uses the token and does not repeat the math.
- Two save actions that look different means one of them is wrong. Match the comparable screen.

## 4. Check the diff

Run this skill's `scripts/check-drift.mjs` with the project as the working directory.
It reads added lines against the merge-base with the default branch, including staged, unstaged, and untracked files. `--staged` is staged changes only.
Output is `path:line  tier  rule  message  -> suggestion`.
Exit 1 means at least one finding. Exit 0 means clean. Exit 2 means the command was wrong.
Fix each finding, or name it in the reply as intentional.
Do not silence a finding by widening the token set.

| Flag | Meaning |
| --- | --- |
| `--base <ref>` | Diff against this ref instead of the merge-base. |
| `--staged` | Staged changes only. |
| `--all` | Scan whole files. Pass paths, or omit them to scan tracked and untracked source, respecting gitignore. |
| `--json` | JSON array on stdout. |
| `--kit <dir>` | Kit directory, if detection picks the wrong one. |

`var()` and `theme()` are allowed inside an arbitrary value.
The kit directory is exempt from raw-element and arbitrary-value checks.
The script skips comments, tests, stories, generated files, and the token files themselves.

| Rule | Tier | Meaning |
| --- | --- | --- |
| `invented-token` | broken with no fallback, else fragile | `var(--x)` and `--x` is not defined. The declaration drops. |
| `raw-palette` | ugly | A numbered palette utility while semantic color tokens exist. |
| `arbitrary-value` | ugly | An off-scale length, color, radius, shadow, or font in brackets. |
| `literal-value` | ugly if it matches a token, else fragile | A CSS literal the token set already has, or a color or radius outside it. |
| `raw-element` | ugly | A native control outside the kit, when the kit exports that control. |
| `primitive-import` | ugly | A wrapped `@radix-ui/*` or `@base-ui/*` import outside the kit. |
| `one-off` | fragile | A scale step used twice or less beside a dominant step. |

Tiers: broken means the style is missing, ugly means it renders but does not match, fragile means the next edit will copy it.

## Classify before fixing

| Class | Fix |
| --- | --- |
| Missing token | Add it to the system, after the user agrees. |
| One-off implementation | Replace it with the shared component. |
| Conceptual mismatch | Align it with the comparable screen. |
| Local defect | Fix it in place. |

Fix at the narrowest correct level.
A value used once is not a token.
Do not widen the token set or the type ramp to make a finding go away.
Extract a component only at 3 or more uses with the same intent.
Similar-looking pieces with different jobs stay separate.

## Hand-rolled widgets

These mean find the kit equivalent first, not install a library:

- a toast built by hand
- a `<div>` dropdown or dialog with manual focus handling
- `className` ternaries three conditions deep

## Third-party components

Climb one rung at a time: defaults, then props, then part class names, then one kit wrapper.
If you reach for `!important`, wrap the component instead.

## Exceptions

Waive one value, then one rule in one file, then one file, then the rule project-wide.
Write an exception down only after the user confirms it.

## Rationalizations

| Excuse | Answer |
| --- | --- |
| One class will not matter. | One off-token class is the drift. Use the token. |
| The kit component is close enough. | Use its variant. If none fits, stop and ask. |
| I will add a token so the check passes. | A value used once is not a token. |
| This screen is special. | Two save actions that differ means one is wrong. |
| There is no design doc, so I can choose. | The kit and the tokens are the system. |
| The arbitrary value is just this once. | Use the scale, or name the exception. |
| I will extract a component while I am here. | Wait for 3 uses with the same intent. |

## Red flags

- A new hex, `oklch()`, or px radius in a component file.
- `className` setting color, type, radius, or shadow on a kit component.
- A new `<button>`, `<input>`, `<select>`, or `<dialog>` outside the kit.
- An import from `@radix-ui/` or `@base-ui/` outside the kit.
- A second spacing, type, easing, or duration scale.

## Load next

- `references/enforcement.md` when the user asks how to stop this in CI, or when the same finding has come back in a second edit. Propose the lint. Do not install it unasked.
- `css-craft` for layout, overflow, scroll, forms, focus, and mobile viewport, after the kit and tokens are chosen.
- `motion` for animation. Durations and easings come from the project's tokens.
- `ui-stress` before shipping a list, card, or form.
