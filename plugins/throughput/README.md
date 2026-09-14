# throughput

Header widget: sparkline, TPS, TTFB, active and streaming counts, and worker rows.

session-mode is optional.
This plugin never imports it.

If session-mode is loaded, the header chip calls `paint()` on `Symbol.for("omp.session-mode.v1")` and follows Alt+O.
If that symbol is missing, the chip is dim `normal` and nothing else changes.
TPS and worker rows do not read that symbol.

Restart the session after install.
