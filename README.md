# omp-extensions

Oh My Pi marketplace for two plugins: throughput and session-mode.

Add the catalog, then install each plugin:

```
/marketplace add ff-zeno/omp-extensions
/marketplace install throughput@omp-extensions
/marketplace install session-mode@omp-extensions
```

CLI equivalent:

```
omp plugin marketplace add ff-zeno/omp-extensions
omp plugin install throughput@omp-extensions
omp plugin install session-mode@omp-extensions
```

`cycle/` is a README, not a plugin.
It tells you how to merge `cycleOrder` and `modelRoles` into `~/.omp/agent/config.yml` so Ctrl+P walks flash → med → slow1 → slow2 → slow3.

session-mode never writes `SYSTEM.md` or any `SYSTEM*.md`.
Normal mode leaves your prompt alone.
Orchestrate and brute load `SYSTEM.orchestrate.md` and `SYSTEM.brute.md` from the plugin.
To override those two files, copy them into `~/.omp/agent/` and edit there.

Restart the session after install.
