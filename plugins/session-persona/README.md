# session-persona

`session-persona` adds a per-session persona cycle for normal, orchestrate, and brute work.

Run `/persona` or press Ctrl+Alt+P to cycle normal → orchestrate → brute.

The cycle is independent of the Ctrl+P model cycle.

The plugin publishes the `Symbol.for("omp.session-persona.v1")` registry for other extensions.

## Requirements

Requires OMP 18.4.9 or newer.
Tested on 18.6.1.
No patched build is needed; the plugin uses only the stock extension API.

## Install

Install from the marketplace:
```
/marketplace add ff-zeno/omp-extensions
/marketplace install session-persona@omp-extensions
```

The same from a shell:
```
omp plugin marketplace add ff-zeno/omp-extensions
omp plugin install session-persona@omp-extensions
```

Manual install from a clone:
```
git clone https://github.com/ff-zeno/omp-extensions
omp plugin link ./omp-extensions/plugins/session-persona
```

`omp plugin link` resolves the path against the current directory, so run it from the directory that contains the clone.
It symlinks the plugin directory into OMP's plugins directory; your edits take effect on restart.

A plain symlink works the same way, because OMP scans `~/.omp/agent/extensions/` and follows symlinked directories:
```
ln -s "$PWD/omp-extensions/plugins/session-persona" ~/.omp/agent/extensions/session-persona
```
On Windows, create a directory junction instead of a symlink.

Restart OMP after installing.

## Configure

The plugin works without configuration.
The only setting is the hotkey; see [Change the hotkey](#change-the-hotkey).

Optional: OMP's own `orchestrate` magic keyword adds a notice that overlaps this cycle.
Disable that notice and leave the other keywords enabled:
```
omp config set magicKeywords.orchestrate false
```
Equivalent entry in `~/.omp/agent/config.yml`:
```yaml
magicKeywords:
  orchestrate: false
```
`omp config path` prints the config directory.
This plugin never writes `config.yml` or `keybindings.yml`.

## Usage

| Command | Effect |
|---|---|
| `/persona` | Cycle normal → orchestrate → brute → normal. |
| `/persona <name>` | Set the persona to `normal`, `orchestrate`, or `brute`. Tab completes the name. |
| `/normal` | Set the persona to normal. |
| `/orchestrate` | Set the persona to orchestrate. |
| `/brute` | Set the persona to brute. |
| Ctrl+Alt+P | Same as `/persona` with no name. |

An unknown name such as `/persona fast` lists the valid names and leaves the persona unchanged.
The cycle is independent of the Ctrl+P model cycle.

## Change the hotkey

The hotkey lives in OMP's own keybindings file, `~/.omp/agent/keybindings.yml`, under the id `sessionPersona.cycle`.
Create the file if it does not exist.
OMP ignores ids it does not know and keeps them when it rewrites the file, so this entry does not disturb OMP's built-in bindings.

Use one chord:
```yaml
sessionPersona.cycle: alt+shift+k
```

Use several chords:
```yaml
sessionPersona.cycle: [ctrl+alt+p, f8]
```

Turn the hotkey off:
```yaml
sessionPersona.cycle: []
```

Delete the entry to go back to Ctrl+Alt+P.
Restart OMP after changing it, because OMP binds extension hotkeys once at startup.

A chord is modifiers joined with `+` and then a key, for example `ctrl+alt+p` or `alt+shift+k`.
The modifiers are `ctrl`, `shift`, `alt`, and `super`.
The key is a letter, digit, symbol, or a named key such as `f1` to `f12`, `up`, `pageup`, `tab`, or `space`.
A chord needs `ctrl`, `alt`, or `super`, unless the key is a function key, so the hotkey never swallows normal typing.
OMP reserves some chords for itself, such as `ctrl+p`, `ctrl+o`, and `alt+m`, and drops extension hotkeys on them.
The plugin skips an invalid or reserved chord, binds the rest, and shows a warning when the session starts.
Pick a chord that no OMP binding uses; `/hotkeys` lists OMP's own bindings.

If you set `PI_CODING_AGENT_DIR`, the file is `keybindings.yml` in that directory.
With a named OMP profile, the plugin reads the profile's `keybindings.yml` on top of the default one, the same way OMP does.

## Terminal caveats

On macOS, Alt is the Option key.
Terminal.app and iTerm2 send Option as a character, not as Alt, unless you turn on "Use Option as Meta key" (Terminal.app) or set the Option key to "Esc+" (iTerm2).
Without that setting, Ctrl+Alt+P and other Alt chords do not reach OMP.

Terminals and editors can capture a chord before OMP sees it.
VS Code and Cursor terminals send many Ctrl and Alt chords to the editor first; set `terminal.integrated.sendKeybindingsToShell` to `true` or pick another chord.
tmux, screen, and window managers can also grab chords.

`/persona` always works, whatever the terminal does with the hotkey.

## Verify

Press Ctrl+Alt+P or run `/persona` and confirm the "Persona: ..." notification and the status-line mode.
Type `/persona` and confirm its description in the command list names the chord you chose, or says nothing about a hotkey when you turned it off.
Run `/extensions` and confirm `session-persona` is listed.
From a shell, `omp plugin list` lists it and `omp plugin doctor` reports load errors.

## Update

Marketplace install:
```
/marketplace update
/marketplace upgrade session-persona@omp-extensions
```
Or: `omp plugin upgrade session-persona@omp-extensions`.
Linked or symlinked install: pull your clone with `git pull`, then restart OMP.

## Uninstall

Marketplace install: `/marketplace uninstall session-persona@omp-extensions`, or `omp plugin uninstall session-persona@omp-extensions`.
Linked install: `omp plugin uninstall session-persona`.
Symlinked install: remove the symlink from `~/.omp/agent/extensions/session-persona`.

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

The bundled orchestrate prompt is agent-agnostic: it tells the model to choose the job from the agents the session actually lists, and it names only stock agents (`task`, `scout`, `sonic`, `reviewer`, `security-reviewer`).
It names specialised planning, git, design, and review agents generically, so they are used only when the session offers them.
When a subagent-routing extension such as the companion `intelligent-auto-agents` plugin is installed, a generic `task` spawn with no explicit model or effort lets that extension choose the model and reasoning level.

