import { basename, extname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];
type SessionRole = "main" | "worker";
type SessionPhase = "waiting" | "streaming" | "tool" | "complete";

interface StreamCall {
	tps: number;
	ttfbMs: number;
	generateMs: number;
	tokens: number;
}

export interface SessionThroughput {
	readonly sessionId: string;
	readonly agentId: string;
	role: SessionRole;
	readonly order: number;
	label: string;
	model: string;
	thinkingLevel: string;
	agentParentId?: string;
	parentId?: string;
	parentResolved: boolean;
	children: string[];
	depth: number;
	agent: string;
	mode?: string;
	phase: SessionPhase;
	toolName?: string;
	messageStartedAt: number;
	requestStartedAt: number;
	firstTokenAt: number;
	lastTokenAt: number;
	lastActivityAt: number;
	lastSampleAt: number;
	toolStartedAt: number;
	messageChars: number;
	messageTokens: number;
	totalTokens: number;
	avgTps: number;
	lastTtfbMs: number;
	callHistory: StreamCall[];
	tickHistory: number[];
	updatedAt: number;
	completedAt?: number;
	messageOpen: boolean;
}

export interface PendingSpawn {
	parentSessionId: string;
	workerName: string;
	mode?: string;
	createdAt: number;
}

export interface ThroughputRegistry {
	readonly version: 4;
	nextOrder: number;
	mainSessionId?: string;
	readonly sessions: Map<string, SessionThroughput>;
	readonly sessionByAgentId: Map<string, string>;
	readonly pendingSpawns: Map<string, PendingSpawn[]>;
}

export interface ThroughputTreeRow {
	session: SessionThroughput;
	prefix: string;
}

const REGISTRY_KEY = Symbol.for("omp.throughput.registry.v4");
const SESSION_PERSONA_KEY = Symbol.for("omp.session-persona.v1");
// OMP's native task/tool spinners advance one frame per this interval
// (packages/tui/src/components/loader.ts, SPINNER_ADVANCE_MS). The widget
// repaints at the same cadence so both spinners advance in lockstep.
export const SPINNER_ADVANCE_MS = 80;
const UI_INTERVAL_MS = SPINNER_ADVANCE_MS;
const LIVE_SAMPLE_MS = 1_000;
const MIN_CALL_MS = 100;
const BURST_THRESHOLD_MS = 250;
const STALL_MS = 1_500;
const CALL_HISTORY = 10;
const COMPLETED_RETENTION_MS = 3_000;
const STALE_SESSION_MS = 10 * 60_000;
const PENDING_SPAWN_TTL_MS = 60_000;
const SPARK_LENGTH = 10;
const MAX_WORKER_ROWS = 8;
const GAUGE_FLOOR = 40;
const SCALE_CAP = 250;
const WORKER_GAUGE_WIDTH = 9;
const TRACK = "·";
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const MODE_HEADER = /(?:^|\n)\s*#?\s*(?:mode|persona):\s*(normal|orchestrate|brute)\b/i;
const PARTIAL_BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
// Fallback frames copied from OMP's native status spinner
// (packages/tui/src/theme/symbols.ts, SPINNER_FRAMES.unicode.status). At runtime
// the widget prefers the live theme's own frames so custom themes and the
// ascii/nerd symbol presets keep matching the native spinner.
const STATUS_SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

function isThroughputRegistry(value: unknown): value is ThroughputRegistry {
	if (value === null || typeof value !== "object") return false;
	if (!("version" in value) || value.version !== 4) return false;
	if (!("nextOrder" in value) || typeof value.nextOrder !== "number") return false;
	if (
		"mainSessionId" in value &&
		value.mainSessionId !== undefined &&
		typeof value.mainSessionId !== "string"
	) {
		return false;
	}
	if (!("sessions" in value) || !(value.sessions instanceof Map)) return false;
	if (!("sessionByAgentId" in value) || !(value.sessionByAgentId instanceof Map)) return false;
	if (!("pendingSpawns" in value) || !(value.pendingSpawns instanceof Map)) return false;
	return true;
}

function getRegistry(): ThroughputRegistry {
	const g = globalThis as Record<symbol, unknown>;
	const existing = g[REGISTRY_KEY];
	if (isThroughputRegistry(existing)) return existing;
	const created: ThroughputRegistry = {
		version: 4,
		nextOrder: 1,
		sessions: new Map(),
		sessionByAgentId: new Map(),
		pendingSpawns: new Map(),
	};
	g[REGISTRY_KEY] = created;
	return created;
}
export function pendingSpawnKey(parentSessionId: string, workerName: string): string {
	return `${parentSessionId}:${workerName}`;
}

export function parseTaskSpawns(
	input: unknown,
	parentSessionId: string,
	createdAt = Date.now(),
	toolCallId?: string,
): PendingSpawn[] {
	if (input === null || typeof input !== "object") return [];
	const asSpawn = (value: unknown, index: number): PendingSpawn | undefined => {
		if (value === null || typeof value !== "object") return undefined;
		const task = value as Record<string, unknown>;
		let workerName = task.name;
		if (typeof workerName !== "string" || workerName.length === 0) {
			if (!toolCallId) return undefined;
			workerName = `task-${toolCallId.slice(-8)}-${index + 1}`;
			task.name = workerName;
		}
		const spawn: PendingSpawn = { parentSessionId, workerName, createdAt };
		let contextMode: string | undefined;
		for (const value of [task.task, task.context]) {
			if (typeof value !== "string") continue;
			const match = value.match(MODE_HEADER);
			if (match) {
				contextMode = match[1].toLowerCase();
				break;
			}
		}
		const tag = typeof task.name === "string"
			? task.name.match(/\[(orch|orchestrate|brute|normal)\]/i)?.[1]?.toLowerCase()
			: undefined;
		const tagMode = tag === "orch" || tag === "orchestrate"
			? "orchestrate"
			: tag === "brute" || tag === "normal"
				? tag
				: undefined;
		const requestedMode =
			task.mode === "normal" || task.mode === "orchestrate" || task.mode === "brute"
				? task.mode
				: contextMode ?? tagMode ?? (task.agent === "orchestrator" ? "orchestrate" : undefined);
		if (typeof requestedMode === "string") spawn.mode = requestedMode;
		return spawn;
	};
	if ("tasks" in input && Array.isArray(input.tasks)) {
		return input.tasks.map(asSpawn).filter((spawn): spawn is PendingSpawn => spawn !== undefined);
	}
	const spawn = asSpawn(input, 0);
	return spawn ? [spawn] : [];
}

export function queuePendingSpawns(
	registry: ThroughputRegistry,
	spawns: readonly PendingSpawn[],
	timestamp = Date.now(),
): void {
	expirePendingSpawns(registry, timestamp);
	for (const spawn of spawns) {
		const key = pendingSpawnKey(spawn.parentSessionId, spawn.workerName);
		const queued = registry.pendingSpawns.get(key);
		if (queued) queued.push(spawn);
		else registry.pendingSpawns.set(key, [spawn]);
	}
}
export function expirePendingSpawns(registry: ThroughputRegistry, timestamp = Date.now()): void {
	for (const [key, queued] of registry.pendingSpawns) {
		const retained = queued.filter((spawn) => timestamp - spawn.createdAt <= PENDING_SPAWN_TTL_MS);
		if (retained.length === 0) registry.pendingSpawns.delete(key);
		else if (retained.length !== queued.length) registry.pendingSpawns.set(key, retained);
	}
}

export function clearPendingSpawns(registry: ThroughputRegistry, parentSessionId: string): void {
	for (const [key, queued] of registry.pendingSpawns) {
		if (queued.every((spawn) => spawn.parentSessionId === parentSessionId)) {
			registry.pendingSpawns.delete(key);
			continue;
		}
		const retained = queued.filter((spawn) => spawn.parentSessionId !== parentSessionId);
		if (retained.length !== queued.length) registry.pendingSpawns.set(key, retained);
	}
}

function wouldCreateCycle(registry: ThroughputRegistry, parentId: string, worker: SessionThroughput): boolean {
	const pending = [worker.sessionId];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const currentId = pending.pop();
		if (!currentId || visited.has(currentId)) continue;
		if (currentId === parentId) return true;
		visited.add(currentId);
		for (const childId of registry.sessions.get(currentId)?.children ?? []) pending.push(childId);
	}
	const ancestors = new Set<string>();
	let currentId: string | undefined = parentId;
	while (currentId) {
		if (currentId === worker.sessionId || ancestors.has(currentId)) return true;
		ancestors.add(currentId);
		currentId = registry.sessions.get(currentId)?.parentId;
	}
	return false;
}

function applyPendingSpawn(
	registry: ThroughputRegistry,
	worker: SessionThroughput,
	parentSessionId: string,
	timestamp = Date.now(),
): void {
	if (worker.role !== "worker") return;
	expirePendingSpawns(registry, timestamp);
	const separator = worker.label.indexOf(".");
	const shortName = separator < 0 ? worker.label : worker.label.slice(separator + 1);
	const workerNames = new Set([worker.label, shortName]);
	for (const [key, queue] of registry.pendingSpawns) {
		const index = queue.findIndex(
			(spawn) => spawn.parentSessionId === parentSessionId && workerNames.has(spawn.workerName),
		);
		if (index < 0) continue;
		const [spawn] = queue.splice(index, 1);
		if (queue.length === 0) registry.pendingSpawns.delete(key);
		if (spawn?.mode !== undefined) worker.mode = spawn.mode;
		return;
	}
}


export function collectWorkerTree(
	mainSessionId: string | undefined,
	sessions: Iterable<SessionThroughput>,
): ThroughputTreeRow[] {
	const nodes = [...sessions];
	const byId = new Map<string, SessionThroughput>();
	for (const session of nodes) byId.set(session.sessionId, session);
	const children = new Map<string, SessionThroughput[]>();
	for (const session of nodes) children.set(session.sessionId, []);
	for (const session of nodes) {
		if (session.parentId && byId.has(session.parentId)) {
			children.get(session.parentId)?.push(session);
		}
	}
	const compare = (left: SessionThroughput, right: SessionThroughput): number => {
		if (left.phase === "complete" && right.phase !== "complete") return 1;
		if (right.phase === "complete" && left.phase !== "complete") return -1;
		return left.order - right.order;
	};
	for (const childrenOfParent of children.values()) childrenOfParent.sort(compare);
	const result: ThroughputTreeRow[] = [];
	const visited = new Set<string>();
	const branchAncestors: boolean[] = [];
	const visit = (session: SessionThroughput, hidden = false): void => {
		if (visited.has(session.sessionId)) return;
		visited.add(session.sessionId);
		const hasParent = !!session.parentId && byId.has(session.parentId);
		const siblings = hasParent ? (children.get(session.parentId ?? "") ?? []) : [];
		const isLast = siblings.indexOf(session) === siblings.length - 1;
		if (!hidden && session.role === "worker") {
			let prefix = "";
			if (hasParent) {
				for (const ancestorIsLast of branchAncestors) prefix += ancestorIsLast ? "   " : "│  ";
				prefix += isLast ? "└─ " : "├─ ";
			}
			result.push({ session, prefix });
		}
		const descendants = children.get(session.sessionId) ?? [];
		const previousDepth = branchAncestors.length;
		if (hasParent) branchAncestors.push(isLast);
		for (const child of descendants) visit(child);
		branchAncestors.length = previousDepth;
	};
	const main = mainSessionId ? byId.get(mainSessionId) : undefined;
	if (main) visit(main, true);
	const roots = nodes
		.filter((session) => session.role === "worker" && (!session.parentId || !byId.has(session.parentId)))
		.sort(compare);
	for (const root of roots) visit(root);
	for (const session of nodes.sort(compare)) visit(session);
	return result;
}

export function pruneWorkers(registry: ThroughputRegistry, timestamp: number): void {
	expirePendingSpawns(registry, timestamp);
	const childrenByParent = new Map<string, Set<string>>();
	const hasPath = (fromId: string, targetId: string): boolean => {
		const pending = [fromId];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || visited.has(current)) continue;
			if (current === targetId) return true;
			visited.add(current);
			for (const childId of childrenByParent.get(current) ?? []) pending.push(childId);
		}
		return false;
	};
	const addChild = (parentId: string, childId: string): void => {
		if (parentId === childId || hasPath(childId, parentId)) return;
		let children = childrenByParent.get(parentId);
		if (!children) {
			children = new Set();
			childrenByParent.set(parentId, children);
		}
		children.add(childId);
	};
	for (const session of registry.sessions.values()) {
		if (session.parentId && registry.sessions.has(session.parentId)) addChild(session.parentId, session.sessionId);
		for (const childId of session.children) {
			if (registry.sessions.has(childId)) addChild(session.sessionId, childId);
		}
	}
	const workers = [...registry.sessions.values()]
		.filter((session) => session.role === "worker")
		.sort((left, right) => right.depth - left.depth || right.order - left.order);
	const retained = new Map<string, boolean>();
	const retainWorker = (worker: SessionThroughput, visiting = new Set<string>()): boolean => {
		const cached = retained.get(worker.sessionId);
		if (cached !== undefined) return cached;
		if (visiting.has(worker.sessionId)) return false;
		const completedExpired =
			worker.phase === "complete" &&
			worker.completedAt !== undefined &&
			timestamp - worker.completedAt > COMPLETED_RETENTION_MS;
		const stale = timestamp - worker.updatedAt > STALE_SESSION_MS;
		if (!completedExpired && !stale) {
			retained.set(worker.sessionId, true);
			return true;
		}
		visiting.add(worker.sessionId);
		for (const childId of childrenByParent.get(worker.sessionId) ?? []) {
			const child = registry.sessions.get(childId);
			if (child?.role === "worker" && retainWorker(child, visiting)) {
				visiting.delete(worker.sessionId);
				retained.set(worker.sessionId, true);
				return true;
			}
		}
		visiting.delete(worker.sessionId);
		retained.set(worker.sessionId, false);
		return false;
	};
	for (const worker of workers) {
		if (retainWorker(worker)) continue;
		registry.sessions.delete(worker.sessionId);
		if (registry.sessionByAgentId.get(worker.agentId) === worker.sessionId) {
			registry.sessionByAgentId.delete(worker.agentId);
		}
		for (const parent of registry.sessions.values()) {
			parent.children = parent.children.filter((childId) => childId !== worker.sessionId);
		}
		if (worker.parentId) {
			const siblings = childrenByParent.get(worker.parentId);
			siblings?.delete(worker.sessionId);
			if (siblings?.size === 0) childrenByParent.delete(worker.parentId);
		}
	}
}

export function personaBadge(mode: string | undefined): { label: string; icon: string; tone: "dim" | "accent" | "warning" } {
	if (mode === "orchestrate") return { label: "🧠 orch", icon: "🧠", tone: "accent" };
	if (mode === "brute") return { label: "🚀 brute", icon: "🚀", tone: "warning" };
	return { label: "🔘 normal", icon: "🔘", tone: "dim" };
}



export function estimateTokens(chars: number): number {
	return Math.ceil(chars / 3.5);
}

const GENERATION_EVENT_TYPES: Record<string, true> = {
	thinking_start: true,
	thinking_delta: true,
	thinking_end: true,
	text_start: true,
	text_delta: true,
	text_end: true,
	toolcall_start: true,
	toolcall_delta: true,
	toolcall_end: true,
};

export function coerceDeltaText(delta: unknown): string {
	if (typeof delta === "string") return delta;
	if (delta === null || typeof delta !== "object") return "";
	const rec = delta as Record<string, unknown>;
	if (typeof rec.text === "string") return rec.text;
	if (typeof rec.content === "string") return rec.content;
	if (typeof rec.delta === "string") return rec.delta;
	if (typeof rec.partialJson === "string") return rec.partialJson;
	if (typeof rec.arguments === "string") return rec.arguments;
	if (typeof rec.args === "string") return rec.args;
	return "";
}

export function eventDeltaChars(event: { type?: unknown; delta?: unknown }): number {
	if (event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "toolcall_delta") {
		return 0;
	}
	return coerceDeltaText(event.delta).length;
}

export function messageContentChars(message: unknown): number {
	if (message === null || typeof message !== "object") return 0;
	if (!("content" in message) || !Array.isArray(message.content)) return 0;
	let chars = 0;
	for (const block of message.content) {
		if (block === null || typeof block !== "object") continue;
		const rec = block as Record<string, unknown>;
		if (rec.type === "text" && typeof rec.text === "string") {
			chars += rec.text.length;
			continue;
		}
		if (rec.type === "thinking" && typeof rec.thinking === "string") {
			chars += rec.thinking.length;
			continue;
		}
		if (rec.type !== "toolCall") continue;
		const args = rec.arguments;
		if (typeof args === "string") {
			chars += args.length;
			continue;
		}
		if (args == null) continue;
		try {
			chars += JSON.stringify(args).length;
		} catch {
			// ignore unserializable tool-call args
		}
	}
	return chars;
}

export function resolveMessageTokens(message: unknown, streamedChars: number): number {
	return outputTokens(message) ?? Math.max(estimateTokens(streamedChars), estimateTokens(messageContentChars(message)));
}

/** Resolves token count for TPS calculation.
 *  Uses exact billed output tokens when available, but compensates for Anthropic
 *  redacted/unstreamed thinking so hidden server-side thinking is amortized over
 *  the full request duration rather than spiking on the tiny visible tail. */
export function effectiveStreamTokens(
	session: {
		messageChars: number;
		messageTokens: number;
		requestStartedAt: number;
		firstTokenAt: number;
	},
	generateMs: number,
	timestamp: number,
): number {
	const estimatedFromChars = estimateTokens(session.messageChars);
	const billed = session.messageTokens;
	if (billed <= 0) return estimatedFromChars;

	const startedAt = session.requestStartedAt > 0 ? session.requestStartedAt : 0;
	const requestMs = startedAt > 0 ? timestamp - startedAt : generateMs;
	if (billed > Math.max(50, estimatedFromChars * 2.5) && requestMs > generateMs * 2) {
		const requestTps = billed / (requestMs / 1000);
		return Math.max(estimatedFromChars, Math.round(requestTps * (generateMs / 1000)));
	}
	return billed;
}

export function streamRateTokens(streamedChars: number): number {
	return estimateTokens(streamedChars);
}


export type TokenProgress = {
	firstTokenAt: number;
	lastTokenAt: number;
	lastActivityAt: number;
	updatedAt: number;
	messageChars: number;
	messageTokens: number;
};

export function applyAssistantProgress(
	session: TokenProgress,
	event: { type?: unknown; delta?: unknown },
	message: unknown,
	timestamp: number,
): boolean {
	const deltaChars = eventDeltaChars(event);
	const contentChars = messageContentChars(message);
	if (!(typeof event.type === "string" && GENERATION_EVENT_TYPES[event.type]) && deltaChars === 0 && contentChars === 0) {
		return false;
	}

	if (session.firstTokenAt === 0) session.firstTokenAt = timestamp;
	session.messageChars += deltaChars;
	const effectiveChars = Math.max(session.messageChars, contentChars);
	session.messageChars = effectiveChars;
	session.messageTokens = resolveMessageTokens(message, effectiveChars);
	session.lastTokenAt = timestamp;
	session.lastActivityAt = timestamp;
	session.updatedAt = timestamp;
	return true;
}

export function generationWindowMs(
	session: {
		firstTokenAt: number;
		requestStartedAt: number;
		messageStartedAt: number;
	},
	timestamp: number,
): number {
	const visibleMs = session.firstTokenAt > 0 ? Math.max(0, timestamp - session.firstTokenAt) : 0;
	const startedAt = session.requestStartedAt > 0 ? session.requestStartedAt : session.messageStartedAt;
	const totalMs = startedAt > 0 ? Math.max(0, timestamp - startedAt) : 0;

	// If streaming spanned a sustained window (>= 250ms), use visible streaming duration.
	if (visibleMs >= BURST_THRESHOLD_MS) {
		return visibleMs;
	}

	// For ultra-fast single-packet bursts (< 250ms), the tokens arrived all at once in
	// the network buffer. Measuring only the 10-50ms network delivery time produces
	// false 1600+ TPS spikes. Use total request processing + generation duration.
	if (totalMs >= MIN_CALL_MS) {
		return totalMs;
	}

	return Math.max(MIN_CALL_MS, visibleMs > 0 ? visibleMs : totalMs);
}

function speedColor(theme: Theme, tps: number, text: string): string {
	if (!(tps > 0)) return theme.fg("dim", text);
	const code = tps >= 250 ? 135 : tps >= 150 ? 33 : tps >= 100 ? 82 : tps >= 70 ? 220 : tps >= 40 ? 208 : 196;
	return `\x1b[38;5;${code}m${text}\x1b[39m`;
}

function formatRate(tps: number): string {
	if (tps < 10) return tps.toFixed(1);
	if (tps < 100) return tps.toFixed(0);
	return Math.round(tps).toString();
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}k`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return tokens.toString();
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

function truncate(value: string, width: number): string {
	if (value.length <= width) return value;
	if (width <= 1) return "…";
	return `${value.slice(0, width - 1)}…`;
}

function terminalCharWidth(character: string): number {
	const codePoint = character.codePointAt(0) ?? 0;
	if (
		codePoint === 0x200d ||
		/^\p{Mark}$/u.test(character) ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		(codePoint >= 0xe0100 && codePoint <= 0xe01ef)
	) {
		return 0;
	}
	if (
		codePoint >= 0x1100 &&
		(codePoint <= 0x115f ||
			codePoint === 0x2329 ||
			codePoint === 0x232a ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
			(codePoint >= 0x20000 && codePoint <= 0x3fffd))
	) {
		return 2;
	}
	return 1;
}

function ansiSequenceEnd(value: string, start: number): number {
	if (value.charCodeAt(start) !== 0x1b || value.charCodeAt(start + 1) !== 0x5b) return start;
	let index = start + 2;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index + 1;
		index++;
	}
	return start;
}

export function terminalDisplayWidth(value: string): number {
	let columns = 0;
	for (let index = 0; index < value.length; ) {
		if (value.charCodeAt(index) === 0x1b) {
			const end = ansiSequenceEnd(value, index);
			if (end > index) {
				index = end;
				continue;
			}
		}
		const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
		columns += terminalCharWidth(character);
		index += character.length;
	}
	return columns;
}

export function truncateTerminalLine(value: string, width: number): string {
	if (width <= 0) return "";
	let result = "";
	let columns = 0;
	let index = 0;
	let hasAnsi = false;
	let clipped = false;
	while (index < value.length) {
		if (value.charCodeAt(index) === 0x1b) {
			const end = ansiSequenceEnd(value, index);
			if (end > index) {
				result += value.slice(index, end);
				index = end;
				hasAnsi = true;
				continue;
			}
		}
		const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
		const charWidth = terminalCharWidth(character);
		if (columns + charWidth > width) {
			clipped = true;
			break;
		}
		result += character;
		columns += charWidth;
		index += character.length;
	}
	if (clipped && hasAnsi) result += "\x1b[0m";
	return result;
}

function pad(value: string, width: number): string {
	return truncate(value, width).padEnd(width);
}

function renderGauge(theme: Theme, tps: number, scale: number, width: number): string {
	const clampedTps = Math.max(0, tps);
	const clampedScale = Math.max(1, scale);
	const filledWidth = Math.max(0, Math.min(width, (clampedTps / clampedScale) * width));
	const fullBlocks = Math.floor(filledWidth);
	const remainder = filledWidth - fullBlocks;
	const partialIndex = Math.floor(remainder * PARTIAL_BLOCKS.length);
	const partialChar = partialIndex > 0 ? PARTIAL_BLOCKS[partialIndex] ?? "" : "";
	const filled = "█".repeat(fullBlocks) + partialChar;
	const empty = TRACK.repeat(Math.max(0, width - fullBlocks - (partialChar ? 1 : 0)));
	return `${speedColor(theme, clampedTps, filled)}${theme.fg("dim", empty)}`;
}

export function getSparkHistory(session: SessionThroughput, liveTps: number): number[] {
	const values: number[] = [];
	for (const call of session.callHistory) {
		if (call.tps > 0) values.push(call.tps);
	}
	if (liveTps > 0) {
		values.push(liveTps);
	}
	return values.slice(-SPARK_LENGTH);
}

export function renderSparkline(theme: Theme, history: readonly number[], colorTps: number): string {
	const values = history.slice(-SPARK_LENGTH);
	const padCount = SPARK_LENGTH - values.length;
	if (values.length === 0) {
		return theme.fg("dim", BLOCKS[0].repeat(SPARK_LENGTH));
	}
	const peak = Math.max(GAUGE_FLOOR, ...values);
	const chars = values.map((val) => {
		const ratio = Math.max(0, Math.min(1, val / peak));
		const blockIdx = Math.min(BLOCKS.length - 1, Math.max(0, Math.floor(ratio * (BLOCKS.length - 1))));
		return BLOCKS[blockIdx];
	});
	const spark = `${BLOCKS[0].repeat(padCount)}${chars.join("")}`;
	return colorTps > 0 ? speedColor(theme, colorTps, spark) : theme.fg("dim", spark);
}

function sessionLabel(ctx: ExtensionContext): string {
	const raw = ctx.sessionManager.getSessionName();
	if (raw) return raw;
	const file = ctx.sessionManager.getSessionFile();
	if (!file) return "main";
	const base = basename(file, extname(file));
	return base || "main";
}

function modelLabel(ctx: ExtensionContext): string {
	const model = ctx.model;
	if (!model) return "unknown-model";
	const slash = model.id.lastIndexOf("/");
	return slash >= 0 ? model.id.slice(slash + 1) : model.id;
}

export function outputTokens(message: unknown): number | undefined {
	if (message === null || typeof message !== "object") return undefined;
	if (!("usage" in message)) return undefined;
	const usage = message.usage;
	if (usage === null || typeof usage !== "object" || !("output" in usage)) return undefined;
	const out = usage.output;
	return typeof out === "number" && out > 0 ? out : undefined;
}

export function callTps(tokens: number, generateMs: number): number {
	if (!(tokens > 0) || generateMs < MIN_CALL_MS) return 0;
	const tps = tokens / (generateMs / 1000);
	return Number.isFinite(tps) && tps > 0 ? tps : 0;
}

function meanTps(history: readonly StreamCall[], liveTps: number): number {
	const rates: number[] = [];
	for (const call of history) {
		if (call.tps > 0) rates.push(call.tps);
	}
	if (liveTps > 0) rates.push(liveTps);
	if (rates.length === 0) return 0;
	let sum = 0;
	for (const rate of rates) sum += rate;
	return sum / rates.length;
}

function liveGenerationTps(session: SessionThroughput, timestamp: number): number {
	if (session.phase !== "streaming") return 0;
	const generateMs = generationWindowMs(session, timestamp);
	const tokens = effectiveStreamTokens(session, generateMs, timestamp);
	return callTps(tokens, generateMs);
}
function refreshAvgTps(session: SessionThroughput, timestamp: number): void {
	if (session.phase !== "streaming") return;
	if (session.lastSampleAt > 0 && timestamp - session.lastSampleAt < LIVE_SAMPLE_MS) return;
	session.lastSampleAt = timestamp;
	const live = liveGenerationTps(session, timestamp);
	session.avgTps = meanTps(session.callHistory, live);
	if (session.firstTokenAt > 0) {
		session.tickHistory.push(live);
		if (session.tickHistory.length > SPARK_LENGTH) session.tickHistory.shift();
	}
}

function recordCall(session: SessionThroughput, timestamp: number): void {
	const startedAt = session.requestStartedAt > 0 ? session.requestStartedAt : session.messageStartedAt;
	const ttfbMs =
		session.firstTokenAt > 0
			? Math.max(0, session.firstTokenAt - startedAt)
			: Math.max(0, timestamp - startedAt);
	const generateMs = generationWindowMs(session, timestamp);
	session.lastTtfbMs = ttfbMs;
	const tokens = effectiveStreamTokens(session, generateMs, timestamp);
	const tps = callTps(tokens, generateMs);
	if (tps > 0) {
		session.callHistory.push({ tps, ttfbMs, generateMs, tokens: session.messageTokens });
		if (session.callHistory.length > CALL_HISTORY) session.callHistory.shift();
	}
	session.avgTps = meanTps(session.callHistory, 0);
	session.lastSampleAt = 0;
}

function ttfbLabel(session: SessionThroughput, timestamp: number): string {
	const startedAt = session.requestStartedAt > 0 ? session.requestStartedAt : session.messageStartedAt;
	if (startedAt <= 0) {
		if (session.lastTtfbMs > 0) return formatDuration(session.lastTtfbMs);
		return "—";
	}
	if (session.firstTokenAt > 0) return formatDuration(session.firstTokenAt - startedAt);
	if (session.phase === "streaming") return formatDuration(timestamp - startedAt);
	if (session.lastTtfbMs > 0) return formatDuration(session.lastTtfbMs);
	return "—";
}

function sinceLabel(session: SessionThroughput, timestamp: number): string {
	if (session.phase === "streaming") {
		if (session.firstTokenAt === 0) return "waiting";
		const stall = timestamp - session.lastTokenAt;
		if (stall >= STALL_MS) return `stall ${formatDuration(stall)}`;
		return "live";
	}
	if (session.phase === "tool") {
		const name = session.toolName ? truncate(session.toolName, 10) : "tool";
		return `${name} ${formatDuration(timestamp - session.toolStartedAt)}`;
	}
	if (session.lastActivityAt > 0) return `idle ${formatDuration(timestamp - session.lastActivityAt)}`;
	return "idle";
}


/** Phase-locked spinner frame index; mirrors sharedSpinnerFrame in
 * packages/tui/src/chat/tool-execution.ts so both spinners share one clock. */
export function statusSpinnerFrame(frameCount: number, now: number = performance.now()): number {
	return frameCount > 0 ? Math.floor(now / SPINNER_ADVANCE_MS) % frameCount : 0;
}

function renderStatusIcon(theme: Theme, phase: SessionPhase, frame: number, frames: string[]): string {
	if (phase === "complete") return theme.fg("success", "✓");
	if (phase === "streaming") return theme.fg("accent", frames[frame % frames.length] ?? frames[0] ?? "");
	if (phase === "tool") return theme.fg("warning", "⚙");
	return theme.fg("dim", "·");
}

function agentBadgeColor(theme: Theme, agent: string, text: string): string {
	switch (agent) {
		case "scout":
			return theme.fg("accent", text);
		case "designer":
			return theme.fg("warning", text);
		case "reviewer":
			return theme.fg("success", text);
		case "librarian":
		case "sonic":
			return theme.fg("accent", text);
		default:
			return theme.fg("dim", text);
	}
}

function renderModeBadge(theme: Theme, session: SessionThroughput): string {
	const modeRegistry = (globalThis as Record<symbol, unknown>)[SESSION_PERSONA_KEY] as
		| { getMode?: (sessionId: string) => string; mode?: Map<string, string> }
		| undefined;
	const mode = modeRegistry
		? modeRegistry.mode?.has(session.sessionId)
			? modeRegistry.getMode?.(session.sessionId)
			: session.mode ?? "normal"
		: session.mode;
	const badge = personaBadge(mode);
	return theme.fg(badge.tone, badge.icon);
}


function emptySession(sessionId: string, order: number, ctx: ExtensionContext, pi: ExtensionAPI): SessionThroughput {
	const timestamp = Date.now();
	return {
		sessionId,
		agentId: ctx.agent.id,
		agentParentId: ctx.agent.parentId,
		role: ctx.agent.kind === "main" ? "main" : "worker",
		order,
		label: sessionLabel(ctx),
		model: modelLabel(ctx),
		thinkingLevel: String(pi.getThinkingLevel()),
		agent: ctx.agent.name,
		phase: "waiting",
		children: [],
		parentResolved: ctx.agent.parentId === undefined,
		depth: ctx.agent.depth,
		messageStartedAt: 0,
		requestStartedAt: 0,
		firstTokenAt: 0,
		lastTokenAt: 0,
		lastActivityAt: 0,
		lastSampleAt: 0,
		toolStartedAt: 0,
		messageChars: 0,
		messageTokens: 0,
		totalTokens: 0,
		avgTps: 0,
		lastTtfbMs: 0,
		callHistory: [],
		tickHistory: [],
		updatedAt: timestamp,
		messageOpen: false,
	};
}

export default function throughput(pi: ExtensionAPI): void {
	const registry = getRegistry();
	let state: SessionThroughput | undefined;
	let uiTimer: Timer | undefined;
	let uiTimerContext: ExtensionContext | undefined;
	let uiTick = 0;
	let cachedCols = -1;
	let cachedLabelCap = 0;
	let cachedAgentWidth = 0;
	let cachedModelWidth = 0;

	function removeCurrentState(): void {
		if (!state) return;
		if (state.parentId) {
			const parent = registry.sessions.get(state.parentId);
			if (parent) parent.children = parent.children.filter((childId) => childId !== state?.sessionId);
		}
		for (const childId of state.children) {
			const child = registry.sessions.get(childId);
			if (!child) continue;
			child.parentId = undefined;
			child.parentResolved = child.agentParentId === undefined;
		}
		registry.sessions.delete(state.sessionId);
		if (registry.sessionByAgentId.get(state.agentId) === state.sessionId) {
			registry.sessionByAgentId.delete(state.agentId);
		}
		if (registry.mainSessionId === state.sessionId) registry.mainSessionId = undefined;
		state = undefined;
	}

	function resolveParent(current: SessionThroughput): void {
		if (current.parentResolved) return;
		const parentSessionId = current.agentParentId
			? registry.sessionByAgentId.get(current.agentParentId)
			: undefined;
		const parent = parentSessionId ? registry.sessions.get(parentSessionId) : undefined;
		if (!parent || wouldCreateCycle(registry, parent.sessionId, current)) return;
		current.parentId = parent.sessionId;
		current.parentResolved = true;
		if (!parent.children.includes(current.sessionId)) parent.children.push(current.sessionId);
		applyPendingSpawn(registry, current, parent.sessionId);
	}

	function resolvePendingParents(): void {
		for (const candidate of registry.sessions.values()) resolveParent(candidate);
	}

	function ensureState(ctx: ExtensionContext): SessionThroughput {
		const sessionId = ctx.sessionManager.getSessionId();
		if (state?.sessionId === sessionId) {
			state.label = sessionLabel(ctx);
			state.model = modelLabel(ctx);
			state.thinkingLevel = String(pi.getThinkingLevel());
			state.agent = ctx.agent.name;
			state.depth = ctx.agent.depth;
			registry.sessions.set(sessionId, state);
			registry.sessionByAgentId.set(ctx.agent.id, sessionId);
			resolveParent(state);
			return state;
		}

		removeCurrentState();
		if (ctx.agent.kind === "main") registry.mainSessionId = sessionId;
		state = emptySession(sessionId, registry.nextOrder++, ctx, pi);
		registry.sessions.set(sessionId, state);
		registry.sessionByAgentId.set(ctx.agent.id, sessionId);
		resolveParent(state);
		resolvePendingParents();
		return state;
	}


	function workerRow(
		theme: Theme,
		worker: SessionThroughput,
		treePrefix: string,
		displayLabel: string,
		labelWidth: number,
		agentWidth: number,
		modelWidth: number,
		scale: number,
		timestamp: number,
		cols: number,
	): string {
		refreshAvgTps(worker, timestamp);
		const isComplete = worker.phase === "complete";
		const themeFrames = theme.spinnerFrames;
		const spinnerFrames = Array.isArray(themeFrames) && themeFrames.length > 0 ? themeFrames : STATUS_SPINNER_FRAMES;
		const icon = renderStatusIcon(theme, worker.phase, statusSpinnerFrame(spinnerFrames.length), spinnerFrames);
		const prefix = treePrefix.length > labelWidth - 4 ? `…${treePrefix.slice(-3)}` : treePrefix;
		const availableLabelWidth = Math.max(0, labelWidth - prefix.length);
		const label = availableLabelWidth === 0 ? "" : pad(displayLabel, availableLabelWidth);
		const styledLabel = isComplete ? theme.fg("dim", label) : theme.fg("accent", label);
		const branch = theme.fg("dim", prefix);
		const model = theme.fg("dim", pad(`${worker.model}:${worker.thinkingLevel}`, modelWidth));
		const persona = renderModeBadge(theme, worker);
		const dimPipe = theme.fg("dim", "|");
		// Drop the shared `-frontier` infix so reviewer seats keep their number in the narrow agent column.
		const badge = agentBadgeColor(theme, worker.agent, pad(worker.agent.replace("-frontier-", "-"), agentWidth));
		const totalTokens = formatTokens(worker.totalTokens + (worker.messageOpen ? worker.messageTokens : 0));
		const dimSeparator = theme.fg("dim", "·");
		const tps = worker.avgTps;
		const gauge = renderGauge(theme, tps, scale, WORKER_GAUGE_WIDTH);
		const rateStr = pad(`${formatRate(tps)} tps`, 9);
		const styledRate = tps > 0 ? speedColor(theme, tps, rateStr) : theme.fg("dim", rateStr);
		const row = `${icon} ${branch}${styledLabel}  ${persona} ${dimPipe} ${badge}  ${model}  ${gauge}  ${styledRate}  ${dimSeparator}  ${theme.fg("dim", totalTokens)}`;
		return truncateTerminalLine(row, cols);
	}

	function renderPanel(ctx: ExtensionContext): void {
		const timestamp = Date.now();
		pruneWorkers(registry, timestamp);
		const main = ensureState(ctx);
		refreshAvgTps(main, timestamp);
		const workers = [...registry.sessions.values()].filter(
			(candidate) => candidate.role === "worker" && candidate.sessionId !== main.sessionId,
		);
		const treeRows = collectWorkerTree(main.sessionId, registry.sessions.values());

		const mainActive = main.phase === "streaming" || main.phase === "tool";
		let activeCount = mainActive ? 1 : 0;
		let streamingCount = main.phase === "streaming" ? 1 : 0;
		let aggregateTokens = main.totalTokens + (main.messageOpen ? main.messageTokens : 0);
		let workerScale = GAUGE_FLOOR;

		for (const worker of workers) {
			refreshAvgTps(worker, timestamp);
			aggregateTokens += worker.totalTokens + (worker.messageOpen ? worker.messageTokens : 0);
			if (worker.phase === "complete") continue;
			activeCount++;
			if (worker.phase === "streaming") streamingCount++;
			if (worker.avgTps > workerScale) workerScale = worker.avgTps;
		}
		workerScale = Math.min(SCALE_CAP, workerScale);

		const theme = ctx.ui.theme;
		const cols = Math.max(1, process.stdout.columns ?? 100);
		if (cols !== cachedCols) {
			cachedCols = cols;
			const terminalWidth = Math.max(60, cols);
			// Worker names are short CamelCase; agent names need room to tell peer reviewers apart.
			cachedLabelCap = Math.min(20, Math.max(12, Math.floor((terminalWidth - 60) * 0.35)));
			cachedAgentWidth = Math.min(13, Math.max(7, terminalWidth - cachedLabelCap - 57));
			cachedModelWidth = Math.min(24, Math.max(14, terminalWidth - cachedLabelCap - cachedAgentWidth - 43));
		}
		const headerTps = main.avgTps;
		const headerParts: string[] = [];
		const chip =
			(
				(globalThis as Record<symbol, unknown>)[SESSION_PERSONA_KEY] as
					| { paint?: (sessionId: string, tick: number) => string }
					| undefined
			)?.paint?.(main.sessionId, uiTick) ?? "\x1b[38;5;245mnormal\x1b[0m";
		headerParts.push(chip, theme.fg("dim", "|"));
		headerParts.push(theme.fg("accent", "Throughput"));
		const live = main.phase === "streaming" ? liveGenerationTps(main, timestamp) : 0;
		headerParts.push(renderSparkline(theme, getSparkHistory(main, live), headerTps));
		headerParts.push(
			`${headerTps > 0 ? speedColor(theme, headerTps, formatRate(headerTps)) : theme.fg("dim", formatRate(headerTps))} ${theme.fg("dim", "tps")}`,
			theme.fg("dim", "·"),
			theme.fg("dim", `ttfb ${ttfbLabel(main, timestamp)}`),
			theme.fg("dim", "·"),
			`${activeCount} active`,
			theme.fg("dim", "·"),
			`${streamingCount} streaming`,
			theme.fg("dim", "·"),
			theme.fg("dim", `${formatTokens(aggregateTokens)} tok`),
			theme.fg("dim", "·"),
			theme.fg("dim", sinceLabel(main, timestamp)),
		);
		const header = truncateTerminalLine(headerParts.join(" "), cols);
		const shownWorkers = treeRows.slice(0, MAX_WORKER_ROWS).map((row) => ({
			...row,
			label: row.session.parentId && row.prefix.length > 0 && row.session.label.includes(".")
				? row.session.label.slice(row.session.label.lastIndexOf(".") + 1)
				: row.session.label,
		}));
		// Size the name column to the longest shown name, capped by terminal width; longer names get an ellipsis.
		let labelWidth = 10;
		for (const row of shownWorkers) labelWidth = Math.max(labelWidth, row.prefix.length + row.label.length);
		labelWidth = Math.min(cachedLabelCap, labelWidth);
		const lines = [
			header,
			...shownWorkers.map((row) =>
				workerRow(
					theme,
					row.session,
					row.prefix,
					row.label,
					labelWidth,
					cachedAgentWidth,
					cachedModelWidth,
					workerScale,
					timestamp,
					cols,
				),
			),
		];
		if (treeRows.length > shownWorkers.length) {
			lines.push(truncateTerminalLine(theme.fg("dim", `  … ${treeRows.length - shownWorkers.length} more workers`), cols));
		}
		ctx.ui.setWidget("throughput-workers", lines, { placement: "aboveEditor" });
	}

	function renderUi(ctx: ExtensionContext): void {
		uiTick++;
		renderPanel(ctx);
	}

	function clearUiTimer(): void {
		if (uiTimer === undefined) return;
		const timer = uiTimer;
		const owner = uiTimerContext;
		uiTimer = undefined;
		uiTimerContext = undefined;
		owner?.clearTimer(timer);
	}

	function startUi(ctx: ExtensionContext): void {
		const current = ensureState(ctx);
		if (current.role !== "main") return;
		clearUiTimer();
		uiTimer = ctx.setInterval(() => renderUi(ctx), UI_INTERVAL_MS);
		uiTimerContext = ctx;
		renderUi(ctx);
	}

	function stopUi(ctx: ExtensionContext): void {
		clearUiTimer();
		if (state?.role !== "main") return;
		ctx.ui.setWidget("throughput-workers", undefined, { placement: "aboveEditor" });
	}

	pi.on("session_start", (_event, ctx) => {
		const current = ensureState(ctx);
		if (current.role === "main") startUi(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		const current = ensureState(ctx);
		current.phase = "waiting";
		current.completedAt = undefined;
		current.toolName = undefined;
		current.updatedAt = Date.now();
	});

	pi.on("before_provider_request", (_event, ctx) => {
		const current = ensureState(ctx);
		const timestamp = Date.now();
		current.requestStartedAt = timestamp;
		current.firstTokenAt = 0;
		current.lastActivityAt = timestamp;
		current.updatedAt = timestamp;
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const current = ensureState(ctx);
		const timestamp = Date.now();
		current.phase = "streaming";
		current.toolName = undefined;
		current.messageStartedAt = timestamp;
		current.firstTokenAt = 0;
		current.lastTokenAt = 0;
		current.lastActivityAt = timestamp;
		current.lastSampleAt = 0;
		current.messageChars = 0;
		current.messageTokens = 0;
		current.updatedAt = timestamp;
		current.messageOpen = true;
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const current = ensureState(ctx);
		applyAssistantProgress(current, event.assistantMessageEvent, event.message, Date.now());
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const current = ensureState(ctx);
		if (!current.messageOpen) return;
		const timestamp = Date.now();
		const finalTokens = resolveMessageTokens(event.message, current.messageChars);
		current.messageTokens = Math.max(current.messageTokens, finalTokens);
		current.totalTokens += current.messageTokens;
		current.lastTokenAt = timestamp;
		if (current.firstTokenAt === 0 && current.messageTokens > 0) {
			current.firstTokenAt = current.requestStartedAt || current.messageStartedAt || timestamp;
		}
		current.phase = "waiting";
		current.messageOpen = false;
		current.updatedAt = timestamp;
		current.lastActivityAt = timestamp;
		recordCall(current, timestamp);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const current = ensureState(ctx);
		const timestamp = Date.now();
		current.phase = "tool";
		current.toolName = event.toolName;
		current.toolStartedAt = timestamp;
		current.lastActivityAt = timestamp;
		current.updatedAt = timestamp;
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		const current = ensureState(ctx);
		const timestamp = Date.now();
		current.phase = "waiting";
		current.toolName = undefined;
		current.lastActivityAt = timestamp;
		current.updatedAt = timestamp;
	});

	pi.on("agent_end", (_event, ctx) => {
		const current = ensureState(ctx);
		current.updatedAt = Date.now();
		current.messageOpen = false;
		current.toolName = undefined;
		if (current.role === "worker") {
			current.phase = "complete";
			current.completedAt = current.updatedAt;
		} else {
			current.phase = "waiting";
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "task" || !("input" in event)) return;
		const parentSessionId = ctx.sessionManager.getSessionId();
		queuePendingSpawns(registry, parseTaskSpawns(event.input, parentSessionId, Date.now(), event.toolCallId));
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopUi(ctx);
		clearPendingSpawns(registry, ctx.sessionManager.getSessionId());
		removeCurrentState();
	});
}
