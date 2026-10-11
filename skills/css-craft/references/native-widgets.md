# Native dialogs, popovers, menus and accordions

Use this file only when the project's kit has no component for the widget.
If the kit has a Dialog, Popover, DropdownMenu, Sheet or Accordion, use it, and never hand-roll a second one beside it.
Every `var(--…)` is a placeholder for the project's token.
`--motion-duration-slow`, `--motion-duration-base` and `--motion-ease-out` are the `motion` skill's fallback names and stand for the project's own motion tokens; map each to the nearest one it has.
The `motion` skill decides whether the widget animates at all and owns the values.

## Enter and exit from `display: none`

Replaces a script that adds classes and waits for `transitionend`.

```css
/* Closed state: its transition runs on exit, one step faster than the entry. */
dialog,
[popover],
dialog::backdrop {
  opacity: 0;
  transition:
    opacity var(--motion-duration-base) var(--motion-ease-out),
    display var(--motion-duration-base) allow-discrete,
    overlay var(--motion-duration-base) allow-discrete;
}

/* Open state: its transition runs on entry. */
dialog[open],
dialog[open]::backdrop {
  opacity: 1;
  transition:
    opacity var(--motion-duration-slow) var(--motion-ease-out),
    display var(--motion-duration-slow) allow-discrete,
    overlay var(--motion-duration-slow) allow-discrete;
}

[popover]:popover-open {
  opacity: 1;
  transition:
    opacity var(--motion-duration-slow) var(--motion-ease-out),
    display var(--motion-duration-slow) allow-discrete,
    overlay var(--motion-duration-slow) allow-discrete;
}

@starting-style {
  dialog[open],
  dialog[open]::backdrop,
  [popover]:popover-open { opacity: 0; }
}
```

Rules:

- Put `@starting-style` after the open-state rule. It adds no specificity, so an earlier position loses to the open rule.
- Keep `[popover]:popover-open` out of the selector list that opens the dialog. A browser that does not know one selector in a list drops the whole rule, and the dialog opens at `opacity: 0`. Inside `@starting-style` the shared list is safe, because every browser that reads the block knows the selector.
- The `::backdrop` needs its own transition and the same three states. Without them it snaps while the dialog fades.
- The transition on the state being entered is the one that runs. That is why the open rule carries the entry duration and the closed rule the shorter exit duration.
- `display` and `overlay` with `allow-discrete` keep the element rendered and in the top layer until the exit finishes.
- Add movement only inside `@media (prefers-reduced-motion: no-preference)`. Never start a scale from `scale(0)`.
- Write no fallback. Where the exit is not supported the element closes at once.

Support: both directions in Chrome 117. Safari animates the entry and closes `<dialog>` and popovers at once. Firefox 129 animates the entry only.

## Popover anchored to its trigger

Replaces a positioning library or a script that reads `getBoundingClientRect()`.

```html
<button popovertarget="menu">Options</button>
<div id="menu" popover>
  <button>Rename</button>
  <button>Delete</button>
</div>
```

```css
@supports (position-area: block-end) {
  [popover] {
    margin: 0;
    margin-block-start: var(--popover-gap);
    position-area: block-end span-inline-end;
    position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
  }
}
```

Rules:

- Use `span-*` values, not `center`. `center` stops the flips when the popover is wider than its grid cell.
- `margin-block-start` is the gap to the trigger. The flip mirrors it, so the gap stays on the trigger's side.
- A popover opened from a script has no anchor and lands in the top-left corner. Pass the trigger: `menu.showPopover({ source: button })`.
- A menu still needs arrow-key navigation and the right roles. The popover gives light dismiss and top layer, nothing more.
- Write no fallback. Without support the `@supports` block is skipped and the popover opens centered in the viewport.

Support: Chrome 133, Firefox 147, Safari 26.

## Accordion that animates its height

Animating to `height: auto` is otherwise off limits; the `motion` skill covers other collapses.
This is the one allowed exception, because it is progressive enhancement: `interpolate-size` animates where supported, and every other browser opens and closes instantly with nothing broken.
`<details>` already gives the toggle, keyboard support and find-in-page.

```css
details { interpolate-size: allow-keywords; }

details::details-content {
  block-size: 0;
  overflow: clip;
}

details[open]::details-content { block-size: auto; }

@media (prefers-reduced-motion: no-preference) {
  details::details-content {
    transition:
      block-size var(--motion-duration-slow) var(--motion-ease-out),
      content-visibility var(--motion-duration-slow) allow-discrete;
  }
}
```

Rules:

- Set `interpolate-size` on `details`, not `:root`. It inherits, and on `:root` it changes how every keyword size in the app transitions.
- Without the `content-visibility … allow-discrete` line the close snaps shut.
- Put padding on an element inside, never on `::details-content`. Padding there stays visible when closed.
- Give sibling `<details>` the same `name` attribute to keep one open at a time.
- Hide the marker with `summary { list-style: none; }` plus `summary::-webkit-details-marker { display: none; }` for Safari.
- Write no fallback. Browsers without `interpolate-size` open and close without animation.

Support: `::details-content` in Chrome 131, Safari 18.4, Firefox 143. `interpolate-size` in Chrome 129 only.

## Panel revealed with `clip-path`

For dropdowns and panels that open over the page with an unknown height.
It unrolls without animating `height` and works in every browser.

```css
.menu {
  clip-path: inset(0 calc(-1 * var(--shadow-reach)) 100%);
  visibility: hidden;
}

.menu.is-open {
  clip-path: inset(0 calc(-1 * var(--shadow-reach)) calc(-1 * var(--shadow-reach)));
  visibility: visible;
}

@media (prefers-reduced-motion: no-preference) {
  .menu {
    transition:
      clip-path var(--motion-duration-base) var(--motion-ease-out),
      visibility var(--motion-duration-base);
  }
}
```

Rules:

- `--shadow-reach` must exceed the shadow's blur plus its offset, or the clip cuts the shadow.
- Transition `visibility` with the clip. It removes the closed panel's links from the tab order.
- Use it only for panels that overlap the page. A closed panel in normal flow leaves a gap; an accordion uses `<details>` above.
- Add `round` inside `inset()` only when the clip itself needs round corners. The element's `border-radius` still applies.

Support: every browser.
