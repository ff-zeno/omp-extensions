# Mobile web that feels native

The platform layer: viewport, touch, scroll, safe areas and browser chrome.
Most fixes are one declaration or one meta tag.
Every `var(--…)` and color value is a placeholder for the project's token.

## Rules that hold for every fix

- Apply a fix where its reason applies, not globally out of habit. `user-select: none` on a button is right; on body text it is a defect.
- Detect capability with media queries: `(hover)`, `(pointer)`, `(any-pointer)`. Never branch on the user agent or screen width to guess at touch.
- Touch and mouse are not exclusive. Tablets have trackpads and laptops have touch screens. Gate each style by capability.
- Never disable zoom. Fix the input font size, which is what causes the zoom.
- Device emulation in a desktop browser reproduces none of these bugs. Real hardware decides.
- Reach for CSS or a meta tag before JavaScript. A `useIsTouchDevice()` hook to hide hover styles is the wrong tool.

## Symptom table

| Symptom | Fix | Where |
| --- | --- | --- |
| Hover state stuck after a tap | Gate hover with `(hover: hover) and (pointer: fine)` | `forms-focus.md` |
| Gray or blue flash on tap | `-webkit-tap-highlight-color: transparent` on `html`, plus an `:active` state on every pressable element | below |
| Screen too tall, bottom button under the toolbar | `100dvh` for app shells, `100svh` for heroes | `scroll-viewport.md` |
| Page zooms into an input | Input text at least 16px | `forms-focus.md` |
| Tap feels laggy | `touch-action: manipulation`, feedback on `:active` or `pointerdown` | below |
| Pull-to-refresh or bounce fights the app | `overscroll-behavior-y` on `html`, `contain` on inner scrollers | `scroll-viewport.md` |
| Content stops at the notch, or hides under it | `viewport-fit=cover` plus `env(safe-area-inset-*)` on fixed elements | `scroll-viewport.md` |
| Long-press selects a button's label | `user-select: none` on controls only | below |
| Page jitters while swiping a gesture carousel | `touch-action` naming the axis the browser keeps | below |
| Status bar color doesn't match the page | One `theme-color` per color scheme | below |
| Wrong keyboard, or return key says "return" | `inputmode`, `type`, `enterkeyhint` | below |
| Text inflates in landscape | `-webkit-text-size-adjust: 100%` on `html` | below |
| Keyboard covers a bottom-pinned input on Android | `interactive-widget=resizes-content` in the viewport meta | below |
| Fine in desktop emulation, wrong on the phone | Test on hardware | below |

## Tap feedback

```css
html { -webkit-tap-highlight-color: transparent; }

button, a, [role="button"] { touch-action: manipulation; }
```

Rules:

- Removing the tap highlight removes the browser's only feedback. Every pressable element then needs its own `:active` state. Press animation values come from the `motion` skill.
- `touch-action: manipulation` turns off double-tap zoom on that element, so `click` fires without waiting for a second tap.
- A button that changes only on `click` responds when the finger lifts, which reads as lag. Style `:active`, and listen for `pointerdown` when feedback needs a script.

## `touch-action` semantics

The value names what the browser may still do.

| Element | Value | Meaning |
| --- | --- | --- |
| Horizontal carousel driven by a script gesture | `pan-y` | Browser keeps vertical scroll; the script owns horizontal |
| Vertical drag handle, such as a sheet | `pan-x` | Browser keeps horizontal; the script owns vertical |
| Surface whose gesture owns every axis, such as a slider or drawing canvas | `none` | Browser does nothing; use only where the element really handles every axis |
| Native-scroll carousel | none set | `pan-y` would block its horizontal swipe |

## Long-press selects a label

```css
button, [role="button"], .tab, .chip, .drag-handle {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
```

Rules:

- Controls only. Never `body`, never links, never content. Users copy addresses, error messages and order numbers.
- Safari still needs the `-webkit-` prefix.

## Status bar color

```html
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff"> <!-- placeholder: light header token -->
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a0a0a"> <!-- placeholder: dark header token -->
```

Rules:

- One value gives one scheme the wrong bar. Write one tag per scheme.
- Match the color at the very top of the page, usually the header background, not the brand color. Resolve it from the project's token; a meta tag cannot read `var()`.
- If the app switches theme with a class rather than the OS setting, update the tag from the script that toggles the theme.
- For an installed app, the manifest's `theme_color` and `background_color` are the same decision.

## Keyboard hints

| Field | Attributes |
| --- | --- |
| One-time code, PIN | `inputmode="numeric"`, `autocomplete="one-time-code"` |
| Amount | `inputmode="decimal"` |
| Email, phone | `type="email"`, `type="tel"` |
| Username, code | `autocapitalize="none"`, `autocorrect="off"` |
| Chat, search, last field of a form | `enterkeyhint="send"`, `"search"` or `"done"` |

## Viewport meta for a mobile-first app

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
```

```css
html { -webkit-text-size-adjust: 100%; }
```

Rules:

- `viewport-fit=cover` is needed only if fixed elements pad themselves by the safe-area insets.
- `interactive-widget=resizes-content` makes the Android keyboard shrink the layout viewport, so `100dvh` and bottom-pinned inputs stay above the keyboard. Without it, Chrome on Android since 108 behaves like `resizes-visual`: the keyboard overlays the page and `dvh` does not change.
- iOS Safari ignores the setting and always behaves like `resizes-visual`. Test the keyboard on iOS separately.
- `text-size-adjust: 100%` stops iOS from inflating text in landscape. Never set it to `none`, which also blocks the user's text zoom on some browsers.
- Never add `maximum-scale` or `user-scalable=no`.

## Never ship

| Never | Instead |
| --- | --- |
| `user-scalable=no` or `maximum-scale=1` | Inputs at 16px or more |
| Ungated `:hover` in hand-written CSS | `(hover: hover) and (pointer: fine)` |
| `100vh` on an app shell or bottom-pinned UI | `100dvh` |
| `100dvh` on a marketing hero | `100svh` |
| Press feedback on `click` only | `:active` or `pointerdown` |
| `touchmove` with `preventDefault()` to stop overscroll | `overscroll-behavior` |
| `overscroll-behavior: none` shorthand on `html` | The `-y` longhand, so swipe-back keeps working |
| `user-select: none` on `body` or links | Controls only |
| `env(safe-area-inset-*)` without `viewport-fit=cover` | Add the meta value, or the inset is `0px` |
| One `theme-color` for both schemes | One per `prefers-color-scheme` |
| User-agent sniffing for touch | `(hover)`, `(pointer)`, `(any-pointer)` queries |
| Calling it fixed from device emulation | Real hardware |

## Testing on a real phone

- Serve the dev server on `0.0.0.0` and open it on the phone by the machine's LAN address.
- Inspect with Safari's Develop menu for iOS, or `chrome://inspect` for Android.
- Test on a phone a few years old, with the keyboard open, and once in landscape.
- If the app installs to the home screen, test it installed. Standalone mode changes the viewport, safe areas and status bar.
- A simulator catches more than emulation but still misses touch feel.

## Report after a mobile fix

Apply the fixes, then report in a few lines:

- **What was wrong.** The symptom from the table and its one-line cause.
- **What changed.** File and declaration, one line each.
- **What needs a phone.** Which fixes you verified from code, and which the user must confirm on hardware. Never claim a hardware-only behavior is fixed without that check.
