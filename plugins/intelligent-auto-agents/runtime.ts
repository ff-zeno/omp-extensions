// Routing runtime; loaded by index.ts only on OMP with subagent routing API v2.
// Routing policy belongs here; OMP core owns dispatch and effort transport.
import { TypeSafeJudge, scopeAntigravityLimitsForModel, type UsageReport } from "@oh-my-pi/pi-ai";
import * as PiAi from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, getSupportedEfforts } from "@oh-my-pi/pi-coding-agent";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import catalogData from "./catalog.json";
import {
	capEffort,
	choose,
	type Decision,
	type Difficulty,
	DIFFICULTY_NAMES,
	effortForModel,
	type Effort,
	type EffortRange,
	type Evaluate,
	evaluatePlanningReadiness,
	fitEffort,
	isLiteralModel,
	type ModelRef,
	ORDINARY,
	parseCatalog,
	parseDirective,
	type Persona,
	type PlanProvenance,
	planProvenance,
	type PoolMember,
	type PoolUsage,
	type PoolVerdict,
	preferPlanReviewMembers,
	rankPool,
	RoutingAuthenticationError,
	taskTypeEffortVaries,
	type UsageSummary,
} from "./routing";

const catalog = parseCatalog(catalogData);
const STATE_ENTRY = "intelligent-auto-agents-state";
/**
 * Persona suggestions shared with the session-persona plugin through a process-wide registry keyed
 * `<parent agent id>:<child agent id>`. That plugin applies one only when the parent named no persona
 * and deletes it when the child starts; unclaimed entries expire.
 */
const PERSONA_SUGGESTIONS = Symbol.for("omp.persona-suggestions.v1");
const PERSONA_SUGGESTION_TTL_MS = 60_000;
type PersonaSuggestion = { persona: Persona; createdAt: number };

function suggestPersona(parentId: string, childId: string, persona: Persona): void {
	const store = globalThis as typeof globalThis & { [PERSONA_SUGGESTIONS]?: Map<string, PersonaSuggestion> };
	const suggestions = (store[PERSONA_SUGGESTIONS] ??= new Map());
	const now = Date.now();
	for (const [key, entry] of suggestions) {
		if (now - entry.createdAt > PERSONA_SUGGESTION_TTL_MS) suggestions.delete(key);
	}
	suggestions.set(`${parentId}:${childId}`, { persona, createdAt: now });
}

/** Jev's persona under the catalog ceiling: brute needs a rated difficulty no higher than `maxDifficulty`. */
function cappedPersona(decision: Decision): Persona | undefined {
	if (decision.persona !== "brute") return decision.persona;
	if (decision.difficulty === undefined) return "normal";
	return DIFFICULTY_NAMES.indexOf(decision.difficulty) <= DIFFICULTY_NAMES.indexOf(catalog.personas.maxDifficulty)
		? "brute"
		: "normal";
}

type PoolReservation = {
	token: string;
	agent: string;
	member: string;
	counter: string;
	startedAt: number;
	claimedSessionId?: string;
	endedAt?: number;
};
type DemotionRecord = { failures: number; demotedUntil?: number };
type PoolUsageRegistry = {
	authStorage: {
		usage: {
			reports(options: {
				baseUrlResolver: (provider: string) => string | undefined;
				signal: AbortSignal;
			}): Promise<unknown>;
		};
		credentials: { credentials(provider: string): readonly unknown[] };
	};
	getProviderBaseUrl?: (provider: string) => string | undefined;
};
const poolReservations: PoolReservation[] = [];
const childReservationTokens = new Map<string, string>();
const poolDemotions = new Map<string, DemotionRecord>();
let reservationSequence = 0;
let inFlightPoolUsageReports: Promise<unknown> | undefined;
const RESERVATION_SAFETY_MS = 2 * 60 * 60 * 1000;

export function resetSpeedPoolStateForTests(): void {
	poolReservations.length = 0;
	childReservationTokens.clear();
	poolDemotions.clear();
	reservationSequence = 0;
	inFlightPoolUsageReports = undefined;
}
type PoolRouteReport = {
	status?: string;
	active?: string;
	order?: string[];
	skipped?: string[];
	demoted?: string[];
	verdicts?: Record<string, PoolVerdict>;
};
type RouteOption = {
	slot: string;
	model: ModelRef;
	exact: string;
	effort?: string;
};
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function poolUsageRegistry(ctx: ExtensionContext): PoolUsageRegistry | undefined {
	const candidateValue: unknown = ctx.modelRegistry;
	if (!record(candidateValue) || !record(candidateValue.authStorage)) return undefined;
	const authStorageValue = candidateValue.authStorage;
	if (!record(authStorageValue) || !record(authStorageValue.usage) || !record(authStorageValue.credentials)) return undefined;
	const usageValue = authStorageValue.usage;
	const credentialsValue = authStorageValue.credentials;
	if (typeof usageValue.reports !== "function" || typeof credentialsValue.credentials !== "function") return undefined;
	const candidate = candidateValue as unknown as PoolUsageRegistry;
	return candidate;
}

function isUsageReport(value: unknown): value is UsageReport {
	if (!record(value) || typeof value.provider !== "string" || !Number.isFinite(value.fetchedAt) || !Array.isArray(value.limits))
		return false;
	return value.limits.every(limit => {
		if (!record(limit) || typeof limit.id !== "string" || !record(limit.amount) || !record(limit.scope)) return false;
		return limit.window === undefined || record(limit.window);
	});
}

function isUsableOAuthCredential(value: unknown): boolean {
	let credential: unknown = value;
	if (record(value) && "credential" in value) {
		if (value.disabled === true || (value.disabledCause !== undefined && value.disabledCause !== null)) return false;
		credential = value.credential;
	}
	return record(credential) && credential.type === "oauth" && credential.disabled !== true;
}

function sharedPoolUsageReports(registry: PoolUsageRegistry): Promise<unknown> {
	if (!inFlightPoolUsageReports) {
		const timeoutSignal = AbortSignal.timeout(catalog.poolLimits.usageTimeoutMs);
		const pending = registry.authStorage.usage.reports({
			baseUrlResolver: provider => registry.getProviderBaseUrl?.(provider),
			signal: timeoutSignal,
		});
		inFlightPoolUsageReports = pending;
		void pending
			.finally(() => {
				if (inFlightPoolUsageReports === pending) inFlightPoolUsageReports = undefined;
			})
			.catch(() => {});
	}
	return inFlightPoolUsageReports;
}

async function awaitOwnSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
	if (!signal) return await promise;
	if (signal.aborted) return undefined;
	const aborted = Promise.withResolvers<undefined>();
	const onAbort = () => aborted.resolve(undefined);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const outcome = await Promise.race([
			promise.then(value => ({ ok: true as const, value })),
			aborted.promise.then(() => ({ ok: false as const })),
		]);
		return outcome.ok ? outcome.value : undefined;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function fetchPoolUsage(ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<PoolUsage | undefined> {
	const registry = poolUsageRegistry(ctx);
	if (!registry) return undefined;
	if (signal?.aborted) return undefined;
	let rawReports: unknown;
	try {
		rawReports = await awaitOwnSignal(sharedPoolUsageReports(registry), signal);
	} catch {
		return undefined;
	}
	if (signal?.aborted || !Array.isArray(rawReports)) return undefined;
	const reports = rawReports.filter(isUsageReport);
	const providers = new Set(reports.map(report => report.provider));
	const credentialCounts: Record<string, number> = {};
	for (const provider of providers) {
		try {
			const credentials = registry.authStorage.credentials.credentials(provider);
			credentialCounts[provider] = credentials.filter(isUsableOAuthCredential).length;
		} catch {
			return undefined;
		}
	}
	return { reports, credentialCounts };
}

function antigravityCounterKey(modelId: string): string | undefined {
	const exportsValue: unknown = PiAi;
	if (!record(exportsValue)) return undefined;
	const candidate = exportsValue.getAntigravityCounterKeyForModel;
	if (typeof candidate !== "function") return undefined;
	const counterKey = candidate(modelId);
	return typeof counterKey === "string" && counterKey.length > 0 ? counterKey : undefined;
}
function googleCounterKey(report: UsageReport, modelId: string): string | undefined {
	const counterKey = antigravityCounterKey(modelId);
	if (counterKey) {
		const prefix = `${report.provider}:${counterKey}:`.toLowerCase();
		if (report.limits.some(limit => limit.id.toLowerCase().startsWith(prefix)))
			return `${report.provider}:${counterKey}`;
		const defaultPrefix = `${report.provider}:default:`.toLowerCase();
		if (report.limits.some(limit => limit.id.toLowerCase().startsWith(defaultPrefix)))
			return `${report.provider}:default`;
		return undefined;
	}
	const limits = scopeAntigravityLimitsForModel(report, { modelId });
	const first = limits.find(limit => limit.id.startsWith(`${report.provider}:`));
	if (!first) return undefined;
	const remainder = first.id.slice(report.provider.length + 1);
	const key = remainder.split(":")[0];
	return key.length > 0 ? `${report.provider}:${key}` : undefined;
}

function counterForModel(model: ModelRef, reports: readonly UsageReport[]): string | undefined {
	if (model.provider === "xai-oauth") return "xai-oauth:aggregate";
	if (model.provider === "anthropic") return "anthropic:shared";
	if (model.provider === "google-antigravity") {
		for (const report of reports) {
			if (report.provider !== model.provider) continue;
			const counter = googleCounterKey(report, model.id);
			if (counter) return counter;
		}
		const counterKey = antigravityCounterKey(model.id);
		return counterKey ? `${model.provider}:${counterKey}` : undefined;
	}
	return `${model.provider}:${model.id}`;
}

function isAggregateCreditReport(report: UsageReport): boolean {
	return report.limits.some(limit => limit.id.startsWith("xai-oauth:credits:"));
}

function reservationMatchesReport(reservation: PoolReservation, report: UsageReport): boolean {
	const separator = reservation.member.indexOf("/");
	if (separator <= 0) return false;
	const model: ModelRef = {
		provider: reservation.member.slice(0, separator),
		id: reservation.member.slice(separator + 1),
	};
	if (report.provider !== model.provider) return false;
	if (model.provider === "xai-oauth")
		return reservation.counter === "xai-oauth:aggregate" && isAggregateCreditReport(report);
	if (model.provider === "anthropic") return reservation.counter === "anthropic:shared";
	if (model.provider === "google-antigravity") return googleCounterKey(report, model.id) === reservation.counter;
	return false;
}

function matchingReservationReports(
	reservation: PoolReservation,
	reports: readonly UsageReport[],
	credentialCounts: Readonly<Record<string, number>> | undefined,
): readonly UsageReport[] | undefined {
	const matching = reports.filter(report => reservationMatchesReport(reservation, report));
	const provider = reservation.member.slice(0, reservation.member.indexOf("/"));
	const expected = credentialCounts?.[provider];
	if (expected !== undefined && matching.length < expected) return undefined;
	return matching;
}
function removeReservation(index: number): void {
	const [reservation] = poolReservations.splice(index, 1);
	if (
		reservation?.claimedSessionId !== undefined &&
		childReservationTokens.get(reservation.claimedSessionId) === reservation.token
	)
		childReservationTokens.delete(reservation.claimedSessionId);
}

function pruneReservations(
	reports: readonly UsageReport[],
	credentialCounts: Readonly<Record<string, number>> | undefined,
	nowMs: number,
): void {
	for (let index = poolReservations.length - 1; index >= 0; index--) {
		const reservation = poolReservations[index];
		if (nowMs - reservation.startedAt >= RESERVATION_SAFETY_MS) {
			removeReservation(index);
			continue;
		}
		if (reservation.endedAt === undefined) continue;
		const matchingReports = matchingReservationReports(reservation, reports, credentialCounts);
		if (matchingReports !== undefined && matchingReports.length > 0 && matchingReports.every(report => report.fetchedAt > reservation.endedAt!))
			removeReservation(index);
	}
}

function poolPenalties(members: readonly PoolMember[], usage: PoolUsage, nowMs: number): ReadonlyMap<string, number> {
	pruneReservations(usage.reports, usage.credentialCounts, nowMs);
	const penalties = new Map<string, number>();
	for (const member of members) {
		const counter = member.counter ?? counterForModel(member.model, usage.reports);
		if (counter === undefined) {
			penalties.set(member.id, 0);
			continue;
		}
		const reservation: PoolReservation = {
			token: "",
			agent: "",
			member: `${member.model.provider}/${member.model.id}`,
			counter,
			startedAt: nowMs,
		};
		const matchingReports = matchingReservationReports(reservation, usage.reports, usage.credentialCounts);
		const oldestReport =
			matchingReports === undefined || matchingReports.length === 0
				? Number.NEGATIVE_INFINITY
				: matchingReports.reduce(
						(oldest, report) => Math.min(oldest, report.fetchedAt),
						Number.POSITIVE_INFINITY,
					);
		const reservations = poolReservations.filter(candidate => {
			if (candidate.counter !== counter) return false;
			if (candidate.endedAt === undefined) return true;
			return candidate.endedAt > oldestReport;
		});
		penalties.set(counter, reservations.length * catalog.poolLimits.burstPenalty);
	}
	return penalties;
}

function activeDemotions(nowMs: number): ReadonlySet<string> {
	const active = new Set<string>();
	for (const [member, state] of poolDemotions) {
		if (state.demotedUntil !== undefined && state.demotedUntil <= nowMs) {
			state.failures = 0;
			state.demotedUntil = undefined;
		}
		if (state.demotedUntil !== undefined) active.add(member);
	}
	return active;
}

function reservationToken(agent: string, member: string, counter: string, startedAt: number): PoolReservation {
	const reservation: PoolReservation = {
		token: `pool-${++reservationSequence}`,
		agent,
		member,
		counter,
		startedAt,
	};
	poolReservations.push(reservation);
	return reservation;
}

function childSessionId(ctx: ExtensionContext): string | undefined {
	const manager = ctx.sessionManager as unknown as { getSessionId?: () => string };
	const id = manager.getSessionId?.();
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function claimChildReservation(ctx: ExtensionContext): void {
	if (ctx.agent.kind !== "sub") return;
	const sessionId = childSessionId(ctx);
	if (!sessionId || childReservationTokens.has(sessionId)) return;
	const reservation = poolReservations
		.filter(candidate => candidate.claimedSessionId === undefined && candidate.agent === ctx.agent.name)
		.sort((left, right) => left.startedAt - right.startedAt)[0];
	if (!reservation) return;
	reservation.claimedSessionId = sessionId;
	childReservationTokens.set(sessionId, reservation.token);
}

function memberFromReservation(reservation: PoolReservation): ModelRef {
	const separator = reservation.member.indexOf("/");
	return {
		provider: reservation.member.slice(0, separator),
		id: reservation.member.slice(separator + 1),
	};
}

function settleChildReservation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: { messages: readonly unknown[]; willContinue?: boolean },
): void {
	if (ctx.agent.kind !== "sub" || event.willContinue === true) return;
	const sessionId = childSessionId(ctx);
	if (!sessionId) return;
	const token = childReservationTokens.get(sessionId);
	if (!token) return;
	const reservation = poolReservations.find(candidate => candidate.token === token);
	if (!reservation || reservation.endedAt !== undefined) return;
	const endedAt = Date.now();
	reservation.endedAt = endedAt;
	const lastAssistant = [...event.messages]
		.reverse()
		.find(message => record(message) && message.role === "assistant");
	let outcome: "success" | "failure" | "unchanged" = "unchanged";
	let reason = "no-assistant";
	let state = poolDemotions.get(reservation.member);
	if (lastAssistant && record(lastAssistant)) {
		if (lastAssistant.stopReason === "aborted") {
			reason = "aborted";
		} else {
			const member = memberFromReservation(reservation);
			const sameMember = lastAssistant.provider === member.provider && lastAssistant.model === member.id;
			if (lastAssistant.stopReason === "error" || !sameMember) {
				outcome = "failure";
				reason = lastAssistant.stopReason === "error" ? "error" : "rollover";
				if (state?.demotedUntil !== undefined && state.demotedUntil <= endedAt) {
					state = { failures: 0 };
					poolDemotions.delete(reservation.member);
				}
				state = state ?? { failures: 0 };
				state.failures++;
				if (state.failures >= catalog.poolLimits.failureDemoteAfter)
					state.demotedUntil = endedAt + catalog.poolLimits.demoteForMs;
				poolDemotions.set(reservation.member, state);
			} else {
				outcome = "success";
				reason = "completed";
				poolDemotions.delete(reservation.member);
			}
		}
	}
	const current = poolDemotions.get(reservation.member);
	pi.appendEntry("intelligent-auto-agents-pool", {
		token: reservation.token,
		member: reservation.member,
		outcome,
		reason,
		failureStreak: current?.failures ?? 0,
		...(current?.demotedUntil !== undefined ? { demotedUntil: current.demotedUntil } : {}),
	});
}


function thinkingLevel(effort: string): ThinkingLevel | undefined {
	return Object.values(ThinkingLevel).find(level => level === effort);
}
function formatUsage(usage: UsageSummary | undefined): string {
	if (!usage) return "";
	const tokens = usage.totalTokens === undefined ? "" : ` · ${usage.totalTokens} tok`;
	const cost = usage.cost === undefined ? "" : ` · $${usage.cost.toFixed(4)}`;
	return `${tokens}${cost}`;
}

function mergeUsage(...usages: Array<UsageSummary | undefined>): UsageSummary | undefined {
	const merged: UsageSummary = {};
	let hasUsage = false;
	for (const usage of usages) {
		if (!usage) continue;
		if (usage.inputTokens !== undefined) {
			merged.inputTokens = (merged.inputTokens ?? 0) + usage.inputTokens;
			hasUsage = true;
		}
		if (usage.outputTokens !== undefined) {
			merged.outputTokens = (merged.outputTokens ?? 0) + usage.outputTokens;
			hasUsage = true;
		}
		if (usage.totalTokens !== undefined) {
			merged.totalTokens = (merged.totalTokens ?? 0) + usage.totalTokens;
			hasUsage = true;
		}
		if (usage.cost !== undefined) {
			merged.cost = (merged.cost ?? 0) + usage.cost;
			hasUsage = true;
		}
	}
	return hasUsage ? merged : undefined;
}

function callerDetails(ctx: ExtensionContext): { callerAgent?: string; callerDepth?: number } {
	return ctx.agent.kind === "sub" ? { callerAgent: ctx.agent.name, callerDepth: ctx.agent.depth } : {};
}

function routingLabel(ctx: ExtensionContext): string {
	return ctx.agent.kind === "sub"
		? `Jev routing (from ${ctx.agent.name}, depth ${ctx.agent.depth})`
		: "Jev routing";
}
function retrySelector(model: { provider: string; id: string }, effort: string | undefined): string {
	return `${model.provider}/${model.id}${effort ? `:${effort}` : ""}`;
}

function selectorSuppressed(
	ctx: ExtensionContext,
	model: { provider: string; id: string },
	effort: string | undefined,
): boolean {
	const registry = ctx.modelRegistry as unknown as {
		isSelectorSuppressed?: (selector: string) => boolean;
	};
	return registry.isSelectorSuppressed?.(retrySelector(model, effort)) ?? false;
}

/** On-disk root of the session's `local://` protocol, mirroring OMP's own resolution. */
function localRoot(ctx: ExtensionContext): string {
	const options = ctx.localProtocolOptions;
	const artifacts = options?.getArtifactsDir?.();
	if (artifacts) return path.resolve(artifacts, "local");
	const raw = options?.getSessionId?.() ?? "session";
	const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, "_") || "session";
	return path.join(os.tmpdir(), "omp-local", safe);
}

/** The plan document a plan-review brief names: a `local://` path, else an `.md` path in the brief. */
function planDocumentPath(ctx: ExtensionContext, brief: string): string | undefined {
	const local = brief.match(/local:\/\/[^\s)"'`]+/);
	if (local) {
		const root = path.resolve(localRoot(ctx));
		const resolved = path.resolve(root, local[0].slice("local://".length));
		return resolved.startsWith(root) ? resolved : undefined;
	}
	const relative = brief.match(/(?:^|[\s(])([\w./~-]*[\w-]\.md)\b/);
	if (!relative) return undefined;
	return path.isAbsolute(relative[1]) ? relative[1] : path.resolve(ctx.cwd, relative[1]);
}

/** Read a plan document's front matter, or undefined when it cannot be located or parsed. */
function readPlanProvenance(ctx: ExtensionContext, brief: string): PlanProvenance | undefined {
	const file = planDocumentPath(ctx, brief);
	if (!file) return undefined;
	try {
		return planProvenance(readFileSync(file, "utf8"), catalog.planMetadata);
	} catch {
		return undefined;
	}
}

export function register(pi: ExtensionAPI): void {
	let enabled = catalog.enabled;
	let lastLine: string | undefined;

	function restore(ctx: ExtensionContext): void {
		enabled = catalog.enabled;
		lastLine = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "custom" &&
				entry.customType === STATE_ENTRY &&
				entry.data &&
				typeof entry.data === "object" &&
				"enabled" in entry.data &&
				typeof entry.data.enabled === "boolean"
			)
				enabled = entry.data.enabled;
		}
		ctx.ui.setStatus("auto-agents", enabled ? "Auto-agents: on" : "Auto-agents: off");
	}
	function evaluator(ctx: ExtensionContext): Evaluate {
		return async (request, signal) => {
			const apiKey =
				(await ctx.modelRegistry.getApiKeyForProvider("typesafe", undefined, { signal })) ??
				process.env.TYPESAFE_API_KEY;
			if (!apiKey) throw new RoutingAuthenticationError();
			return new TypeSafeJudge({ apiKey, model: catalog.jevModel, timeoutMs: catalog.timeoutMs }).judge(request, {
				signal,
			});
		};
	}

	function setActivity(ctx: ExtensionContext, message: string): void {
		if (ctx.hasUI) ctx.ui.setStatus("auto-agents", message);
	}

	function reportSkipped(ctx: ExtensionContext, agent: string, reason: string, message: string): void {
		pi.appendEntry("intelligent-auto-agents-decision", {
			source: "baseline",
			reason,
			agent,
			...callerDetails(ctx),
			catalogVersion: catalog.version,
			jevModel: catalog.jevModel,
		});
		lastLine = message;
		setActivity(ctx, message);
	}

	async function withJevActivity<T>(
		ctx: ExtensionContext,
		activity: string,
		run: () => Promise<T>,
	): Promise<{ result: T; latencyMs: number }> {
		const startedAt = performance.now();
		if (ctx.hasUI) {
			ctx.ui.setWorkingMessage(`🧠 Jev: ${activity}…`);
			setActivity(ctx, `Jev ${activity} · 0s`);
		}
		const timer = ctx.hasUI
			? setInterval(() => {
					setActivity(ctx, `Jev ${activity} · ${Math.floor((performance.now() - startedAt) / 1000)}s`);
				}, 1000)
			: undefined;
		let result: T;
		try {
			result = await run();
		} finally {
			clearInterval(timer);
			if (ctx.hasUI) {
				ctx.ui.setWorkingMessage();
				setActivity(ctx, enabled ? "Auto-agents: on" : "Auto-agents: off");
			}
		}
		return { result, latencyMs: Math.round(performance.now() - startedAt) };
	}

	function reportDecision(
		ctx: ExtensionContext,
		decision: Decision,
		agent: string,
		route: {
			slot?: string;
			model?: string;
			thinking?: string;
			difficulty?: Difficulty;
			directive?: string;
			backups?: Array<{ slot: string; model: string; thinking: string }>;
			rollover?: { from: string; to: string };
			pool?: PoolRouteReport;
			/** Persona handed to session-persona after the catalog ceiling; overrides Jev's raw pick. */
			persona?: Persona;
		},
		latencyMs: number,
	): string {
		// Persist only routing metadata; task text, credentials, and provider errors stay transient.
		pi.appendEntry("intelligent-auto-agents-decision", {
			...decision,
			agent,
			...route,
			latencyMs,
			...callerDetails(ctx),
			catalogVersion: catalog.version,
			jevModel: catalog.jevModel,
		});
		const latency = `${latencyMs}ms`;
		const usage = formatUsage(decision.usage);
		// A suggestion only: an explicit parent persona still wins in session-persona.
		const persona = route.persona === "brute" ? " · suggests brute persona" : "";
		if (decision.source !== "baseline") {
			const slot = route.slot ?? decision.choice;
			const target = route.model || route.thinking ? ` · ${route.model ?? "bound model"}:${route.thinking ?? "default"}` : "";
			const difficulty = route.difficulty === undefined ? "" : ` · ${route.difficulty}`;
			const confidence =
				decision.confidence === undefined ? "" : ` · ${Math.round(decision.confidence * 100)}%`;
			const source = decision.source === "catalog" ? " · fixed" : "";
			const backup = route.backups?.length ? ` · backup ${route.backups.map(entry => entry.slot).join(" > ")}` : "";
			const rollover = route.rollover ? ` · ${route.rollover.from} cooling down → ${route.rollover.to}` : "";
			const pool =
				route.pool?.status === "no-usage"
					? " · pool: no-usage"
					: route.pool?.active
						? ` · pool ${route.pool.active}`
						: "";
			lastLine = `${routingLabel(ctx)}: ${agent}: ${slot ?? "effort"}${target}${difficulty}${confidence}${source}${backup}${rollover}${pool}${persona} · ${latency}${usage}`;
			return lastLine;
		}
		const reason = decision.reason.replaceAll("-", " ");
		lastLine = `${routingLabel(ctx)}: fallback · ${reason} · baseline kept${persona} · ${latency}${usage}`;
		setActivity(ctx, lastLine);
		return lastLine;
	}

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		claimChildReservation(ctx);
	});
	pi.on("agent_end", (event, ctx) => settleChildReservation(pi, ctx, event));
	pi.on("session_shutdown", (_event, _ctx) => pruneReservations([], Date.now()));
	pi.on("session_switch", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.registerCommand("auto-agents", {
		description: "Show routing status or set on/off for this session; never changes the chat model",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "on" || action === "off") {
				enabled = action === "on";
				pi.appendEntry(STATE_ENTRY, { enabled });
				ctx.ui.setStatus("auto-agents", enabled ? "Auto-agents: on" : "Auto-agents: off");
			} else if (action && action !== "status") {
				ctx.ui.notify("Usage: /auto-agents [on|off|status]", "warning");
				return;
			}
			ctx.ui.notify(
				`Auto-agents ${enabled ? "on" : "off"} · catalog v${catalog.version} · Jev ${catalog.jevModel}; ${lastLine ?? "no routing decision yet"}. Chat model unchanged.`,
				"info",
			);
		},
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		let readinessUsage: UsageSummary | undefined;
		if (catalog.planningReadiness.agents.includes(event.agent) && ctx.agent.kind === "main") {
			const { result: readiness, latencyMs } = await withJevActivity(ctx, "checking planning readiness", () =>
				evaluatePlanningReadiness(event.assignment, catalog, evaluator(ctx), event.signal),
			);
			readinessUsage = readiness.usage;
			if (readiness.route === "discuss-with-user") {
				const reason = `[JEV Intercept] Planning request was not cleared for autonomous planning (${readiness.reason}). Clarify tradeoffs with the user in main chat before delegating to an autonomous planner.`;
				const decision: Decision = {
					source: "jev",
					choice: readiness.route,
					confidence: readiness.confidence,
					reason: readiness.reason,
					...(readiness.usage ? { usage: readiness.usage } : {}),
				};
				pi.appendEntry("intelligent-auto-agents-decision", {
					...decision,
					agent: event.agent,
					latencyMs,
					...callerDetails(ctx),
					catalogVersion: catalog.version,
					jevModel: catalog.jevModel,
				});
				lastLine = `${routingLabel(ctx)}: planning paused · clarify with user · ${latencyMs}ms${formatUsage(readiness.usage)}`;
				if (ctx.hasUI) ctx.ui.notify(`${lastLine}. ${reason}`, "warning");
				return { block: true, reason };
			}
		}
		if (!enabled) {
			reportSkipped(ctx, event.agent, "routing-off", `Jev routing off · ${event.agent} · baseline kept`);
			return;
		}
		if (event.modelLocked || event.effortLocked) {
			const lock = event.modelLocked ? "model locked" : "effort locked";
			reportSkipped(
				ctx,
				event.agent,
				event.modelLocked ? "model-locked" : "effort-locked",
				`Jev skipped · ${event.agent} · ${lock} · baseline kept`,
			);
			return;
		}
		const pinned = catalog.agents.pinned.includes(event.agent);
		const covered = catalog.agents.covered.includes(event.agent);
		if (!pinned && !covered) {
			reportSkipped(ctx, event.agent, "unknown-agent", `Jev skipped · ${event.agent} · unknown agent · baseline kept`);
			return;
		}
		const solutionSpace = "solutionSpace" in event ? event.solutionSpace : undefined;
		const state = [
			JSON.stringify({
				agent: event.agent,
				task: event.assignment,
				context: event.context ?? "",
				...(typeof solutionSpace === "string" && solutionSpace.trim().length > 0 ? { solutionSpace } : {}),
			}),
			"",
			"Routing guidance:",
			...catalog.nuances,
		].join("\n");
		const withReadiness = (decision: Decision): Decision => {
			const usage = mergeUsage(readinessUsage, decision.usage);
			return usage ? { ...decision, usage } : decision;
		};
		const available = ctx.models.list();
		const resolveModel = (spec: string): ModelRef | undefined => {
			const model = ctx.models.resolve(spec);
			return model && available.some(candidate => candidate.provider === model.provider && candidate.id === model.id)
				? model
				: undefined;
		};

		// Pinned agents keep their bound model; Jev sets only effort from the model's map.
		if (pinned) {
			const pattern = event.patterns[0] ?? (event.modelRole ? `@${event.modelRole}` : undefined);
			const model = pattern ? ctx.models.resolve(pattern) : undefined;
			const supported = model ? getSupportedEfforts(model) : [];
			if (!model || !supported.length) {
				reportSkipped(
					ctx,
					event.agent,
					"no-routable-effort",
					`Jev skipped · ${event.agent} · bound model has no routable effort · baseline kept`,
				);
				return;
			}
			const { result: decision, latencyMs } = await withJevActivity(ctx, `rating ${event.agent} difficulty`, () =>
				choose(state, [], true, false, catalog, evaluator(ctx), event.signal),
			);
			const merged = withReadiness(decision);
			const difficulty = merged.difficulty ?? ORDINARY;
			const effort =
				merged.source === "baseline"
					? undefined
					: effortForModel(catalog, `${model.provider}/${model.id}`, difficulty, undefined, supported);
			if (!effort) {
				reportDecision(ctx, merged, event.agent, { slot: "pinned" }, latencyMs);
				return;
			}
			const bound = `${model.provider}/${model.id}`;
			return {
				thinkingLevel: thinkingLevel(effort),
				note: reportDecision(
					ctx,
					merged,
					event.agent,
					{ slot: "pinned", model: bound, thinking: effort, difficulty: merged.difficulty },
					latencyMs,
				),
			};
		}

		// Covered agents: directive > pool > fixed task-type model > bound model.
		const directive = parseDirective(event.assignment);
		let directiveModel: string | undefined;
		let directiveRole: string | undefined;
		let directiveEffort: Effort | undefined;
		let directiveTaskType: string | undefined;
		if (directive) {
			const alias = catalog.directiveTargets[directive.target];
			if (alias) {
				directiveModel = alias;
				directiveRole = directive.target;
			} else if (isLiteralModel(directive.target)) {
				directiveModel = directive.target;
				directiveRole = directive.target;
			} else if (directive.target in catalog.taskTypes) {
				directiveTaskType = directive.target;
			}
			directiveEffort = directive.effort;
		}

		let taskTypeName = directiveTaskType;
		const needsTaskChoice = directiveModel === undefined && taskTypeName === undefined;
		const candidates = needsTaskChoice ? Object.keys(catalog.taskTypes) : [];
		if (needsTaskChoice && candidates.length === 1) taskTypeName = candidates[0];

		let decision: Decision = { source: "catalog", reason: "fixed" };
		let latencyMs = 0;
		const offered =
			needsTaskChoice && candidates.length > 1
				? candidates.map(name => ({ id: name, description: catalog.taskTypes[name].description }))
				: [];
		const rateDifficulty = directiveModel
			? directiveEffort === undefined
			: taskTypeName !== undefined
				? taskTypeEffortVaries(catalog, taskTypeName)
				: candidates.some(name => taskTypeEffortVaries(catalog, name));
		// The child's agent id is the spawn key for task and workpool spawns; without one the child cannot claim a suggestion.
		const personaKey =
			ctx.agent.id !== undefined && event.spawnKey !== undefined && catalog.personas.agents.includes(event.agent)
				? { parent: ctx.agent.id, child: event.spawnKey }
				: undefined;
		if (offered.length > 1 || rateDifficulty || personaKey) {
			({ result: decision, latencyMs } = await withJevActivity(
				ctx,
				offered.length > 1 ? `classifying ${event.agent} task type` : `rating ${event.agent} difficulty`,
				() => choose(state, offered, rateDifficulty, personaKey !== undefined, catalog, evaluator(ctx), event.signal),
			));
		}
		decision = withReadiness(decision);
		const persona = personaKey ? cappedPersona(decision) : undefined;
		if (personaKey && persona) suggestPersona(personaKey.parent, personaKey.child, persona);
		const personaRoute = persona ? { persona } : {};
		if (needsTaskChoice && candidates.length > 1) {
			if (decision.source === "baseline") {
				reportDecision(ctx, decision, event.agent, personaRoute, latencyMs);
				return;
			}
			taskTypeName = decision.choice;
		}
		if (taskTypeName === undefined && directiveModel === undefined) {
			reportDecision(ctx, decision, event.agent, personaRoute, latencyMs);
			return;
		}
		const difficulty = decision.difficulty ?? ORDINARY;
		const boundPattern = event.patterns[0] ?? (event.modelRole ? `@${event.modelRole}` : undefined);
		const boundModel = boundPattern ? ctx.models.resolve(boundPattern) : undefined;
		const attempts: RouteOption[] = [];
		let poolMembers: PoolMember[] = [];
		let poolRoute: PoolRouteReport | undefined;
		let planNote = "";
		const optionForModel = (spec: string, range: EffortRange | undefined, pinnedEffort?: Effort): RouteOption | undefined => {
			const model = resolveModel(spec);
			if (!model) return undefined;
			const exact = `${model.provider}/${model.id}`;
			const supported = getSupportedEfforts(model);
			const effort = pinnedEffort
				? fitEffort(capEffort(catalog, exact, pinnedEffort), supported)
				: effortForModel(catalog, exact, difficulty, range, supported);
			return effort ? { slot: spec, model, exact, effort } : undefined;
		};
		const pushUnique = (option: RouteOption | undefined) => {
			if (option && !attempts.some(existing => existing.exact === option.exact)) attempts.push(option);
		};

		if (directiveModel) {
			pushUnique(optionForModel(directiveModel, undefined, directiveEffort));
		} else {
			const taskType = catalog.taskTypes[taskTypeName as string];
			if (taskType.pool) {
				const pool = catalog.pools[taskType.pool];
				poolMembers = pool.members.flatMap(spec => {
					const model = resolveModel(spec.model);
					if (!model) return [];
					const counter = counterForModel(model, []);
					return [
						{
							id: spec.id ?? `${model.provider}/${model.id}`,
							model,
							...(spec.effort !== undefined ? { effort: spec.effort } : {}),
							...(spec.difficulties !== undefined ? { difficulties: spec.difficulties } : {}),
							...(spec.maxShortUsed !== undefined ? { maxShortUsed: spec.maxShortUsed } : {}),
							...(spec.minWeeklyHeadroom !== undefined ? { minWeeklyHeadroom: spec.minWeeklyHeadroom } : {}),
							...(spec.minMonthlyHeadroom !== undefined ? { minMonthlyHeadroom: spec.minMonthlyHeadroom } : {}),
							...(counter !== undefined ? { counter } : {}),
							penaltyKind:
								catalog.poolLimits.burstPenaltyWindow[model.provider] ??
								catalog.poolLimits.burstPenaltyWindow["*"],
						} satisfies PoolMember,
					];
				});
				const scoped = poolMembers.filter(
					member => member.difficulties === undefined || member.difficulties.includes(difficulty),
				);
				let ordered = scoped;
				if (pool.excludePlanAuthors) {
					const provenance = readPlanProvenance(ctx, event.assignment);
					const preference = preferPlanReviewMembers(scoped, provenance);
					ordered = preference.members;
					if (preference.unknown) planNote = " · plan author unknown";
					else if (preference.excluded.length)
						planNote = ` · plan authors excluded ${preference.excluded.join(", ")}`;
				}
				const usage = await fetchPoolUsage(ctx, event.signal);
				const byId = new Map(ordered.map(member => [member.id, member]));
				const nowMs = Date.now();
				const rank = usage
					? rankPool(ordered, usage, poolPenalties(scoped, usage, nowMs), activeDemotions(nowMs), catalog.poolLimits, nowMs)
					: undefined;
				poolRoute = rank
					? { order: [], skipped: rank.skipped, demoted: rank.demoted, verdicts: rank.verdicts }
					: { status: "no-usage" };
				const orderIds = rank ? rank.order : ordered.map(member => member.id);
				for (const id of orderIds) {
					const member = byId.get(id);
					if (!member) continue;
					const modelId = `${member.model.provider}/${member.model.id}`;
					const supported = getSupportedEfforts(member.model);
					const effort = member.effort
						? fitEffort(capEffort(catalog, modelId, member.effort), supported)
						: effortForModel(catalog, modelId, difficulty, taskType.effort, supported);
					if (effort) pushUnique({ slot: id, model: member.model, exact: modelId, effort });
				}
				if (!attempts.length) pushUnique(optionForModel(pool.fallback.model, taskType.effort, pool.fallback.effort));
			} else if (taskType.model) {
				pushUnique(optionForModel(taskType.model, taskType.effort));
				for (const backup of taskType.backups ?? []) pushUnique(optionForModel(backup, taskType.effort));
			} else if (boundModel) {
				pushUnique(optionForModel(`${boundModel.provider}/${boundModel.id}`, taskType.effort));
			}
		}
		if (!attempts.length) {
			reportDecision(ctx, decision, event.agent, personaRoute, latencyMs);
			return;
		}
		const firstUnblocked = selectorSuppressed(ctx, attempts[0].model, attempts[0].effort)
			? Math.max(0, attempts.findIndex(option => !selectorSuppressed(ctx, option.model, option.effort)))
			: 0;
		const rolledOver = firstUnblocked > 0;
		const active = attempts[firstUnblocked];
		const rest = rolledOver ? attempts.slice(firstUnblocked + 1) : attempts.slice(1);
		const model = [active.exact, ...rest.map(option => `${option.exact}:${option.effort}`)];
		if (poolRoute) {
			poolRoute.active = active.exact;
			poolRoute.order = attempts.map(option => option.exact);
		}
		const activePoolMember = poolMembers.find(member => `${member.model.provider}/${member.model.id}` === active.exact);
		if (activePoolMember) {
			const counter = activePoolMember.counter ?? counterForModel(activePoolMember.model, []);
			if (counter !== undefined) reservationToken(event.agent, active.exact, counter, Date.now());
		}
		return {
			model,
			thinkingLevel: active.effort ? thinkingLevel(active.effort) : ThinkingLevel.Off,
			note:
				reportDecision(
					ctx,
					decision,
					event.agent,
					{
						slot: taskTypeName ?? "bound",
						model: active.exact,
						thinking: active.effort ?? "off",
						difficulty: decision.difficulty,
						...(directive ? { directive: directive.span } : {}),
						...(poolRoute ? { pool: poolRoute } : {}),
						...(rolledOver ? { rollover: { from: attempts[0].exact, to: active.slot } } : {}),
						...personaRoute,
					},
					latencyMs,
				) + planNote,
		};
	});
}
