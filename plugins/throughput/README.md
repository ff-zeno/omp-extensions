# throughput

`throughput` adds an above-editor widget with a header sparkline, TPS, TTFB, active and streaming counts, aggregate tokens, and worker tree rows.

The worker tree preserves parent-child branches, orders active workers before completed workers, and shows at most eight rows before an overflow count.

Each worker row includes a status icon, worker name, persona chip, agent, model and thinking level, gauge, TPS, and token total.

The name, agent, and model columns resize with the terminal and truncate styled output without exceeding the available width.

Agent names containing the `-frontier-` infix are compacted to `-` so reviewer seat numbers remain visible in the agent column.

The persona chip reads `getMode` or `mode` and the header chip reads `paint` from `Symbol.for("omp.session-persona.v1")` when the session-persona plugin is loaded.

Without that registry, the widget uses the session's queued persona where available and a dim `normal` chip otherwise.

TPS uses streamed character estimates reconciled with billed output usage when available.

OMP 18.2.4 and later expose a native `composer.tokenRate` readout, but this widget combines single-session throughput with multi-worker state, sparkline, TTFB, and per-worker gauges.

Disable the native meter to avoid duplicate readouts:

```yaml
composer:
  shape: claude
  tokenRate: false
```

Restart the session after installation.
