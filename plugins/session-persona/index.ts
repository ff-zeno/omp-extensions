// Session persona cycle (Alt+O / /orch): normal → orchestrate → brute.
// Independent of the Ctrl+P model cycle.
// Replaces the SYSTEM.md customPrompt slot. APPEND_SYSTEM.md stays.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

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

interface PendingMode {
	parentAgentId: string;
	workerName: string;
	mode: SessionMode;
	createdAt: number;
}

interface Registry {
	mode: Map<string, SessionMode>;
	pendingMode: Map<string, PendingMode[]>;
	getMode(sessionId: string): SessionMode;
	setMode(sessionId: string, mode: SessionMode): void;
	paint(sessionId: string, tick: number): string;
}

const PENDING_MODE_TTL_MS = 60_000;
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

function canDispatchOrchestrator(ctx: ExtensionContext): boolean {
	if (ctx.agent.kind !== "sub") return true;
	return getMode(sessionId(ctx)) === "orchestrate" && ctx.agent.depth < 2;
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

function requestedTaskMode(task: Record<string, unknown>): SessionMode {
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
	return "normal";
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

function cycle(ctx: ExtensionContext): void {
	const id = sessionId(ctx);
	const next = CYCLE[(CYCLE.indexOf(getMode(id)) + 1) % CYCLE.length];
	setMode(id, next);
	if (ctx.hasUI) ctx.ui.notify(MODE_NOTIFY[next], "info");
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
	pi.registerShortcut("alt+o", {
		description: "Cycle session persona: normal → orchestrate → brute",
		handler: cycle,
	});

	pi.registerCommand("orch", {
		description: "Cycle session persona: normal → orchestrate → brute (Alt+O)",
		handler: async (_args, ctx) => {
			cycle(ctx);
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "task" || !("input" in event) || !event.input || typeof event.input !== "object") return;
		const input = event.input as Record<string, unknown>;
		const parentId = ctx.agent.id;
		const canDispatch = canDispatchOrchestrator(ctx);
		const registry = getRegistry();
		const timestamp = Date.now();
		expirePendingModes(registry, timestamp);
		for (const [index, item] of taskItems(input).entries()) {
			if (!item || typeof item !== "object") continue;
			const task = item as Record<string, unknown>;
			let mode = requestedTaskMode(task);
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
				createdAt: timestamp,
			});
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const id = sessionId(ctx);
		getRegistry().mode.delete(id);
		clearPendingModes(getRegistry(), ctx.agent.id);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const subagent = ctx.agent.kind === "sub";
		const pending = subagent ? takePendingMode(ctx) : undefined;
		const mode = subagent ? pending?.mode ?? getMode(sessionId(ctx)) : getMode(sessionId(ctx));
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
