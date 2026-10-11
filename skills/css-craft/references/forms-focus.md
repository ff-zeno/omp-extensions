# Forms, focus and interaction states

Every `var(--…)` in a snippet is a placeholder for the project's token with that job.
Numbers marked `/* placeholder */` bind to the project's scale.
When the kit's Button, Input, Textarea or Card already covers an entry, fix the kit component once instead of patching each use.

## Focus ring that is missing or invisible

Keep the kit's focus style.
For a new component, or a project with no focus style:

```css
:focus-visible {
  outline: var(--focus-width) solid var(--focus-color);
  outline-offset: var(--focus-offset);
}
```

A component that draws its ring with `box-shadow`:

```css
.input:focus-visible {
  outline: var(--focus-width) solid transparent;
  box-shadow: 0 0 0 var(--focus-width) var(--focus-color);
}
```

Rules:

- Never write `outline: none` without a replacement. Forced-colors mode (Windows High Contrast) drops `box-shadow` and repaints a transparent outline in a system color, so the transparent outline is the ring those users see.
- In Tailwind v4, `outline-hidden` keeps that forced-colors outline and `outline-none` removes it.
- The ring sits on the page background, outside the control. `currentColor` on a filled button can fail 3:1 contrast against that background. Pick a color that contrasts with what is behind the ring.
- Use `:focus-visible`, not `:focus`, so a mouse click does not draw the ring.

Support: Chrome 86, Firefox 85, Safari 15.4.

## Hover state stuck after a tap

Touch screens fake hover. The first tap applies `:hover` and leaves it until the user taps elsewhere.

```css
@media (hover: hover) and (pointer: fine) {
  .button:hover { background: var(--primary-hover); }
}
```

Rules:

- `(hover: hover)` alone lets through some styluses and Android devices that claim hover. Add `(pointer: fine)` in hand-written CSS.
- Tailwind v4 `hover:` compiles to `(hover: hover)` already. Leave it as is. In Tailwind v3, the `future.hoverOnlyWhenSupported` flag does the same.
- Touch users still need press feedback. Give it with `:active`, which works for every input. Press animation values belong to the `motion` skill.

Support: Chrome 38, Firefox 64, Safari 9.

## Tap target smaller than the minimum

For icon buttons and close buttons that look smaller than the target size.

```css
.icon-button { position: relative; }

.icon-button::after {
  content: "";
  position: absolute;
  inset: min(0px, (100% - var(--target-min)) / 2);
}
```

`--target-min` is an accessibility minimum, not a design token: 44px on touch platforms, 24px for WCAG 2.5.8.

Rules:

- The formula grows only targets smaller than the minimum. A larger button keeps its own box.
- `overflow: hidden` or `clip` on the button cuts the area off.
- It does not work on `<input>`, which has no pseudo-elements. Wrap the input in a `<label>`.
- Neighboring targets must not overlap their grown areas.
- It uses `::after`, as the clickable card below does. Never combine both on one element.

Support: Chrome 87, Firefox 66, Safari 14.1.

## Whole card clickable from one link

An `<a>` wrapped around a card makes a screen reader read every word as the link text.
A click handler on a `div` is not a link at all.
Use one real link and stretch it.

```html
<article class="card">
  <h3><a class="card-link" href="/reports/q3">Quarterly report</a></h3>
  <p>Revenue grew in every region.</p>
  <button type="button">Save</button>
</article>
```

```css
.card { position: relative; }

.card-link::after {
  content: "";
  position: absolute;
  inset: 0;
}

.card-link:focus-visible { outline: var(--focus-width) solid transparent; }

.card:has(.card-link:focus-visible) {
  outline: var(--focus-width) solid var(--focus-color);
  outline-offset: var(--focus-offset);
}

.card :is(button, a:not(.card-link)) {
  position: relative;
  z-index: 1;
}
```

Rules:

- No element between the card and the link may be positioned. The overlay sizes itself to the nearest positioned ancestor.
- Make the link's own ring transparent, never remove it. Write the full shorthand. Safari ignores `outline-color` alone on its default ring.
- Other controls in the card get `position: relative` and `z-index: 1`, or the overlay swallows their clicks.
- Text under the overlay cannot be selected. Accept it.
- Put hover styles on `.card:hover`, inside the hover query above.

Support: `:has()` in Chrome 105, Firefox 121, Safari 15.4.

## Errors shown before the user has typed

Failure: required fields turn red on page load.
For native forms, `:user-invalid` matches only after the user has interacted with the field.

```css
input:user-invalid { border-color: var(--danger); }
```

Rules:

- If the project's form library sets `aria-invalid` and its own error state, keep that convention.
- Color alone is not enough. Pair it with an error message or icon.
- The server still validates.

Support: Chrome 119, Firefox 88, Safari 16.5.

## iOS zooms into a focused input

iOS Safari zooms when focus lands on an input with text under 16px, and it does not zoom back out.

```css
input, textarea, select { font-size: max(16px, 1rem); }
```

Rules:

- 16px is Safari's threshold, not a design value. `max()` keeps the input at the reader's larger font setting.
- Never fix it with `maximum-scale=1` or `user-scalable=no`. That takes zoom away from people who need it.
- If the kit's input text is smaller by design, raise it in the kit's input component on `@media (pointer: coarse)`, not per screen.

## Textarea that grows with its content

Check the kit's Textarea first; it may already own this.

```css
textarea {
  field-sizing: content;
  min-block-size: 3lh; /* placeholder line count */
  max-block-size: 12lh; /* placeholder line count */
  resize: none;
}
```

Rules:

- Bound it with min and max sizes. A fixed `height` brings the fixed size back. Past the max it scrolls.
- No script and no hidden mirror element.
- Write no fallback. Without `field-sizing` the textarea stays fixed and scrolls.

Support: Chrome 123, Safari 26.2, Firefox 152.
