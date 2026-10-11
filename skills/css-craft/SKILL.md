---
name: css-craft
description: Use when fixing or building layout, overflow, sticky, scroll, form, focus or mobile-viewport CSS; not for routine class edits, visual design or animation.
---

# CSS craft

CSS techniques with the conditions they need to work.
Each reference entry names the failure, the fix, and the rules that keep the fix working.
Keep every rule of an entry you apply; they are the reason the snippet works.

## The project wins

- The project's existing kit, tokens and conventions win over any value or technique in this skill.
- Snippet values are placeholders bound to the project's scale. `var(--gap)` means "the project's token for this job", not a new property to add.
- A default from this skill applies only when the project has none.
- If the project's scale has no value for the job, ask before adding one.
- Change existing code only when it causes a real bug. A technique here is never a reason to rewrite working code.
- Write declarations in the project's authoring system: its stylesheets, utilities or CSS-in-JS. Where its utilities lack a declaration, use the escape hatch the project already uses.

## For new code, or when the repo has no convention for this

- Use logical properties (`padding-inline`, `inset-block-start`). Where the surrounding code is physical, match it, and never mix `ml-` and `ms-` in one component. RTL support makes logical properties required.
- Write a new palette in `oklch()`. Keep an existing palette in its own color space.
- Cut off overflow with `overflow: clip` when nothing scrolls. Change an existing `hidden` only when it breaks sticky or adds a stray scrollbar.
- Gate hand-written `:hover` rules with `@media (hover: hover) and (pointer: fine)`. Tailwind v4 `hover:` already gates on `(hover: hover)`; leave it as is.
- Keep the kit's focus style. Remove an outline only for a replacement that survives forced-colors mode.

## Load the reference that matches the symptom

| Symptom or task | Load |
| --- | --- |
| Text overflows, ellipsis missing, flex child won't shrink, sticky won't stick, cards misaligned, image distorts or jumps, container query never matches | `references/layout-overflow.md` |
| Modal or drawer body won't scroll, footer pushed off screen, `100vh` too tall on a phone, carousel, page scrolls behind a modal, anchor hidden under a sticky header, content under the notch, rubber-band bounce | `references/scroll-viewport.md` |
| Focus ring missing or invisible, hover stuck after a tap, tap target too small, whole card clickable, errors shown on page load, iOS zooms into an input, textarea should grow | `references/forms-focus.md` |
| Hover or tint color, gray mix turns purple, dark-mode tokens, fluid font size, digits jitter in a column, bold renders as regular, icon off-center beside a wrapping label | `references/color-type.md` |
| Web app feels like a website on a phone: tap flash, laggy tap, long-press selects a label, wrong status-bar color, wrong keyboard, touch vs mouse detection | `references/mobile.md` |
| Building a dialog, popover, dropdown menu or accordion | `references/native-widgets.md`, only after confirming the kit has no such component |

One component often matches two or three rows; load each.

## Browser support

Entries end with a `Support:` line.
Weigh it against the browsers the project targets, and tell the user when a technique you used is missing in one of them.

## Related skills

- `ui-consistency`: which component, token and variant to use. Run it first on any UI edit.
- `motion`: whether and how to animate, easing and duration values.
- `ui-stress`: breaking a UI with real worst-case data.
