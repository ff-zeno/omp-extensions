# Motion rule catalog

Each rule appears once, under one ID.
The gate (G1 to G3) and the precedence rule live in SKILL.md.
"Look for" lines are grep starting points for review and audit.
Names like `--motion-ease-out` below are the fallback names from the last section; use the repo's own names when it has them.

## T. Tool

**T1. Cheapest tool that works.** Walk down and stop at the first fit.

| Need | Tool |
| --- | --- |
| Hover, press, color, a state toggled by a class or attribute | CSS transition |
| Entry on mount with no JS state | CSS `@starting-style` |
| Fixed motion that must stay smooth while the page is busy, or a loop | CSS keyframes |
| Script control without a library | Web Animations API, `element.animate()` |
| Springs, layout animation, exit on unmount, gesture-driven values | The repo's motion library; add one only when nothing above can do it |

Do not install a motion library for a fade.
Compositor-eligible properties (`transform`, `opacity`, some `filter` values) animated by CSS or WAAPI keep running while the main thread is busy; other properties do not, whatever the tool.
`requestAnimationFrame` loops drop frames while the page loads, scripts or paints.
Use CSS or WAAPI for fixed motion and JS for dynamic or interruptible motion.
Look for: rAF loops doing what a transition could; a motion library imported for one opacity change.

**T2. A component is not an animation.**
If the task is a toast, drawer, menu, dropdown or dialog, use the kit's component.
A hand-rolled one loses focus management and keyboard handling.

## P. Properties, origin and path

**P1. Animate `transform` and `opacity`.**
They skip layout and paint.
`clip-path` and `filter` are allowed too.
`width`, `height`, `margin`, `padding`, `top`, `left` and `gap` relayout every frame.
One exception, for a short collapse only: animate height with a measured or kit-supplied value.
To animate to `auto`, use `interpolate-size: allow-keywords` or a transition on `::details-content` as progressive enhancement; browsers without them snap open, which is acceptable.
Never animate to `auto` with script hacks such as a large `max-height`.
Look for: those properties inside `transition`, `@keyframes` or animation props.

**P2. Name the properties.**
Never `transition: all`; it animates whatever changes next, often off the compositor.
Look for: `transition: all`, `transition-all`, `transition` with no property list.

**P3. Nothing appears from nothing.**
Never start from `scale(0)`.
Start from `scale(0.95)` (range 0.9 to 0.97) with `opacity: 0`.
Look for: `scale(0)`, `scale: 0`, `scale-0`.

**P4. Scale from the trigger.**
Popovers, menus, dropdowns, selects and tooltips set `transform-origin` at their trigger, using the kit's variable where it has one.
Modals are exempt; they are not anchored to a trigger and stay centered.
Look for: anchored overlays with `transform-origin: center` or no origin at all.

**P5. Same path in and out.**
An element leaves along the path it came in on.
In from the bottom and out to the side reads as two unrelated objects.

**P6. Move by percentages.**
`translateY(100%)` moves an element by its own height whatever its content.
Prefer it to hardcoded pixel offsets.

**P7. Press feedback scales the whole control.**
`scale(0.97)` (range 0.95 to 0.98) on `:active` scales the label and icon with it, which is what reads as a physical press.

## E. Easing and duration

**E1. Easing by situation.**

| Situation | Easing |
| --- | --- |
| Entering or exiting | `--motion-ease-out` |
| Moving or morphing on screen | `--motion-ease-in-out` |
| Hover color or background change | `ease` |
| Constant motion: progress, marquee, hold-to-confirm fill | `linear` |
| Anything else | `--motion-ease-out` |

**E2. No `ease-in` on UI.**
It starts slow and delays the first frames, which are the ones the user is watching.
An `ease-out` at 200ms feels faster than an `ease-in` at 200ms.
This applies to hand-typed `ease-in` or an ease-in curve with no repo token behind it.
If the repo's own token uses ease-in (often for exits), use it and leave a note, not a block.
Look for: `ease-in` (not `ease-in-out`), `Easing.in(`, `easeIn`.

**E3. Strong curves, never invented ones.**
The CSS keywords `ease-out` and `ease-in-out` are too soft for deliberate entrances.
Use the repo's curve tokens, else copy a fallback value from the last section exactly.
Never invent a new `cubic-bezier`.
Look for: `cubic-bezier(` outside the token file; five near-identical curves is a consolidation finding.

**E4. UI motion stays at 300ms or less.**
A 180ms dropdown feels faster than a 400ms one.
One exception: a drawer or sheet crossing a viewport edge may take up to 500ms, or use a spring.
Marketing and explanatory motion may run longer.
Look for: durations over 300ms on UI elements without a stated reason.

**E5. Exit one step down the duration scale.**
An element that entered in `--motion-duration-slow` leaves in `--motion-duration-base`; the user has finished with it.
With the repo's tokens, step down the repo's scale.

**E6. Slow where the user decides, fast where the system answers.**
A hold-to-confirm fills over 2s `linear` while pressed and snaps back in `--motion-duration-base` on release.
Symmetric timing on a hold or other deliberate confirm interaction is a finding.

**E7. Spend time only where it buys something.**
After the first tooltip in a group opens, its neighbors open with no delay and no animation.
A spinner that turns faster makes the same wait feel shorter.

**E8. Stagger groups by 30 to 80ms.**
Only for groups seen occasionally.
Stagger is decoration and never blocks interaction while it plays.
Look for: lists or grids where every item enters at once on an occasional surface.

**E9. Match the product's personality.**
A crisp tool stays crisp; a playful app may bounce.
One bouncy component in a crisp app is a finding.

## I. Interruption and springs

**I1. Transitions retarget, keyframes restart.**
No keyframes on anything that can fire twice in a second: toasts, toggles, expanding rows.
Keyframes are for one-shot entrances and loops.
Look for: `@keyframes` or `animation:` on toasts, toggles and other repeat-trigger elements.

**I2. Gestures use springs.**
Anything a finger or pointer drives settles with a spring that starts from the on-screen value and inherits the release velocity.
Details are in native-gestures.md.

**I3. Never lock input during a transition.**
A user who grabs or reverses a moving element gets it now, not after it finishes.

**I4. Springs are critically damped by default.**
No bounce: `bounce: 0`, or damping ratio 1.
Add bounce of 0.1 to 0.3 only when a gesture carried momentum into the motion (a flick, a throw, a drag release) or on a rare playful moment.
Overshoot on a menu that faded in feels wrong; overshoot on a card you flicked feels right.

**I5. Decorative pointer-following goes through a spring.**
Mapping a value straight to the pointer feels mechanical.
This applies to decoration only; G3 still bars it from functional UI.

## F. Performance

**F1. Per-frame values go on the moving element.**
Never drive per-frame motion (drag, scroll, pointer tracking) through a custom property set on a parent.
Every descendant's style recalculates each frame.
Write `transform` on the element that moves.
Look for: `style.setProperty('--` inside pointer, drag or scroll handlers.

**F2. No framework re-render per frame.**
In React, write per-frame values to `ref.current.style` or the motion library's motion values, never to state.
Look for: `setState` or a state setter inside `pointermove`, `scroll` or drag handlers.

**F3. Motion library shorthands run on the main thread.**
In Motion (motion.dev), `x`, `y` and `scale` props animate through `requestAnimationFrame`.
For motion that plays while the page is busy, animate the full `transform` string instead.

**F4. Animated blur stays under 20px.**
Large blur radii are expensive, Safari most of all.

**F5. `will-change` only for an observed problem.**
Add it when you see a 1px shift or a stutter at animation start, scope it to the moving element, and remove it when the motion ends.

## A. Accessibility

**A1. Reduced motion means fewer and gentler, not zero.**
Put movement inside `@media (prefers-reduced-motion: no-preference)`: translation, scale, parallax, overshoot, autoplaying loops.
Opacity and color fades that explain a state change stay outside it.
Under reduced motion a slide becomes a short crossfade.
Never strip motion afterwards with a global rule that sets every duration to near zero; that also kills the feedback.
Script-driven motion checks the same query with `matchMedia` or the library's reduced-motion hook.
Look for: movement with no reduced-motion handling; reduced-motion rules that remove all feedback.

**A2. Gate hover motion to real hover.**
Wrap hover-triggered movement in `@media (hover: hover) and (pointer: fine)`; touch fires a hover on tap.
Tailwind v4's `hover:` variant already applies `(hover: hover)`.
Look for: `:hover` with `transform` and no media gate.

**A3. Feedback on press, not on release.**
Show the pressed state on pointer-down; commit the action on pointer-up.

**A4. Avoid vestibular triggers.**
No full-viewport moving backgrounds, no slow oscillating loops near one cycle every 5 seconds, no abrupt brightness jumps between themes.

## R. Robustness

**R1. Content is visible without script.**
The default style is the visible end state.
Hide content for a reveal only under a class or attribute the script sets once it runs, or use CSS-only entry such as `@starting-style`.
Look for: `opacity: 0` or a hiding `clip-path` as a base style that only JavaScript removes.

**R2. Non-essential loops stop when nobody sees them.**
Pause loops that are offscreen (`IntersectionObserver`) or in a hidden tab (`visibilitychange`).
Anything that moves for more than 5 seconds gets a pause control.
Look for: `animation-iteration-count: infinite`, `repeat: Infinity`, autoplaying carousels.

**R3. Respect autoplay and sound preferences.**
Never autoplay sound.
Autoplaying video is muted, has a pause control, and under reduced motion shows its poster instead.
Sound and haptics fire only on meaningful events and are never the only feedback.

**R4. Transient UI timers pause.**
A toast's dismiss timer pauses while the tab is hidden and while the toast is hovered or focused.

## Fallback values

Use these only when step 0 found no motion tokens.
Until the user agrees to add them as tokens, inline the values in the one change at hand and say in the output that they are inline fallbacks.
Once agreed, add the block where the repo keeps its other tokens.
The `--motion-` prefix is deliberate: never define a token whose name a framework already owns.
Redefining a framework's token, such as Tailwind v4's `--ease-*` (see SKILL.md step 0), retimes every utility that uses it.

```css
:root {
  --motion-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --motion-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --motion-ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);

  --motion-duration-press: 140ms;
  --motion-duration-fast: 150ms;
  --motion-duration-base: 200ms;
  --motion-duration-slow: 250ms;
  --motion-duration-drawer: 400ms;
  --motion-duration-marketing: 600ms;
}
```

| Token | Range | Use |
| --- | --- | --- |
| `--motion-duration-press` | 100 to 160ms | Press feedback |
| `--motion-duration-fast` | 125 to 200ms | Tooltips, small popovers |
| `--motion-duration-base` | 150 to 250ms | Dropdowns, selects, collapse, tab indicator, release snap-back, toast exit |
| `--motion-duration-slow` | 200 to 300ms | Modals with backdrop, toast entry |
| `--motion-duration-drawer` | up to 500ms | Drawers and sheets crossing a viewport edge (E4) |
| `--motion-duration-marketing` | longer allowed | Marketing and explanatory motion only |

Toast: enters in `--motion-duration-slow` with `--motion-ease-out`, exits in `--motion-duration-base` with `--motion-ease-out` along the same edge, as a transition.

Springs, written for Motion (motion.dev):

| Use | Config |
| --- | --- |
| Default settle (I4) | `{ type: "spring", bounce: 0, duration: 0.4 }` |
| After a momentum gesture (I4) | `{ type: "spring", bounce: 0.2, duration: 0.4 }` |

Need a curve the table lacks?
Pick one from a published easing library rather than tuning control points by hand, and treat it like the block above.
