# omp-extensions

Oh My Pi marketplace with three plugins.

| Plugin | What it does | Needs |
|---|---|---|
| `throughput` | TPS sparkline, TTFB, and a tree of worker rows with model, gauge, and token counts. | Stock OMP |
| `session-persona` | Alt+O or `/orch` cycles the session persona: normal, orchestrate, brute. Subagents inherit a persona from `# Mode:` headers. | Stock OMP |
| `intelligent-auto-agents` | Jev routing: picks each subagent's model slot and reasoning effort from its job and difficulty. | OMP built with the bundled core patch, a TypeSafe key |

Add the catalog, then install the plugins you want:

```
/marketplace add ff-zeno/omp-extensions
/marketplace install throughput@omp-extensions
/marketplace install session-persona@omp-extensions
/marketplace install intelligent-auto-agents@omp-extensions
```

CLI equivalent:

```
omp plugin marketplace add ff-zeno/omp-extensions
omp plugin install throughput@omp-extensions
omp plugin install session-persona@omp-extensions
omp plugin install intelligent-auto-agents@omp-extensions
```

Restart the session after installing.

`intelligent-auto-agents` disables itself on stock OMP.
Read [its README](plugins/intelligent-auto-agents/README.md) before installing it: it covers the patched build, rollback, and the `modelRoles` names to bind.

`session-persona` replaced the earlier `session-mode` plugin.
If you installed `session-mode`, uninstall it and install `session-persona`.

`cycle/` is a README, not a plugin.
It explains how to set `cycleOrder` and `modelRoles` in `~/.omp/agent/config.yml` so Ctrl+P walks flash → med → slow1 → slow2 → slow3.

## Development

```
bun test plugins/
```

CI runs the tests and gitleaks on every push and pull request.
