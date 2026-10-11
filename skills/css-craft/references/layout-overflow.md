# Layout and overflow

Every `var(--…)` in a snippet is a placeholder for the project's token with that job.
Numbers marked `/* placeholder */` bind to the project's scale.
Existing code changes only where it shows the failure an entry names.

## Text that overflows its box

Failure: a long name or URL pushes past the card, or the ellipsis never appears.
Decide per field whether it wraps, cuts to one line, or cuts to a few lines.

```css
.card { overflow-wrap: break-word; }

.name {
  white-space: nowrap;
  overflow: clip;
  text-overflow: ellipsis;
}

.excerpt {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3; /* placeholder line count */
  overflow: clip;
}
```

Rules:

- Truncate on the element that holds the text. On a flex or grid container the text is cut with no ellipsis.
- Every flex item between the row and the text needs `min-inline-size: 0`. A flex item's default minimum is its content width, so it refuses to shrink.
- `min-inline-size: 0` lets the box shrink but does not break a long word. Pair it with `overflow-wrap: break-word`.
- Use `break-word`, not `anywhere`. `anywhere` also lowers the min-content width, so a box sized by its content collapses to one letter per line.
- Tables are the exception. An auto-layout table ignores `break-word`, so set `overflow-wrap: anywhere` on the cell.
- Do not make a flex item shrink with `overflow: hidden`. It works by accident, breaks `position: sticky` inside the item and clips focus rings. Use `min-inline-size: 0`.
- Write all four clamp declarations. The prefixed form is the one browsers run.
- Put padding on a wrapper, never on the clamped element. The next line shows through the bottom padding.
- Truncate only text the reader can get in full elsewhere, such as a detail view or a tooltip.

Support: `text-overflow`, `-webkit-line-clamp` and `overflow-wrap: break-word` work everywhere. If the ellipsis does not draw with `clip` in a target browser, use `overflow: hidden` on that text element; it holds no sticky children.

## Sticky element that scrolls away

Failure: `position: sticky` does nothing.
Cause one: an ancestor has `overflow: hidden`, `auto` or `scroll`.
That ancestor becomes the scroll container and the element sticks to it instead of the page.
`hidden` also turns the other axis to `auto`, which adds stray scrollbars.

```css
.hero { overflow-x: clip; }
```

`clip` cuts the overflow without creating a scroll container.

Cause two: the sticky element is stretched to the full height of a flex or grid row, so it has no room to move.

```css
.sidebar {
  position: sticky;
  inset-block-start: var(--header-height);
  align-self: start;
}
```

Rules:

- Find the ancestor with DevTools before changing anything. Change only that one.
- Keep `hidden` or `auto` on an element a script scrolls. `clip` blocks programmatic scrolling too.
- Keep `hidden` or `auto` on an element with `resize`. With `clip` the browser draws no resize handle.
- Put `clip` on the element that overflows, not on `html` or `body`.

Support: `overflow: clip` in Chrome 90, Firefox 81, Safari 16.

## Centered content pushed past the edge

Failure: a centered tab row or a vertically centered modal overflows, and its start is cut off where no scroll can reach it.

```css
.tabs {
  display: flex;
  overflow-x: auto;
  justify-content: safe center;
}
```

Rules:

- `safe` works on every `align-*`, `justify-*` and `place-*` property.
- Auto margins on the item center it the same way and work wherever flexbox does.

Support: Chrome 115, Firefox 63, Safari 17.6.

## Container query that never matches

```css
.slot { container-type: inline-size; }

@container (width > 30rem) { /* placeholder breakpoint */
  .card { display: grid; grid-template-columns: var(--media-width) 1fr; }
}
```

Rules:

- The container must be an ancestor. An element cannot query itself.
- Never put `container-type` on a shrink-to-fit element, such as a flex item with no basis or an inline-block. A container cannot take its width from its content, so it collapses to zero.
- With no container ancestor the query never matches. Making `header`, `main` and `footer` containers covers most components.
- A container cannot also be a subgrid. Use two elements.
- Container units differ from queries. With no container above, `cqi` measures the viewport.
- Never register a `cqi` token with `@property`. A registered length computes once on `:root`, where there is no container, and every slot gets the viewport's value.

Support: Chrome 105, Firefox 110, Safari 16.

## Equal cards without breakpoints

```css
.grid {
  display: grid;
  gap: var(--gap);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--card-min)), 1fr));
}
```

Rules:

- `min(100%, …)` stops a card from overflowing a container narrower than `--card-min`.
- `auto-fit` stretches a short row to fill the width. Use `auto-fill` when the count changes, such as a filtered list, so cards keep their size.

Support: Chrome 79, Firefox 76, Safari 11.1.

## Card parts that line up across a row

Failure: titles, bodies and footers sit at different heights in neighboring cards.

```css
.card {
  display: grid;
  grid-row: span 3; /* number of parts */
  grid-template-rows: subgrid;
  row-gap: var(--card-gap);
}
```

Rules:

- The span must equal the number of parts. Without it every part piles into one row.
- Set `row-gap` on the card, or it inherits the parent's gap.

Support: Chrome 117, Firefox 71, Safari 16.

## Sidebar that wraps on its own

For a media object, an input with a button, or a page with an aside.

```css
.with-sidebar { display: flex; flex-wrap: wrap; gap: var(--gap); }
.sidebar { flex-basis: var(--sidebar-width); flex-grow: 1; }
.main { flex-basis: 0; flex-grow: 999; min-inline-size: 50%; /* placeholder wrap point */ }
```

Rules:

- The wrap point is a share of the container, not a length. Change `min-inline-size` to move it.
- Drop the sidebar's `flex-basis` for a sidebar sized by its content.
- A bare `img` or `video` as one side stretches to the row height and distorts. Set `align-items: start` on the container.

Support: Chrome 84, Firefox 63, Safari 14.1.

## Layers stacked with grid

For text over an image, a badge on a card, or two icons that swap.

```css
.stack { display: grid; }
.stack > * { grid-area: 1 / 1; }
.stack > .badge { place-self: start end; }
```

Rules:

- A later layer in the DOM paints on top. Use `z-index` only to change that order.
- Keep `position: absolute` for a layer that must not affect the container's size.

## One item pushed to the far end

For card actions at the bottom, an account link at the end of a toolbar.

```css
.card { display: flex; flex-direction: column; gap: var(--gap); }
.card > .actions { margin-block-start: auto; }

.toolbar { display: flex; gap: var(--gap); }
.toolbar > .account { margin-inline-start: auto; }
```

Rules:

- The container needs free space. A card has it when a grid row stretches it. A column that is the only child of a taller box needs `block-size: 100%`.
- Use `min-block-size`, never `block-size`, for a tall section. A fixed height cuts off long content.
- This works in flex only. In a grid column the spare height goes to the rows.
- It replaces spacer elements, `space-between` with more than two children, and wrapper groups.

## Sibling spacing set by the parent

Failure: double gaps, or a stray margin above the first child, because children carry their own margins.

```css
.fields { display: flex; flex-direction: column; gap: var(--field-gap); }

.prose > * { margin-block: 0; }
.prose > * + * { margin-block-start: var(--flow-space); }
```

Rules:

- Use `gap` when you know the children. Use the margin form for CMS or Markdown output, because flex turns every child into a flex item.
- A flex column stretches its children, so a button that is a direct child goes full width. Set `align-self: start` on it.
- In the margin form, zero the children's block margins first. Keep the `>`, or the rule reaches nested list items.
- The margin form counts a hidden child, so a hidden first child leaves space at the top. `gap` ignores it.

Support: flex `gap` in Chrome 84, Firefox 63, Safari 14.1.

## Nested rounded corners that look off

```css
.card {
  padding: var(--card-pad);
  border-radius: calc(var(--radius-inner) + var(--card-pad));
}
.card > img { border-radius: var(--radius-inner); }
```

Rules:

- Derive the outer radius from the inner token. The reverse reaches zero once padding exceeds the radius.
- Both values come from existing tokens. The `calc()` is the only new thing.

## Page container with breakouts

Use it only when the project has no container component.
If it has one, use that, and never replace it with this.

```css
.content-grid {
  display: grid;
  grid-template-columns:
    [full-start] minmax(var(--gutter), 1fr)
    [breakout-start] minmax(0, calc((var(--breakout) - var(--content)) / 2))
    [content-start] min(100% - var(--gutter) * 2, var(--content)) [content-end]
    minmax(0, calc((var(--breakout) - var(--content)) / 2)) [breakout-end]
    minmax(var(--gutter), 1fr) [full-end];
}
.content-grid > * { grid-column: content; }
.content-grid > .breakout { grid-column: breakout; }
.content-grid > .full { grid-column: full; }
```

Rules:

- Every child must be placed. An unplaced child lands in the gutter track.
- Every direct child is a grid item. Wrap a run of inline elements in one element.
- Change a width by overriding `--content`, not by writing a new template.

## Image box that holds any upload

Failure: thumbnails take the file's shape, the layout jumps on load, or a white avatar has no edge.

```css
.thumb {
  inline-size: 100%;
  block-size: auto;
  aspect-ratio: 16 / 9; /* placeholder ratio */
  object-fit: cover;
  background-color: var(--surface-muted);
}

.avatar {
  flex: none;
  inline-size: var(--avatar-size);
  block-size: var(--avatar-size);
  border-radius: 50%;
  object-fit: cover;
  outline: var(--border-width) solid var(--border-subtle);
  outline-offset: calc(-1 * var(--border-width));
}
```

Rules:

- One axis must be `auto`. A `height` attribute or fixed height wins over the ratio.
- `object-fit` does nothing until the box has both sizes or a ratio.
- `cover` crops. Use `contain` for logos and product shots. Move the crop with `object-position`.
- Leave the background off an image with transparent areas.
- A fixed-size image in a flex row needs both sizes and `flex: none`. With only a width it stretches to the row height or gets squeezed.
- Safari draws a failed image as a square and ignores `aspect-ratio`. Where a failed load must not move the layout, put the ratio on a wrapper and give the image `inline-size: 100%` and `block-size: 100%`.
- The inner outline gives a white avatar an edge on a white page. Its color needs a dark-mode value too.

Support: `aspect-ratio` in Chrome 88, Firefox 89, Safari 15. An outline that follows `border-radius` in Chrome 94, Firefox 88, Safari 16.4.
