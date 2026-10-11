# Gestures and native motion

Load this for anything a finger or pointer drags, flicks or throws, and for any React Native motion.
It extends catalog I2 and I4; the other catalog rules still apply.

## The physics

**Springs in two numbers.**
Think in damping ratio and response, not mass, stiffness and damping.
Damping ratio 1 settles with no overshoot; lower values overshoot.
Response is how fast the value reaches the target, in seconds; a spring has no fixed duration.
Motion's `bounce` and `duration` map onto them: `bounce: 0` is damping ratio 1.

| Interaction | Damping ratio | Response |
| --- | --- | --- |
| Move or reposition | 1.0 | 0.4s |
| Snap back after a drag, rotation | 0.8 | 0.4s |
| Sheet or drawer released by a drag | 0.8 | 0.3s |

The 0.8 rows are momentum cases under catalog I4.

**Start from the presentation value.**
On interrupt, read the element's live on-screen value and animate from there.
Starting from the logical target makes it jump.

**Hand off velocity.**
When the finger lifts, the spring starts at the finger's velocity, so dragging and animating join with no seam.
Most web spring APIs take px/s directly.
APIs that want relative velocity take:

```text
relativeVelocity = gestureVelocity / (target - current)
```

**Project momentum, then pick the target.**
Do not snap to the nearest point from the release position.
Project where the flick would come to rest, then snap to the target nearest that point:

```js
// decelerationRate 0.998 matches normal scrolling; 0.99 stops sooner.
function project(velocityPxPerSecond, decelerationRate = 0.998) {
  return ((velocityPxPerSecond / 1000) * decelerationRate) / (1 - decelerationRate);
}

const target = nearestSnapPoint(position + project(releaseVelocity));
```

This is exponential decay, not the textbook `v²/2a`.
A fast short flick commits; a slow long drag may not.

**Rubber-band at edges.**
Past a boundary the element follows less the further it goes; never a hard stop:

```js
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
```

**Split 2D motion.**
Run separate X and Y springs.
One spring on a 2D distance desyncs when the axes move at different speeds.

**Carry velocity through a reversal.**
Replacing one animation with another at a reversal creates a velocity cliff.
Use a spring API that re-targets from the current velocity.

## Gesture handling

- Use Pointer Events and `setPointerCapture` on pointer-down so tracking continues outside the element.
- Keep the grab offset: the element stays under the point where it was grabbed, never snaps its center to the pointer.
- Keep a short history of positions and timestamps; release velocity comes from it.
- Ignore extra pointers once a drag starts, or switching fingers makes the element jump.
- Require about 10px of movement before committing to a direction, then track 1:1 with no easing.
- Taps highlight on pointer-down, commit on pointer-up, allow about 10px of slop, and cancel when the pointer drags away.
- Recognize every plausible gesture from the first move and cancel the losers once intent is clear.
  Avoid recognizers that report only a final state; they discard the continuous tracking feedback needs.
- Only pay the double-tap delay where a double tap exists.
- Decide commit or return from the projected endpoint at release, not from distance alone.
- On dismissal, clamp the spring at the edge so it cannot overshoot and flash a gap.
- Derive dependent visuals such as a backdrop's opacity from the same tracked value, so they stay in sync.
- Write the transform on the moving element (catalog F1).

Fire haptics and sounds on the same frame as the visual cause, at most once per user action, never per frame or on scroll; catalog R3 covers when they may fire at all.

## React Native

**Tools, cheapest first.**

| Need | Tool |
| --- | --- |
| State change with no gesture: press, toggle, color | Reanimated CSS transition |
| Loop or one-shot on mount | Reanimated CSS animation |
| Mount, unmount, list reflow | Layout animations: `entering`, `exiting`, `itemLayoutAnimation` |
| Anything a finger drives, or derived from scroll | Shared value + Gesture Handler + `useAnimatedStyle` |
| Screen to screen, sheets that are their own screen, tab bars, context menus | The router's native stack, sheet and tab options |
| Pull to refresh | `RefreshControl` |

Use Reanimated, not core `Animated`, and Gesture Handler, not `PanResponder`, for anything a finger touches.
Never rebuild a screen transition in JS.
Tabs are peers, so switching tabs does not slide.

**Stay on the UI thread.**
- Never call `setState` from a gesture or scroll handler; use a shared value.
- Never schedule a JS-runtime call per frame from `onUpdate`; do it in `onEnd`, or in `useAnimatedReaction` when a value crosses a threshold.
- Never read or write a shared value during render; touch it in worklets, handlers and effects, through `.get()` and `.set()`.
- A function called from a worklet starts with the `'worklet'` directive.

**Properties.**
- A layout property may animate only on an absolutely positioned element with no children, such as a progress fill; elsewhere use transform and opacity.
- `transform` is an ordered array: put translate before scale unless the translate should scale too.
- Never animate Android `elevation` or a blur view's intensity; crossfade a static layer instead.
- Text scales with the user's setting, so never animate to a hardcoded height; measure with `onLayout` or use a transform.

**Springs.**
Reanimated's `withSpring` takes the two-number form directly:

| Use | Config |
| --- | --- |
| Default settle | `{ duration: 400, dampingRatio: 1 }` |
| Snap back after a drag | `{ duration: 400, dampingRatio: 0.8, velocity }` |
| Sheet released by a drag | `{ duration: 300, dampingRatio: 0.8, velocity }` |
| Must not cross an edge | add `overshootClamping: true` |

**A draggable sheet**, showing presentation value, hysteresis, rubber band, projection and handoff together:

```jsx
const y = useSharedValue(0);
const start = useSharedValue(0);

const pan = useMemo(() => Gesture.Pan()
  .activeOffsetY([-10, 10])
  .onStart(() => { start.set(y.get()); })
  .onUpdate((e) => {
    const next = start.get() + e.translationY;
    y.set(next >= 0 ? next : rubberband(next, HEIGHT));
  })
  .onEnd((e) => {
    if (y.get() + project(e.velocityY) > HEIGHT * 0.4) {
      y.set(withSpring(HEIGHT, { duration: 300, dampingRatio: 1, velocity: e.velocityY, overshootClamping: true },
        (done) => { if (done) scheduleOnRN(onClose); }));
    } else {
      y.set(withSpring(0, { duration: 300, dampingRatio: 0.8, velocity: e.velocityY }));
    }
  }), [onClose]);
```

`project` and `rubberband` are the functions above with `'worklet'` as their first line.
`activeOffsetY` is the 10px hysteresis and also declares the axis, so the pan does not steal scrolls from a parent list.

**Press targets.**
At least 44×44pt on iOS and 48dp on Android; extend with `hitSlop` rather than growing the visual.
Set `pressRetentionOffset` so a drifting finger does not cancel an intended press.

**Reduced motion.**
Read `useReducedMotion()` or pass `reduceMotion: ReduceMotion.System` per animation.
Screen transitions become fades.

**Verify on device.**
Judge feel only on a release build on the slowest supported device; a dev build or a preview app hides jank.
Gestures do nothing, with no error, unless `GestureHandlerRootView` wraps the app.
On high-refresh iPhones, third-party animation caps at 60fps unless `CADisableMinimumFrameDurationOnPhone` is set in the app's Info.plist.
