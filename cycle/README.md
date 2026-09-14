# Ctrl+P cycle

Ctrl+P is core Oh My Pi.
It is a reserved shortcut.
An extension cannot own it.

This is not a plugin.
Merge `cycleOrder` and `modelRoles` into `~/.omp/agent/config.yml`, then restart the session.

## cycleOrder

Keep this list exactly:

```yaml
cycleOrder:
  - flash
  - med
  - slow1
  - slow2
  - slow3
```

## modelRoles

Bind those five names to models you actually have.

Do not delete other `modelRoles` keys.
Merge.
Leave `default`, `task`, review roles, and anything else you already use.

Placeholder shape is `provider/model:thinking`:

```yaml
modelRoles:
  flash: your-provider/your-fast-model:low
  med: your-provider/your-daily-model:medium
  slow1: your-provider/your-strong-model:high
  slow2: your-provider/your-other-strong-model:medium
  slow3: your-provider/your-max-model:xhigh
```

Replace the placeholders.
Do not copy someone else's live pins unless those models exist on your machine.

After saving, restart the session so Ctrl+P picks up the new order.
