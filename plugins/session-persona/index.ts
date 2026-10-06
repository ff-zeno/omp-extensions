// Session persona: /persona, /normal, /orchestrate, /brute, and a cycle hotkey
// (default Alt+O) for normal → orchestrate → brute.
// Independent of the Ctrl+P model cycle.
// Replaces the SYSTEM.md customPrompt slot. APPEND_SYSTEM.md stays.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSONC, YAML } from "bun";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem, KeyId } from "@oh-my-pi/pi-tui";

type SessionMode = "normal" | "orchestrate" | "brute";

const REGISTRY_KEY = Symbol.for("omp.session-persona.v1");
const CYCLE: SessionMode[] = ["normal", "orchestrate", "brute"];
const ORCHESTRATE_PALETTE = [43, 44, 45, 80, 81, 147, 141, 135, 99, 98];
const BRUTE_PALETTE = [196, 202, 208, 214, 166, 160, 203, 209, 215, 172];
const MODE_LABEL: Record<SessionMode, string> = {
	normal: "🔘 normal",
	orchestrate: "🧠 orchestrate",
	brute: "🚀 brute",
};
const MODE_PALETTE: Record<SessionMode, number[] | null> = {
	normal: null,
	orchestrate: ORCHESTRATE_PALETTE,
	brute: BRUTE_PALETTE,
};
const MODE_NOTIFY: Record<SessionMode, string> = {
	normal: "Persona: 🔘 Normal",
	orchestrate: "Persona: 🧠 Orchestrate",
	brute: "Persona: 🚀 Brute",
};
const MODE_FILES: Record<Exclude<SessionMode, "normal">, string> = {
	orchestrate: "SYSTEM.orchestrate.md",
	brute: "SYSTEM.brute.md",
};
const CONSTITUTION_START = "<system-conventions>";
const CONSTITUTION_END = "</personality>";
const MODE_FINGERPRINT: Record<Exclude<SessionMode, "normal">, string> = {
	orchestrate: "Dispatcher for this Oh My Pi session. Specialists do the work. You do not.",
	brute: "Execute the user's asked action in this Oh My Pi session.",
};

// Read from OMP's own keybindings file; OMP's loader keeps unknown ids and skips them.
const CYCLE_KEYBINDING = "sessionPersona.cycle";
const DEFAULT_CYCLE_KEYS = ["alt+o"];
// Same lookup order as OMP's keybindings loader: the first file that exists wins.
const KEYBINDING_FILES = ["keybindings.yml", "keybindings.yaml", "keybindings.json"];
const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"];
const KEY_ALIASES: Record<string, string> = { esc: "escape", return: "enter" };
const NAMED_KEYS: Record<string, true> = {
	escape: true,
	enter: true,
	tab: true,
	space: true,
	backspace: true,
	delete: true,
	insert: true,
	clear: true,
	home: true,
	end: true,
	pageup: true,
	pagedown: true,
	up: true,
	down: true,
	left: true,
	right: true,
	f1: true,
	f2: true,
	f3: true,
	f4: true,
	f5: true,
	f6: true,
	f7: true,
	f8: true,
	f9: true,
	f10: true,
	f11: true,
	f12: true,
};
const SYMBOL_KEYS = "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?";
// OMP's ExtensionRunner silently drops extension shortcuts on these chords.
const RESERVED_KEYS: Record<string, true> = {
	"ctrl+c": true,
	"ctrl+d": true,
	"ctrl+z": true,
	"ctrl+k": true,
	"ctrl+p": true,
	"ctrl+l": true,
	"ctrl+o": true,
	"ctrl+t": true,
	"ctrl+g": true,
	"alt+m": true,
	"ctrl+q": true,
	"shift+tab": true,
	"ctrl+shift+p": true,
	"alt+enter": true,
	escape: true,
	enter: true,
};

interface PendingMode {
	parentAgentId: string;
	workerName: string;
	mode: SessionMode;
	/** The parent named this persona; a router suggestion never overrides it. */
	explicit: boolean;
	createdAt: number;
}

/**
 * A persona a subagent router (intelligent-auto-agents) suggested for one child, keyed
 * `<parent agent id>:<child agent id>`. Applied only when the parent named no persona.
 */
interface PersonaSuggestion {
	persona: unknown;
	createdAt: number;
}
const PERSONA_SUGGESTIONS = Symbol.for("omp.persona-suggestions.v1");

interface Registry {
	mode: Map<string, SessionMode>;
	pendingMode: Map<string, PendingMode[]>;
	getMode(sessionId: string): SessionMode;
	setMode(sessionId: string, mode: SessionMode): void;
	paint(sessionId: string, tick: number): string;
}

const PENDING_MODE_TTL_MS = 60_000;

function personaSuggestions(): Map<string, PersonaSuggestion> | undefined {
	const store = globalThis as typeof globalThis & { [PERSONA_SUGGESTIONS]?: Map<string, PersonaSuggestion> };
	return store[PERSONA_SUGGESTIONS];
}

/** Claim this child's suggestion. Routers may only suggest normal or brute; orchestrate stays the parent's call. */
function takePersonaSuggestion(ctx: ExtensionContext): SessionMode | undefined {
	const parentId = ctx.agent.parentId;
	const suggestions = personaSuggestions();
	if (parentId === undefined || !suggestions) return undefined;
	const key = `${parentId}:${ctx.agent.id}`;
	const entry = suggestions.get(key);
	if (!entry) return undefined;
	suggestions.delete(key);
	if (Date.now() - entry.createdAt > PENDING_MODE_TTL_MS) return undefined;
	return entry.persona === "normal" || entry.persona === "brute" ? entry.persona : undefined;
}

function clearPersonaSuggestions(parentId: string): void {
	const suggestions = personaSuggestions();
	if (!suggestions) return;
	const prefix = `${parentId}:`;
	for (const key of suggestions.keys()) {
		if (key.startsWith(prefix)) suggestions.delete(key);
	}
}

const MODE_HEADER = /(?:^|\n)\s*#?\s*(?:mode|persona):\s*(normal|orchestrate|brute)\b/i;

function getRegistry(): Registry {
	const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
	const registry = g[REGISTRY_KEY] ??= {
		mode: new Map(),
		pendingMode: new Map(),
		getMode,
		setMode,
		paint,
	};
	registry.mode ??= new Map();
	registry.pendingMode ??= new Map();
	for (const queued of registry.pendingMode.values()) {
		if (!Array.isArray(queued)) {
			registry.pendingMode.clear();
			break;
		}
	}
	registry.getMode = getMode;
	registry.setMode = setMode;
	registry.paint = paint;
	return registry;
}

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function pendingModeKey(parentAgentId: string, workerName: string): string {
	return `${parentAgentId}:${workerName}`;
}

function getMode(id: string): SessionMode {
	return getRegistry().mode.get(id) ?? "normal";
}

function paintWord(word: string, palette: number[] | null, tick: number): string {
	if (!palette) return `\x1b[38;5;245m${word}\x1b[0m`;
	return [...word]
		.map((ch, i) => {
			const color = palette[(i + tick) % palette.length];
			return `\x1b[38;5;${color}m${ch}\x1b[0m`;
		})
		.join("");
}

function paint(id: string, tick: number): string {
	const mode = getMode(id);
	return paintWord(MODE_LABEL[mode], MODE_PALETTE[mode], tick);
}

function setMode(id: string, mode: SessionMode): void {
	getRegistry().mode.set(id, mode);
}

function expirePendingModes(registry: Registry, timestamp = Date.now()): void {
	for (const [key, queued] of registry.pendingMode) {
		const retained = queued.filter((entry) => timestamp - entry.createdAt <= PENDING_MODE_TTL_MS);
		if (retained.length === 0) registry.pendingMode.delete(key);
		else if (retained.length !== queued.length) registry.pendingMode.set(key, retained);
	}
}

function clearPendingModes(registry: Registry, parentId: string): void {
	for (const [key, queued] of registry.pendingMode) {
		const retained = queued.filter((entry) => entry.parentAgentId !== parentId);
		if (retained.length !== queued.length) {
			if (retained.length === 0) registry.pendingMode.delete(key);
			else registry.pendingMode.set(key, retained);
		}
	}
}


function sessionWorkerName(ctx: ExtensionContext): string | undefined {
	const raw = ctx.sessionManager.getSessionName();
	if (raw && raw.length > 0) return raw;
	const file = ctx.sessionManager.getSessionFile();
	if (!file) return undefined;
	const base = basename(file, extname(file));
	return base && base !== "main" ? base : undefined;
}

function takePendingMode(ctx: ExtensionContext): PendingMode | undefined {
	const workerName = sessionWorkerName(ctx);
	if (!workerName) return undefined;
	const registry = getRegistry();
	expirePendingModes(registry);
	const parentAgentId = ctx.agent.parentId;
	const separator = workerName.indexOf(".");
	const shortName = separator < 0 ? workerName : workerName.slice(separator + 1);
	const workerNames = new Set([workerName, shortName]);
	const matching: { key: string; entry: PendingMode }[] = [];
	for (const [key, queued] of registry.pendingMode) {
		const entry = queued.find((candidate) => workerNames.has(candidate.workerName));
		if (entry) matching.push({ key, entry });
	}
	const candidates = parentAgentId !== undefined
		? matching.filter(({ entry }) => entry.parentAgentId === parentAgentId)
		: matching;
	const parentIds = new Set(candidates.map(({ entry }) => entry.parentAgentId));
	if (parentIds.size !== 1) return undefined;
	const matched = candidates[0];
	if (!matched) return undefined;
	const queue = registry.pendingMode.get(matched.key);
	if (!queue) return undefined;
	queue.shift();
	if (queue.length === 0) registry.pendingMode.delete(matched.key);
	return matched.entry;
}

/** The persona the parent named for this task, or undefined when it named none. */
function explicitTaskMode(task: Record<string, unknown>): SessionMode | undefined {
	const explicit = task.mode;
	if (explicit === "normal" || explicit === "orchestrate" || explicit === "brute") return explicit;
	for (const value of [task.task, task.context]) {
		if (typeof value !== "string") continue;
		const match = value.match(MODE_HEADER);
		if (match) return match[1].toLowerCase() as SessionMode;
	}
	if (typeof task.name === "string") {
		const tag = task.name.match(/\[(orch|orchestrate|brute|normal)\]/i)?.[1]?.toLowerCase();
		if (tag === "orch" || tag === "orchestrate") return "orchestrate";
		if (tag === "brute" || tag === "normal") return tag;
	}
	if (task.agent === "orchestrator") return "orchestrate";
	return undefined;
}

function taskItems(input: Record<string, unknown>): unknown[] {
	return Array.isArray(input.tasks) ? input.tasks : [input];
}

function stableTaskName(task: Record<string, unknown>, toolCallId: string, index: number): string {
	if (typeof task.name === "string" && task.name.length > 0) return task.name;
	const name = `task-${toolCallId.slice(-8)}-${index + 1}`;
	task.name = name;
	return name;
}

function queuePendingMode(
	registry: Registry,
	entry: PendingMode,
): void {
	const key = pendingModeKey(entry.parentAgentId, entry.workerName);
	const queued = registry.pendingMode.get(key);
	if (queued) queued.push(entry);
	else registry.pendingMode.set(key, [entry]);
}

function applyMode(ctx: ExtensionContext, mode: SessionMode): void {
	setMode(sessionId(ctx), mode);
	if (ctx.hasUI) ctx.ui.notify(MODE_NOTIFY[mode], "info");
}

function cycle(ctx: ExtensionContext): void {
	applyMode(ctx, CYCLE[(CYCLE.indexOf(getMode(sessionId(ctx))) + 1) % CYCLE.length]);
}

function isSessionMode(value: string): value is SessionMode {
	return (CYCLE as string[]).includes(value);
}

function personaCompletions(prefix: string): AutocompleteItem[] | null {
	const typed = prefix.trim().toLowerCase();
	const items = CYCLE.filter((mode) => mode.startsWith(typed)).map((mode) => ({
		value: mode,
		label: mode,
		description: MODE_NOTIFY[mode],
	}));
	return items.length > 0 ? items : null;
}

type ChordResult = { key: string } | { error: string };

// Mirrors OMP's canonical key ids: lowercase, modifiers ordered ctrl, shift, alt, super.
function parseChord(raw: string): ChordResult {
	const chord = raw.replace(/\s+/g, "").toLowerCase();
	const parts = chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+");
	const last = parts.pop() ?? "";
	const base = KEY_ALIASES[last] ?? last;
	const validBase = base.length === 1 ? /[a-z0-9]/.test(base) || SYMBOL_KEYS.includes(base) : NAMED_KEYS[base] === true;
	if (!validBase || parts.some((part) => !MODIFIER_ORDER.includes(part)) || new Set(parts).size !== parts.length) {
		return { error: "not a key chord OMP understands, such as ctrl+alt+p" };
	}
	if (!/^f\d+$/.test(base) && !parts.some((part) => part !== "shift")) {
		return { error: "needs ctrl, alt, or super, or it would capture normal typing" };
	}
	parts.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
	const key = [...parts, base].join("+");
	if (RESERVED_KEYS[key]) return { error: "reserved by OMP, which ignores extension shortcuts on it" };
	return { key };
}

function formatChord(key: string): string {
	return key
		.split(/\+(?!$)/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("+");
}

// Mirrors OMP's agent-dir resolution: a named profile reads its own agent dir and
// inherits the default profile's file beneath it; otherwise PI_CODING_AGENT_DIR wins.
function keybindingDirs(): string[] {
	const root = join(homedir(), process.env.PI_CONFIG_DIR || ".omp");
	const defaultDir = join(root, "agent");
	const profile = (process.env.OMP_PROFILE || process.env.PI_PROFILE)?.trim();
	if (profile && profile !== "default") return [defaultDir, join(root, "profiles", profile, "agent")];
	const override = process.env.PI_CODING_AGENT_DIR;
	return [override ? resolve(override) : defaultDir];
}

interface CycleKeys {
	keys: string[];
	notices: string[];
}

function loadCycleKeys(): CycleKeys {
	const notices: string[] = [];
	let entry: unknown;
	let source: string | undefined;
	for (const dir of keybindingDirs()) {
		const path = KEYBINDING_FILES.map((name) => join(dir, name)).find((candidate) => existsSync(candidate));
		if (!path) continue;
		let config: unknown;
		try {
			const text = readFileSync(path, "utf8");
			config = path.endsWith(".json") ? JSONC.parse(text) : YAML.parse(text);
		} catch (err) {
			notices.push(`session-persona: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (!config || typeof config !== "object") continue;
		const value = (config as Record<string, unknown>)[CYCLE_KEYBINDING];
		if (value === undefined || value === null) continue;
		entry = value;
		source = path;
	}
	if (source === undefined) return { keys: DEFAULT_CYCLE_KEYS, notices };
	const list = typeof entry === "string" ? [entry] : Array.isArray(entry) ? entry : undefined;
	if (!list) {
		notices.push(
			`session-persona: ${CYCLE_KEYBINDING} in ${source} must be a chord or a list of chords; using ${formatChord(DEFAULT_CYCLE_KEYS[0])}.`,
		);
		return { keys: DEFAULT_CYCLE_KEYS, notices };
	}
	const keys: string[] = [];
	for (const item of list) {
		const result: ChordResult = typeof item === "string" ? parseChord(item) : { error: "not a string" };
		if ("error" in result) {
			notices.push(`session-persona: ignoring ${JSON.stringify(item)} for ${CYCLE_KEYBINDING} in ${source}: ${result.error}.`);
		} else if (!keys.includes(result.key)) {
			keys.push(result.key);
		}
	}
	if (list.length > 0 && keys.length === 0) {
		notices.push("session-persona: no valid persona hotkey is bound; /persona still works.");
	}
	return { keys, notices };
}


function readModeBody(mode: Exclude<SessionMode, "normal">): string {
	const name = MODE_FILES[mode];
	const here = dirname(fileURLToPath(import.meta.url));
	const paths = [
		join(homedir(), ".omp", "agent", name),
		join(here, name),
	];
	for (const p of paths) {
		try {
			return readFileSync(p, "utf8").replaceAll("\r\n", "\n").trimEnd();
		} catch {
			continue;
		}
	}
	throw new Error(`session-persona: missing ${name}`);
}

function constitutionHasFingerprint(systemPrompt: string[], mode: Exclude<SessionMode, "normal">): boolean {
	const block = systemPrompt.find((entry) => entry.includes(CONSTITUTION_START));
	if (!block) return false;
	const bodyStart = block.indexOf(CONSTITUTION_START) + CONSTITUTION_START.length;
	const end = block.indexOf(CONSTITUTION_END, bodyStart);
	return end >= 0 && block.slice(bodyStart, end).includes(MODE_FINGERPRINT[mode]);
}

function replaceConstitution(systemPrompt: string[], next: string): string[] | undefined {
	const index = systemPrompt.findIndex((entry) => entry.includes(CONSTITUTION_START));
	if (index < 0) return undefined;
	const block = systemPrompt[index];
	const start = block.indexOf(CONSTITUTION_START);
	const end = block.indexOf(CONSTITUTION_END, start + CONSTITUTION_START.length);
	if (end < 0) return undefined;
	const replacement = block.slice(0, start) + next + block.slice(end + CONSTITUTION_END.length);
	const result = systemPrompt.slice();
	result[index] = replacement;
	return result;
}

function spliceMode(systemPrompt: string[], target: Exclude<SessionMode, "normal">): string[] | undefined {
	const next = readModeBody(target);
	if (constitutionHasFingerprint(systemPrompt, target)) return systemPrompt;
	if (!systemPrompt.some((entry) => entry.includes(CONSTITUTION_START))) {
		return [`${CONSTITUTION_START}\n${next}\n${CONSTITUTION_END}`, ...systemPrompt];
	}
	const spliced = replaceConstitution(systemPrompt, next);
	if (spliced && constitutionHasFingerprint(spliced, target)) return spliced;
	throw new Error("session-persona: constitution markers not found in systemPrompt");
}

export default function sessionPersona(pi: ExtensionAPI): void {
	getRegistry();
	const { keys, notices } = loadCycleKeys();
	for (const key of keys) {
		pi.registerShortcut(key as KeyId, {
			description: `Cycle session persona: normal → orchestrate → brute (${formatChord(key)})`,
			handler: cycle,
		});
	}
	const hotkeys = keys.length > 0 ? ` (${keys.map(formatChord).join(", ")})` : "";

	pi.registerCommand("persona", {
		description: `Cycle the session persona, or set one: /persona [normal|orchestrate|brute]${hotkeys}`,
		getArgumentCompletions: personaCompletions,
		handler: async (args, ctx) => {
			const name = args.trim().toLowerCase();
			if (name === "") cycle(ctx);
			else if (isSessionMode(name)) applyMode(ctx, name);
			else if (ctx.hasUI) {
				ctx.ui.notify(`Unknown persona "${args.trim()}". Valid personas: ${CYCLE.join(", ")}.`, "warning");
			}
		},
	});
	for (const mode of CYCLE) {
		pi.registerCommand(mode, {
			description: `Set the session persona to ${mode}`,
			handler: async (_args, ctx) => {
				applyMode(ctx, mode);
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		for (const notice of notices.splice(0)) ctx.ui.notify(notice, "warning");
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "task" || !("input" in event) || !event.input || typeof event.input !== "object") return;
		const input = event.input as Record<string, unknown>;
		const parentId = ctx.agent.id;
		// Only the top-level session may spawn an orchestrator; orchestrators never nest.
		const canDispatch = ctx.agent.kind !== "sub";
		const registry = getRegistry();
		const timestamp = Date.now();
		expirePendingModes(registry, timestamp);
		for (const [index, item] of taskItems(input).entries()) {
			if (!item || typeof item !== "object") continue;
			const task = item as Record<string, unknown>;
			const explicit = explicitTaskMode(task);
			let mode = explicit ?? "normal";
			const requestsOrchestrator = mode === "orchestrate" || task.agent === "orchestrator";
			if (requestsOrchestrator && !canDispatch) {
				mode = "normal";
				task.agent = "task";
				task.mode = "normal";
				for (const field of ["task", "context"] as const) {
					if (typeof task[field] === "string") {
						task[field] = task[field].replace(MODE_HEADER, "# Mode: normal");
					}
				}
			}
			const workerName = stableTaskName(task, event.toolCallId, index);
			queuePendingMode(registry, {
				parentAgentId: parentId,
				workerName,
				mode,
				explicit: explicit !== undefined,
				createdAt: timestamp,
			});
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const id = sessionId(ctx);
		getRegistry().mode.delete(id);
		clearPendingModes(getRegistry(), ctx.agent.id);
		clearPersonaSuggestions(ctx.agent.id);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const subagent = ctx.agent.kind === "sub";
		const pending = subagent ? takePendingMode(ctx) : undefined;
		const suggested = subagent ? takePersonaSuggestion(ctx) : undefined;
		const mode = !subagent
			? getMode(sessionId(ctx))
			: pending?.explicit
				? pending.mode
				: suggested ?? pending?.mode ?? getMode(sessionId(ctx));
		if (mode === "normal") {
			setMode(sessionId(ctx), "normal");
			return;
		}
		const systemPrompt = event.systemPrompt ?? ctx.getSystemPrompt();
		try {
			const next = spliceMode(systemPrompt, mode);
			if (next === undefined) {
				setMode(sessionId(ctx), "normal");
				return;
			}
			setMode(sessionId(ctx), mode);
			return { systemPrompt: next };
		} catch (err) {
			setMode(sessionId(ctx), "normal");
			const message = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			console.error(message);
		}
	});
}
