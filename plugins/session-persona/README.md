# session-persona

`session-persona` adds a per-session persona cycle for normal, orchestrate, and brute work.

Press Alt+O or run `/orch` to cycle normal → orchestrate → brute.

The cycle is independent of the Ctrl+P model cycle.

The plugin publishes the `Symbol.for("omp.session-persona.v1")` registry for other extensions.

## Prompt behavior

Orchestrate and brute splice their bundled persona prompt into the live system prompt between `<system-conventions>` and `</personality>`.

The prompt override order is `~/.omp/agent/SYSTEM.orchestrate.md` or `~/.omp/agent/SYSTEM.brute.md` first, followed by the matching file bundled next to this extension.

A user override can replace the bundled prompt while retaining the role sentence used to recognize an already-applied persona.

If the live prompt has no `<system-conventions>` start marker, the plugin prepends a complete persona constitution.
If a constitution start marker has no matching `</personality>` marker, the plugin notifies an error and leaves the session in normal mode.
Normal mode never reads, requires, or overwrites `SYSTEM.md`.

In normal mode the hook returns no system-prompt override, so OMP restores its base prompt after an orchestrate or brute turn.

`SYSTEM.md.example` remains as an optional normal-prompt template for users who want to create their own OMP base prompt.

## Subagent personas

Task requests propagate a persona through the `mode` field, `# Mode:` or `# Persona:` headers, `[orch]` name tags, and `agent: "orchestrator"`.

Orchestrator dispatch is clamped when the current subagent is not orchestrate or its depth is already 2 or greater.

## magicKeywords

Set `magicKeywords.orchestrate: false` in `~/.omp/agent/config.yml` so OMP's keyword notice does not duplicate this cycle.

This plugin does not write `config.yml`.

## Rename

The former `session-mode` plugin was replaced by `session-persona`, so reinstall the plugin under the `session-persona` name.
