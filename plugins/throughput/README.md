# throughput

Header widget: sparkline, TPS, TTFB, active and streaming counts, and worker rows.

session-mode is optional.
This plugin never imports it.

If session-mode is loaded, the header chip calls `paint()` on `Symbol.for("omp.session-mode.v1")` and follows Alt+O.
If that symbol is missing, the chip is dim `normal` and nothing else changes.
TPS and worker rows do not read that symbol.
OMP 18.2.4+ added a native `composer.tokenRate` working-row readout.
This panel supersedes it: single-session tok/s plus multi-worker aggregate,
sparkline, TTFB, and per-worker gauges in one place.
Keep native off to avoid duplicate readouts:

```
composer:
  shape: claude
  tokenRate: false
```

The native meter is not exposed to extensions,
so the panel keeps its own estimate (chars/3.5 reconciled with billed usage).

Restart the session after install.
