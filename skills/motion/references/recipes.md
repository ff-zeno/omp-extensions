# Motion recipes

Starting points for the common cases.
Swap every `--motion-*` token for the repo's own token, and every state selector for the kit's attributes.
With no repo tokens and no agreement to add the fallbacks yet, inline the fallback values from catalog.md instead (catalog "Fallback values").
Selectors such as `[data-starting-style]`, `[data-ending-style]`, `[data-closed]` and `--transform-origin` are placeholders for whatever the kit exposes for open, closed and trigger origin.
If the kit already animates the component, keep its motion and skip the recipe.

Every recipe uses one pattern for reduced motion (catalog A1).
The opacity fade sits outside the media query and survives reduced motion.
Movement is added inside `@media (prefers-reduced-motion: no-preference)`.

Drag, swipe and flick recipes live in native-gestures.md.

## Button press

```css
.button:active {
  transform: scale(0.97);
}

@media (prefers-reduced-motion: no-preference) {
  .button {
    transition: transform var(--motion-duration-press) var(--motion-ease-out);
  }
}
```

`:active` is a real press on touch, so it needs no hover gate.

## Popover, dropdown, menu, select

```css
.popover {
  transform-origin: var(--transform-origin);
  transition: opacity var(--motion-duration-base) var(--motion-ease-out);
}

.popover[data-starting-style],
.popover[data-ending-style] {
  opacity: 0;
}

.popover[data-ending-style] {
  transition-duration: var(--motion-duration-fast);
}

@media (prefers-reduced-motion: no-preference) {
  .popover {
    transition-property: opacity, transform;
  }

  .popover[data-starting-style],
  .popover[data-ending-style] {
    transform: scale(0.95);
  }
}
```

The origin is the point of the recipe: the panel grows out of the control that opened it.

## Tooltip

The popover recipe with `--motion-duration-fast` in, `--motion-duration-press` out and `scale(0.97)`, plus instant neighbors (catalog E7):

```css
.tooltip[data-instant] {
  transition-duration: 0ms;
}
```

## Modal with backdrop

```css
.modal {
  transform-origin: center;
  transition: opacity var(--motion-duration-slow) var(--motion-ease-out);
}

.backdrop {
  transition: opacity var(--motion-duration-slow) var(--motion-ease-out);
}

.modal[data-starting-style],
.modal[data-ending-style],
.backdrop[data-starting-style],
.backdrop[data-ending-style] {
  opacity: 0;
}

.modal[data-ending-style],
.backdrop[data-ending-style] {
  transition-duration: var(--motion-duration-base);
}

@media (prefers-reduced-motion: no-preference) {
  .modal {
    transition-property: opacity, transform;
  }

  .modal[data-starting-style],
  .modal[data-ending-style] {
    transform: scale(0.96);
  }
}
```

Modal and backdrop share a duration so they read as one surface.

## Drawer or sheet

```css
.drawer {
  transition: opacity var(--motion-duration-base) var(--motion-ease-out);
}

.drawer[data-closed] {
  opacity: 0;
  transition-duration: var(--motion-duration-fast);
}

@media (prefers-reduced-motion: no-preference) {
  .drawer {
    transition: transform var(--motion-duration-drawer) var(--motion-ease-drawer);
  }

  .drawer[data-closed] {
    opacity: 1;
    transform: translateY(100%);
    transition-duration: var(--motion-duration-slow);
  }
}
```

With motion allowed, the drawer slides by its own height; under reduced motion it fades.
Once the user can drag it, it becomes a gesture: see native-gestures.md.

## Toast

```css
.toast {
  inset-block-end: calc(env(safe-area-inset-bottom, 0px) + var(--toast-offset));
  transition: opacity var(--motion-duration-slow) var(--motion-ease-out);

  @starting-style {
    opacity: 0;
  }
}

.toast[data-leaving] {
  opacity: 0;
  transition-duration: var(--motion-duration-base);
}

@media (prefers-reduced-motion: no-preference) {
  .toast {
    transition-property: opacity, transform;

    @starting-style {
      transform: translateY(100%);
    }
  }

  .toast[data-leaving] {
    transform: translateY(100%);
  }
}
```

It is a transition, not keyframes, because toasts arrive in bursts and must retarget (catalog I1).
Without `@starting-style` support, set a `data-mounted` attribute one frame after mount and style the entry from it.
When toasts stack and the list reflows, tune the opacity against the height change by eye; no formula exists for that pair.
Dismiss timers follow catalog R4.

## Accordion or collapse

Use the kit's collapsible when it has one; it measures the height for you.

Native `<details>`, or any element animating to `auto` (catalog P1 exception):

```css
:root {
  interpolate-size: allow-keywords;
}

details::details-content {
  overflow: clip;
  block-size: 0;
}

details[open]::details-content {
  block-size: auto;
}

@media (prefers-reduced-motion: no-preference) {
  details::details-content {
    transition:
      block-size var(--motion-duration-base) var(--motion-ease-out),
      content-visibility var(--motion-duration-base) allow-discrete;
  }
}
```

Browsers without these features open and close instantly.

Anywhere else, animate to a measured height:

```css
.collapse-content {
  overflow: clip;
  block-size: var(--collapse-height); /* the kit's measured-height variable */
}

@media (prefers-reduced-motion: no-preference) {
  .collapse-content {
    transition: block-size var(--motion-duration-base) var(--motion-ease-out);
  }
}
```

Without a kit, measure the content height in script.

## Group entrance with stagger

Use only where catalog E8 allows a stagger.

```css
@media (prefers-reduced-motion: no-preference) {
  .item {
    animation: item-enter var(--motion-duration-slow) var(--motion-ease-out) backwards;
    animation-delay: calc(var(--i, 0) * 50ms);
  }
}

@keyframes item-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
```

Set `--i` per item, `style="--i: 2"`.
The base style is the visible end state, so the list shows with no animation and no script (catalog R1).
`backwards` holds the `from` frame only while the delay runs.

## Hold to confirm

For destructive actions where one click is too easy.

```css
.hold-fill {
  clip-path: inset(0 100% 0 0);
  transition: clip-path var(--motion-duration-base) var(--motion-ease-out);
}

.hold-button:active .hold-fill {
  clip-path: inset(0 0 0 0);
  transition: clip-path 2s linear;
}
```

Timing follows catalog E1 and E6: slow `linear` fill while pressed, fast snap-back on release.
Add the button press recipe for the scale.
Fire the action from script only when the fill completes while still pressed, and give the button a keyboard path that does the same.

## Tab indicator with a color change

Timing separate color transitions across a tab list never lines up.
Duplicate the tab list, style the copy as the active state, and clip the copy to the active tab:

```css
.tabs-active-copy {
  clip-path: inset(0 var(--clip-right) 0 var(--clip-left));
}

@media (prefers-reduced-motion: no-preference) {
  .tabs-active-copy {
    transition: clip-path var(--motion-duration-base) var(--motion-ease-in-out);
  }
}
```

Script sets `--clip-left` and `--clip-right` from the active tab's box on change, once per change, not per frame.
Text and background change together because one element is revealed instead of two colors interpolating.
Hide the copy from assistive tech with `aria-hidden="true"`.

## Scroll reveal

Marketing pages only, never daily-use UI.

```css
.js .reveal:not([data-visible]) {
  clip-path: inset(0 0 100% 0);
}

@media (prefers-reduced-motion: no-preference) {
  .reveal {
    transition: clip-path var(--motion-duration-marketing) var(--motion-ease-in-out);
  }
}
```

```html
<!-- Blocking, in <head>: the class exists before first paint, so nothing visible hides later. -->
<!-- If the reveal script has not run within 3s, the class comes off and content shows (catalog R1). -->
<script>
  document.documentElement.classList.add("js");
  setTimeout(() => {
    if (!window.revealReady) document.documentElement.classList.remove("js");
  }, 3000);
</script>
```

```js
window.revealReady = true;
const pending = new Set(document.querySelectorAll(".reveal"));

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) show(entry.target);
  }
}, { rootMargin: "0px", threshold: 0 });

function show(el) {
  el.setAttribute("data-visible", "");
  observer.unobserve(el);
  pending.delete(el);
}

pending.forEach((el) => observer.observe(el));

// Items that can never scroll into view still show once the page bottoms out.
addEventListener("scroll", () => {
  const atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 1;
  if (atEnd) [...pending].forEach(show);
}, { passive: true });
```

The observer reports items already in view on its first callback, so nothing on screen at load stays hidden.
It fires once; re-animating on every scroll pass fights the reader.

## Crossfade that will not settle

When two states visibly double up and no easing or duration fixes it, blur the seam:

```css
.content {
  transition:
    filter var(--motion-duration-base) ease,
    opacity var(--motion-duration-base) ease;
}

.content[data-transitioning] {
  filter: blur(2px);
  opacity: 0.7;
}
```

The blur blends the two states into one change instead of two objects swapping.

## Script-driven, no library

```js
const root = getComputedStyle(document.documentElement);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

el.animate(
  [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }],
  {
    duration: reduce ? 0 : parseFloat(root.getPropertyValue("--motion-duration-slow")),
    easing: root.getPropertyValue("--motion-ease-in-out").trim(),
    fill: "forwards",
  },
);
```

The Web Animations API reads the same tokens as CSS and adds no bundle cost.
`clip-path` here runs on the main thread in most browsers; use `transform` or `opacity` keyframes when the page will be busy (catalog T1).
