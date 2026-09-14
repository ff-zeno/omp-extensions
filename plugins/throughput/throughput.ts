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

interface SessionThroughput {
	readonly sessionId: string;
	role: SessionRole;
	readonly order: number;
	label: string;
	model: string;
	thinkingLevel: string;
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

interface ThroughputRegistry {
	readonly version: 3;
	nextOrder: number;
	mainSessionId?: string;
	readonly sessions: Map<string, SessionThroughput>;
}

const REGISTRY_KEY = Symbol.for("omp.throughput.registry.v3");
const SESSION_MODE_KEY = Symbol.for("omp.session-mode.v1");
const UI_INTERVAL_MS = 150;
const LIVE_SAMPLE_MS = 1_000;
const MIN_CALL_MS = 100;
const BURST_THRESHOLD_MS = 250;
const STALL_MS = 1_500;
const CALL_HISTORY = 10;
const COMPLETED_RETENTION_MS = 3_000;
const STALE_SESSION_MS = 10 * 60_000;
const SPARK_LENGTH = 10;
const MAX_WORKER_ROWS = 8;
const GAUGE_FLOOR = 40;
const SCALE_CAP = 250;
const WORKER_GAUGE_WIDTH = 9;
const TRACK = "·";
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const PARTIAL_BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function isThroughputRegistry(value: unknown): value is ThroughputRegistry {
	if (value === null || typeof value !== "object") return false;
	if (!("version" in value) || value.version !== 3) return false;
	if (!("sessions" in value) || !(value.sessions instanceof Map)) return false;
	return true;
}

function getRegistry(): ThroughputRegistry {
	const g = globalThis as Record<symbol, unknown>;
	const existing = g[REGISTRY_KEY];
	if (isThroughputRegistry(existing)) return existing;
	const created: ThroughputRegistry = {
		version: 3,
		nextOrder: 1,
		sessions: new Map(),
	};
	g[REGISTRY_KEY] = created;
	return created;
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


function renderStatusIcon(theme: Theme, phase: SessionPhase, tick: number): string {
	if (phase === "complete") return theme.fg("success", "✓");
	if (phase === "streaming") return theme.fg("accent", SPINNER[tick % SPINNER.length] ?? SPINNER[0]);
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

function renderAgentBadge(theme: Theme, agent: string | undefined): string {
	const raw = agent && agent.length > 0 ? agent : "task";
	return agentBadgeColor(theme, raw, pad(raw, 8));
}

function emptySession(sessionId: string, role: SessionRole, order: number, ctx: ExtensionContext, pi: ExtensionAPI): SessionThroughput {
	const timestamp = Date.now();
	return {
		sessionId,
		role,
		order,
		label: sessionLabel(ctx),
		model: modelLabel(ctx),
		thinkingLevel: String(pi.getThinkingLevel()),
		phase: "waiting",
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
	let uiTimer: NodeJS.Timeout | number | undefined;
	let uiTick = 0;
	const nameToAgent = new Map<string, string>();
	let cachedCols = -1;
	let cachedLabelWidth = 0;
	let cachedModelWidth = 0;

	function removeCurrentState(): void {
		if (!state) return;
		registry.sessions.delete(state.sessionId);
		if (registry.mainSessionId === state.sessionId) {
			registry.mainSessionId = undefined;
		}
		state = undefined;
	}

	function ensureState(ctx: ExtensionContext): SessionThroughput {
		const sessionId = ctx.sessionManager.getSessionId();
		if (state?.sessionId === sessionId) {
			state.label = sessionLabel(ctx);
			state.model = modelLabel(ctx);
			state.thinkingLevel = String(pi.getThinkingLevel());
			registry.sessions.set(sessionId, state);
			return state;
		}

		removeCurrentState();
		if (registry.mainSessionId === undefined || !registry.sessions.has(registry.mainSessionId)) {
			registry.mainSessionId = sessionId;
		}
		state = emptySession(
			sessionId,
			registry.mainSessionId === sessionId ? "main" : "worker",
			registry.nextOrder++,
			ctx,
			pi,
		);
		registry.sessions.set(sessionId, state);
		return state;
	}

	function pruneWorkers(timestamp: number): void {
		for (const [sessionId, worker] of registry.sessions) {
			if (worker.role !== "worker") continue;
			const completedExpired =
				worker.phase === "complete" &&
				worker.completedAt !== undefined &&
				timestamp - worker.completedAt > COMPLETED_RETENTION_MS;
			const stale = timestamp - worker.updatedAt > STALE_SESSION_MS;
			if (completedExpired || stale) registry.sessions.delete(sessionId);
		}
	}

	function workerRow(
		theme: Theme,
		worker: SessionThroughput,
		labelWidth: number,
		modelWidth: number,
		scale: number,
		timestamp: number,
	): string {
		refreshAvgTps(worker, timestamp);
		const isComplete = worker.phase === "complete";
		const icon = renderStatusIcon(theme, worker.phase, uiTick);
		const label = pad(worker.label, labelWidth);
		const styledLabel = isComplete ? theme.fg("dim", label) : theme.fg("accent", label);
		const model = theme.fg("dim", pad(`${worker.model}:${worker.thinkingLevel}`, modelWidth));
		const badge = renderAgentBadge(theme, nameToAgent.get(worker.label));
		const totalTokens = formatTokens(worker.totalTokens + (worker.messageOpen ? worker.messageTokens : 0));
		const dimSeparator = theme.fg("dim", "·");
		const tps = worker.avgTps;
		const gauge = renderGauge(theme, tps, scale, WORKER_GAUGE_WIDTH);
		const rateStr = pad(`${formatRate(tps)} tps`, 9);
		const styledRate = tps > 0 ? speedColor(theme, tps, rateStr) : theme.fg("dim", rateStr);
		const since = theme.fg("dim", sinceLabel(worker, timestamp));
		return `${icon} ${styledLabel}  ${badge}  ${model}  ${gauge}  ${styledRate}  ${dimSeparator}  ${theme.fg("dim", totalTokens)}  ${dimSeparator}  ${since}`;
	}

	function renderPanel(ctx: ExtensionContext): void {
		const timestamp = Date.now();
		pruneWorkers(timestamp);
		const main = ensureState(ctx);
		refreshAvgTps(main, timestamp);
		const workers = [...registry.sessions.values()]
			.filter((candidate) => candidate.role === "worker" && candidate.sessionId !== main.sessionId)
			.sort((left, right) => {
				if (left.phase === "complete" && right.phase !== "complete") return 1;
				if (right.phase === "complete" && left.phase !== "complete") return -1;
				return left.order - right.order;
			});

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
		const cols = process.stdout.columns ?? 100;
		if (cols !== cachedCols) {
			cachedCols = cols;
			const terminalWidth = Math.max(60, cols);
			cachedLabelWidth = Math.min(24, Math.max(12, Math.floor((terminalWidth - 58) * 0.45)));
			cachedModelWidth = Math.min(24, Math.max(14, terminalWidth - cachedLabelWidth - 52));
		}
		const headerTps = main.avgTps;
		const headerParts: string[] = [];
		const chip =
			(
				(globalThis as Record<symbol, unknown>)[SESSION_MODE_KEY] as
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
		const header = headerParts.join(" ");
		const shownWorkers = workers.slice(0, MAX_WORKER_ROWS);
		const lines = [
			header,
			...shownWorkers.map((worker) =>
				workerRow(theme, worker, cachedLabelWidth, cachedModelWidth, workerScale, timestamp),
			),
		];
		if (workers.length > shownWorkers.length) {
			lines.push(theme.fg("dim", `  … ${workers.length - shownWorkers.length} more workers`));
		}
		ctx.ui.setWidget("throughput-workers", lines, { placement: "aboveEditor" });
	}

	function renderUi(ctx: ExtensionContext): void {
		uiTick++;
		renderPanel(ctx);
	}

	function startUi(ctx: ExtensionContext): void {
		const current = ensureState(ctx);
		if (current.role !== "main") return;
		clearInterval(uiTimer);
		uiTimer = setInterval(() => renderUi(ctx), UI_INTERVAL_MS);
		renderUi(ctx);
	}

	function stopUi(ctx: ExtensionContext): void {
		clearInterval(uiTimer);
		uiTimer = undefined;
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

	pi.on("tool_call", (event) => {
		if (event.toolName !== "task") return;
		if (!("input" in event) || !event.input || typeof event.input !== "object") return;
		const input = event.input;
		const record = (name: unknown, agent: unknown): void => {
			if (typeof name === "string" && name) {
				nameToAgent.set(name, typeof agent === "string" && agent ? agent : "task");
			}
		};
		if ("tasks" in input && Array.isArray(input.tasks)) {
			for (const item of input.tasks) {
				if (item && typeof item === "object") {
					const name = "name" in item ? item.name : undefined;
					const agent = "agent" in item ? item.agent : undefined;
					record(name, agent);
				}
			}
		} else {
			const name = "name" in input ? input.name : undefined;
			const agent = "agent" in input ? input.agent : undefined;
			record(name, agent);
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopUi(ctx);
		removeCurrentState();
	});
}
