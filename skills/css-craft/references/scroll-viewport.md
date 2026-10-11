# Scroll and viewport

Every `var(--…)` in a snippet is a placeholder for the project's token with that job.
Numbers marked `/* placeholder */` bind to the project's scale.
If the kit's dialog, sheet or drawer already handles an entry's concern, leave it to the kit.

## Scroll area between a fixed header and footer

The most common modal and drawer bug.
Failure: the whole panel scrolls, the footer is pushed off screen, or the body never scrolls at all.

```css
.panel {
  display: flex;
  flex-direction: column;
  max-block-size: 80dvh; /* placeholder limit */
}

.panel-header,
.panel-footer { flex: none; }

.panel-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.panel-wrap {
  flex: 1;
  min-block-size: 0;
  display: flex;
  flex-direction: column;
}
```

Rules:

- The panel needs a limit, `max-block-size` or a height. With no limit nothing overflows.
- A flex item's default minimum height is its content, so any element between the panel and the body needs `min-block-size: 0`. That is `.panel-wrap`. Leave it out when the body is a direct child.
- The header and footer get `flex: none`, or they shrink under their own text when the body overflows.
- Set `min-block-size: 0` on the elements that need it, never in a global reset. Applied to every element it lets each item of a fixed-height column shrink under its text.
- `overscroll-behavior: contain` stops the page behind from scrolling when the body hits its end.
- The gutter reserves the scrollbar's width on a short list too. That is the price of no shift.

Support: `scrollbar-gutter` in Chrome 94, Firefox 97, Safari 18.2. `overscroll-behavior` in Chrome 63, Firefox 59, Safari 16. `dvh` in Chrome 108, Firefox 101, Safari 15.4.

## Full-height layouts on a phone

Failure: a `100vh` screen overflows on load and its bottom button sits under the browser toolbar.
On mobile, `vh` is the largest viewport, measured with the toolbar collapsed.

| Element | Unit | Why |
| --- | --- | --- |
| Document, hero, first screen | `min-block-size: 100svh` | Smallest viewport, so nothing is cut off, and it does not change while scrolling |
| App shell, drawer, anything with UI pinned to the bottom | `block-size: 100dvh` | Tracks the toolbar as it shows and hides |

`dvh` on a document or hero resizes mid-scroll and shifts the layout.

`lvh` equals the old `vh` and is rarely what you want.

Support: Chrome 108, Firefox 101, Safari 15.4.

## Page scrolls behind an open modal

Use this only when the kit's dialog does not already lock scroll.

```css
html { scrollbar-gutter: stable; }
html:has(dialog:modal) { overflow: hidden; }
```

Rules:

- `:modal` matches only a dialog opened with `showModal()`, so a non-modal dialog leaves the page scrollable.
- Keep `scrollbar-gutter: stable` with the lock. Without it the page shifts sideways when the scrollbar disappears.
- The reserved gutter puts centered content slightly off-center on a page too short to scroll. Accept it.
- `overflow: hidden` is right here. The root's overflow applies to the viewport, which is the thing that must stop scrolling.

Support: `:has()` in Chrome 105, Firefox 121, Safari 15.4.

## Carousel on native scroll

Swipe, trackpad, keyboard and momentum all work before any script loads.

```css
.carousel {
  display: flex;
  gap: var(--gap);
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  padding-inline: var(--gutter);
  scroll-padding-inline: var(--gutter);
  overscroll-behavior-x: contain;
}

.carousel > * {
  flex: none;
  scroll-snap-align: start;
}

@media (prefers-reduced-motion: no-preference) {
  .carousel { scroll-behavior: smooth; }
}
```

Arrow buttons are the only part that needs a script:

```js
const carousel = document.querySelector(".carousel");
const sign = getComputedStyle(carousel).direction === "rtl" ? -1 : 1;

function step(dir) {
  const card = carousel.firstElementChild.getBoundingClientRect().width;
  const gap = parseFloat(getComputedStyle(carousel).columnGap) || 0;
  carousel.scrollBy({ left: sign * dir * (card + gap) });
}
```

Rules:

- Never move slides with `transform`, and never handle wheel or touch events yourself.
- Match `scroll-padding-inline` to `padding-inline`, so a snapped card lines up with the page content.
- In RTL `scrollLeft` runs negative, so flip the step with `sign` and compare `Math.abs(scrollLeft)` when disabling the arrows.
- `overscroll-behavior-x: contain` stops a swipe at the last card from triggering the browser's back gesture.
- A native-scroll carousel needs no `touch-action`. `touch-action: pan-y` here would block the horizontal swipe. It is only for a carousel driven by a script gesture (`mobile.md`).

## Rubber-band bounce and pull-to-refresh

Leave a scrolling document alone; its bounce and pull-to-refresh are expected.
In an app shell with fixed UI, a trackpad overscroll on macOS drags the whole page and the fixed UI with it.

```css
html { overscroll-behavior-y: none; }

/* Only when pull-to-refresh is welcome on touch devices */
@media (any-pointer: coarse) {
  html { overscroll-behavior-y: auto; }
}

.sheet-body,
.chat-list { overscroll-behavior: contain; }
```

Rules:

- Set it on `html` only. The viewport takes its overscroll behavior from the root element.
- Use the `-y` longhand. The `overscroll-behavior: none` shorthand also sets the x axis, and `x: none` turns off swipe to go back.
- Drop the `any-pointer: coarse` block when pull-to-refresh fights the app, such as a sheet the user drags down or a canvas.
- Give inner scroll containers `contain`. They keep their own bounce and stop the page behind them from moving.
- Never use a `touchmove` listener with `preventDefault()` for this. It blocks scrolling and makes the listener non-passive, which costs frames.

## In-page links hidden under a sticky header

```css
html { scroll-padding-block-start: var(--header-height); }

@media (prefers-reduced-motion: no-preference) {
  html { scroll-behavior: smooth; }
}
```

Rules:

- Share one custom property between the header's height and the scroll padding, so they cannot drift apart.
- Keep the padding outside the motion query, so people who ask for reduced motion still get the offset.

Support: Chrome 69, Firefox 68, Safari 14.1.

## Content under the notch or home indicator

For fixed headers, bottom bars, toasts and sheets in an app-like page.
Add `viewport-fit=cover` to the viewport meta tag, then pad those elements by the safe-area insets.

```css
.app-header { padding-block-start: env(safe-area-inset-top, 0px); }
.bottom-bar { padding-block-end: env(safe-area-inset-bottom, 0px); }
.sheet { padding-block-end: calc(var(--sheet-pad) + env(safe-area-inset-bottom, 0px)); }
```

Rules:

- Without `viewport-fit=cover` every inset is `0px` and the padding does nothing.
- Give `env()` a `0px` fallback wherever it sits inside `calc()`.
- `calc(pad + inset)` keeps the visual padding above the inset. `max(pad, inset)` uses whichever is larger. Pick by whether the padding is spacing or only a minimum.
- Normal page content needs none of this. Pad the fixed elements, never `body`.

Support: Chrome 69, Firefox 65, Safari 11.1.

## Edge fade only when a row overflows

Progressive enhancement for tabs, toolbars and table wrappers.
It replaces a `ResizeObserver` that compares `scrollWidth` with `clientWidth`.

```css
@keyframes overflowing {
  from, to { --fade: var(--fade-size); }
}

.scroller {
  --fade: 0px;
  overflow-x: auto;
  animation: overflowing linear;
  animation-timeline: scroll(self inline);
  mask-image: linear-gradient(to right, transparent, #000 var(--fade), #000 calc(100% - var(--fade)), transparent);
}
```

Rules:

- Write `animation-timeline` after `animation`. The shorthand resets the timeline.
- Declare the default outside the keyframes, as `--fade: 0px` does. With nothing to scroll there is no timeline, so the default holds.
- The mask's `#000` is the opaque mask stop, not a visible color.
- Write no fallback. Without scroll timelines the row scrolls with no fade.

Support: `animation-timeline` in Chrome 115 and Safari 26. Not in Firefox release builds.
