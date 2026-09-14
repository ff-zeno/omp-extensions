# session-mode

Alt+O or `/orch` cycles normal → orchestrate → brute.

Independent of Ctrl+P.

This plugin never writes `SYSTEM.md` or any `SYSTEM*.md`.

## normal

No-op.
Does not read `SYSTEM.md`.
Does not splice the live prompt.

## orchestrate / brute

Loads `SYSTEM.orchestrate.md` or `SYSTEM.brute.md`.

Search order:

1. `~/.omp/agent/<file>` if that file is present (your override)
2. the copy bundled next to this extension

If `<system-conventions>` or `</personality>` is missing from the live system prompt, the plugin notifies, stays put, and does not wrap your file.

## Override

Copy the bundled `SYSTEM.orchestrate.md` and `SYSTEM.brute.md` into `~/.omp/agent/` and edit those copies.

`SYSTEM.md.example` is a short fence template if you want a custom normal prompt.
session-mode will not install or overwrite `SYSTEM.md`.

## magicKeywords

Set `magicKeywords.orchestrate: false` in `~/.omp/agent/config.yml` so OMP's keyword notice does not double up with this cycle.
This plugin does not write `config.yml`.
