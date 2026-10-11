# Color and type

Every `var(--…)` in a snippet is a placeholder for the project's token with that job.
Numbers marked `/* placeholder */` bind to the project's scale.
Which tokens and type roles to use is the `ui-consistency` skill's job; this file covers the mechanics.

## Hover, tint and transparent versions of a color

Use the project's existing mechanism first: an opacity modifier such as `hover:bg-primary/90`, a hover or subtle token, or a kit variant.
Only when the project has none, derive the color from the base token with `color-mix()`.
Add a new token only after the user agrees to it.
Never hardcode a second hex or `rgba()`.

```css
:root {
  --primary-hover: color-mix(in oklch, var(--primary), black 15%); /* placeholder amount */
  --primary-subtle: color-mix(in oklch, var(--primary) 12%, transparent); /* placeholder amount */
}
```

Rules:

- Mix in the color space the project already uses. `in oklch` keeps lightness steps even, so prefer it when the project has no convention.
- Behind text, mix with the surface token instead of `transparent`. A translucent background makes the text's contrast depend on whatever sits behind it.

Support: `color-mix()` in Chrome 111, Firefox 113, Safari 16.2.

## Gray mix that turns purple or pink

Failure: mixing a brand color with a gray, white or black written in OKLCH drifts the hue.
A written hue of `0` is red.
Half `oklch(1 0 0)` and half a blue at hue 264 came out at hue 312 in Chrome and Safari.
With `none` as the hue, or the keyword `white`, it stayed at 264.

```css
--gray-1: oklch(98% 0 none); /* placeholder lightness */
```

Rule: write grays, white and black with `none` as the hue whenever they will be mixed.

## Writing a new palette

Write new colors in `oklch()`.
Keep an existing palette in its own format; converting it is churn with no fix.

## Light and dark tokens

In an existing project, keep its theme mechanism, whether that is a `.dark` class, a data attribute or a media query.
For a new project, each token can hold both values:

```css
:root {
  color-scheme: light dark;
  --background: light-dark(var(--gray-0), var(--gray-11));
  --foreground: light-dark(var(--gray-11), var(--gray-0));
}

[data-theme="light"] { color-scheme: light; }
[data-theme="dark"] { color-scheme: dark; }
```

Rules:

- `light-dark()` follows `color-scheme`. Without a `color-scheme` it always picks the light value.
- Switch themes by setting `color-scheme`, not by redefining tokens.
- `light-dark()` takes colors only. An image that differs by theme needs its own rule.
- In any project, `<meta name="color-scheme" content="light dark">` lets the browser paint the right background before the CSS loads.

Support: Chrome 123, Firefox 120, Safari 17.5.

## Fluid font sizes

Use this only when the project's type scale is already fluid, or for display type in new code.
Dense product UI keeps fixed sizes.
An existing project gets no second, parallel scale.

```css
:root {
  --text-display: clamp(2rem, 1.2rem + 4vw, 4.5rem); /* placeholder bounds */
}
```

Rules:

- Write the preferred value as `rem + vw`, never `vw` alone. `clamp(1rem, 1vw, 1.75rem)` stays at 16px on every screen under 1600px wide, and bare `vw` ignores the reader's font setting.
- Work it out from two points. The slope is `(max - min) / (wide - narrow)` in px over px; times 100 it is the `vw` number. The `rem` part is `min - slope × narrow`, converted to rem.
- Keep both bounds in `rem`.
- Keep the maximum at or below 2.5 times the minimum. The `vw` part does not grow with zoom, so past 2.5 times, 500% zoom cannot double the text at some widths. That fails WCAG 1.4.4.
- Put the `clamp()` in a token. Components use the token and never repeat the math.

## Digits that jitter in a column or counter

```css
.price, td, time { font-variant-numeric: tabular-nums; }
```

Rules:

- Do not set it globally. Proportional digits read better in prose.
- The font must ship tabular figures, or nothing changes.

Support: Chrome 52, Firefox 34, Safari 9.1.

## Lines that jump while typing

If the project sets `text-wrap: pretty` on a parent, text typed into a `textarea` or `contenteditable` inherits it, and earlier lines re-wrap as the user types.
Set `text-wrap: stable` on the editable element.

## Bold that renders as regular

With `font-synthesis: none`, a weight the page does not load renders as the regular weight with no warning.
Load every weight and style the design uses, or drop the property.

## Icon beside a label that can wrap

Failure: the icon sits beside the middle line of a two-line label, or a long label squeezes it.

```css
.notice {
  display: flex;
  align-items: start;
  gap: var(--icon-gap);
}

.notice > svg {
  flex: none;
  inline-size: var(--icon-size);
  block-size: 1lh;
}
```

Rules:

- Never use `align-items: center` on a label that can wrap.
- `block-size: 1lh` makes the icon's box one line tall, so the drawing centers on the first line. The drawing keeps the kit's icon size.
- Keep `flex: none`, or a long label squeezes the icon.
- The `svg` needs a `viewBox` to scale inside its box.

Support: `lh` in Chrome 109, Firefox 120, Safari 16.4.
