# throughput

`throughput` adds an above-editor widget with a header sparkline, TPS, TTFB, active and streaming counts, aggregate tokens, and worker tree rows.

The worker tree preserves parent-child branches, orders active workers before completed workers, and shows at most eight rows before an overflow count.

Each worker row includes a status icon, worker name, persona chip, agent, model and thinking level, gauge, TPS, and token total.

The name, agent, and model columns resize with the terminal and truncate styled output without exceeding the available width.

Agent names containing the `-frontier-` infix are compacted to `-` so reviewer seat numbers remain visible in the agent column.

The persona chip reads `getMode` or `mode` and the header chip reads `paint` from `Symbol.for("omp.session-persona.v1")` when the session-persona plugin is loaded.

Without that registry, the widget uses the session's queued persona where available and a dim `normal` chip otherwise.

TPS uses streamed character estimates reconciled with billed output usage when available.

OMP exposes a native `composer.tokenRate` readout, but this widget combines single-session throughput with multi-worker state, sparkline, TTFB, and per-worker gauges.

The panel only appears in the interactive TUI.

## Requirements

Requires OMP 18.4.9 or newer.
Tested on 18.6.1.

## Install

git is required for marketplace add and for a local clone.

bun is not required to install or run this plugin.

`session-persona` is optional.

### Marketplace

```
/marketplace add ff-zeno/omp-extensions
/marketplace install throughput@omp-extensions
```

```
omp plugin marketplace add ff-zeno/omp-extensions
omp plugin install throughput@omp-extensions
```

Restart the session after install.

`/reload-plugins` does not load extension modules.

### Local

Clone, then link the plugin directory:

```
git clone https://github.com/ff-zeno/omp-extensions.git
cd omp-extensions
omp plugin link ./plugins/throughput
```

`omp plugin install ./plugins/throughput` is the same as `plugin link`.

Or symlink into the native extensions directory (Linux, macOS, WSL):

```
mkdir -p ~/.omp/agent/extensions
ln -s /absolute/path/to/omp-extensions/plugins/throughput ~/.omp/agent/extensions/throughput
```

On WSL, `~` is the Linux home, not the Windows one.

Restart the session.

### Config

No required keys.

`composer.tokenRate` defaults to false.

If you turned the native meter on, turn it off so it does not duplicate this panel:

```yaml
# ~/.omp/agent/config.yml
composer:
  tokenRate: false
```

### Verify

Restart omp.

The header `Throughput` should appear above the editor.

Marketplace and link installs also show in `omp plugin list` and `/plugins list`.

A native extensions-directory symlink does not appear in `omp plugin list`; the widget is the check.

`omp plugin doctor` reports health for linked and marketplace installs.

### Update

Marketplace:

```
omp plugin marketplace update omp-extensions
omp plugin upgrade throughput@omp-extensions
```

```
/marketplace upgrade throughput@omp-extensions
```

Then restart the session.

`/marketplace update` refreshes catalogs only; it does not reinstall the plugin.

Linked or symlinked installs pick up source edits after a restart.

Pull the git repo first if you cloned it.

### Uninstall

Marketplace:

```
/marketplace uninstall throughput@omp-extensions
```

```
omp plugin uninstall throughput@omp-extensions
```

Linked:

```
omp plugin uninstall throughput
```

Extensions-directory symlink:

```
rm ~/.omp/agent/extensions/throughput
```

Restart the session after uninstall.
