// Routing runtime; loaded by index.ts only on OMP with subagent routing API v2.
// Routing policy belongs here; OMP core owns dispatch and effort transport.
import { TypeSafeJudge, scopeAntigravityLimitsForModel, type UsageReport } from "@oh-my-pi/pi-ai";
import * as PiAi from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, getSupportedEfforts } from "@oh-my-pi/pi-coding-agent";
import catalogData from "./catalog.json";
import {
	choose,
	type Decision,
	effortVaries,
	type Evaluate,
	evaluatePlanningReadiness,
	fitEffort,
	type ModelRef,
	ORDINARY,
	parseCatalog,
	type PoolMember,
	type PoolUsage,
	type PoolVerdict,
	RoutingAuthenticationError,
	type UsageSummary,
	rankPool,
} from "./routing";

const catalog = parseCatalog(catalogData);
const STATE_ENTRY = "intelligent-auto-agents-state";
/** Short names for difficulty levels, taken from the text before the colon in each ladder entry. */
const DIFFICULTY_NAMES = catalog.difficulty.map(entry => entry.split(":")[0].trim().toLowerCase());
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
const RESERVATION_SAFETY_MS = 2 * 60 * 60 * 1000;

export function resetSpeedPoolStateForTests(): void {
	poolReservations.length = 0;
	childReservationTokens.clear();
	poolDemotions.clear();
	reservationSequence = 0;
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

async function fetchPoolUsage(ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<PoolUsage | undefined> {
	const registry = poolUsageRegistry(ctx);
	if (!registry) return undefined;
	const timeoutSignal = AbortSignal.timeout(catalog.speedPoolLimits.usageTimeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	let rawReports: unknown;
	try {
		rawReports = await registry.authStorage.usage.reports({
			baseUrlResolver: provider => registry.getProviderBaseUrl?.(provider),
			signal: requestSignal,
		});
	} catch {
		return undefined;
	}
	if (!Array.isArray(rawReports)) return undefined;
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
		penalties.set(counter, reservations.length * catalog.speedPoolLimits.burstPenalty);
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
				if (state.failures >= catalog.speedPoolLimits.failureDemoteAfter)
					state.demotedUntil = endedAt + catalog.speedPoolLimits.demoteForMs;
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
			difficulty?: number;
			backups?: Array<{ slot: string; model: string; thinking: string }>;
			rollover?: { from: string; to: string };
			pool?: PoolRouteReport;
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
		if (decision.source !== "baseline") {
			const slot = route.slot ?? decision.choice;
			const target = route.model || route.thinking ? ` · ${route.model ?? "bound model"}:${route.thinking ?? "default"}` : "";
			const difficulty = route.difficulty === undefined ? "" : ` · ${DIFFICULTY_NAMES[route.difficulty]}`;
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
			lastLine = `${routingLabel(ctx)}: ${agent}: ${slot ?? "effort"}${target}${difficulty}${confidence}${source}${backup}${rollover}${pool} · ${latency}${usage}`;
			return lastLine;
		}
		const reason = decision.reason.replaceAll("-", " ");
		lastLine = `${routingLabel(ctx)}: fallback · ${reason} · baseline kept · ${latency}${usage}`;
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
				`Auto-agents ${enabled ? "on" : "off"}; Jev ${catalog.jevModel}; ${lastLine ?? "no routing decision yet"}. Chat model unchanged.`,
				"info",
			);
		},
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		let readinessUsage: UsageSummary | undefined;
		if (event.agent === "plan" && ctx.agent.kind === "main") {
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
		const profiles = catalog.profiles.filter(profile => profile.agents.includes(event.agent));
		if (!profiles.length) {
			reportSkipped(ctx, event.agent, "no-slot", `Jev skipped · no slot for ${event.agent} · baseline kept`);
			return;
		}
		const state = JSON.stringify({ agent: event.agent, task: event.assignment, context: event.context ?? "" });
		const withReadiness = (decision: Decision): Decision => {
			const usage = mergeUsage(readinessUsage, decision.usage);
			return usage ? { ...decision, usage } : decision;
		};

		// Seat: the agent keeps its bound model; only effort is routed.
		const seat = profiles.find(profile => profile.model === undefined);
		if (seat) {
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
			let decision: Decision = { source: "catalog", reason: "fixed" };
			let latencyMs = 0;
			if (effortVaries(seat)) {
				({ result: decision, latencyMs } = await withJevActivity(ctx, `rating ${event.agent} difficulty`, () =>
					choose(state, [], true, catalog, evaluator(ctx), event.signal),
				));
			}
			decision = withReadiness(decision);
			const level = decision.difficulty ?? ORDINARY;
			const effort = fitEffort(seat.effort[level], supported);
			if (decision.source === "baseline" || !effort) {
				reportDecision(ctx, decision, event.agent, { slot: seat.id }, latencyMs);
				return;
			}
			const bound = `${model.provider}/${model.id}`;
			return {
				thinkingLevel: thinkingLevel(effort),
				note: reportDecision(
					ctx,
					decision,
					event.agent,
					{ slot: seat.id, model: bound, thinking: effort, difficulty: decision.difficulty },
					latencyMs,
				),
			};
		}

		// Model slots: each names a binding; Jev picks the job when several compete.
		const available = ctx.models.list();
		const slots = profiles.flatMap(profile => {
			const model = profile.model ? ctx.models.resolve(profile.model) : undefined;
			if (!model || !available.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return [];
			const backups = (profile.backups ?? []).flatMap(backupId => {
				const backupProfile = catalog.profiles.find(candidate => candidate.id === backupId);
				const backupModel = backupProfile?.model ? ctx.models.resolve(backupProfile.model) : undefined;
				return backupProfile &&
					backupModel &&
					available.some(candidate => candidate.provider === backupModel.provider && candidate.id === backupModel.id)
					? [{ profile: backupProfile, model: backupModel }]
					: [];
			});
			return [{ profile, model, backups }];
		});
		if (!slots.length) {
			reportSkipped(ctx, event.agent, "no-bound-model", `Jev unavailable · no bound model for ${event.agent} · baseline kept`);
			return;
		}
		const rate = slots.some(({ profile }) => effortVaries(profile));
		let decision: Decision = { source: "catalog", reason: "fixed" };
		let latencyMs = 0;
		const rankBackups = slots.some(({ backups }) => backups.length > 1);
		if (slots.length > 1 || rate || rankBackups) {
			const offered = slots.map(({ profile, backups }) => ({
				id: profile.id,
				description: profile.description,
				...(backups.length
					? { backups: backups.map(({ profile: backup }) => ({ id: backup.id, description: backup.description })) }
					: {}),
			}));
			const activity = slots.length > 1
				? `classifying ${slots.length} ${event.agent} slots`
				: rankBackups
					? `ranking ${event.agent} backups`
					: `rating ${event.agent} difficulty`;
			({ result: decision, latencyMs } = await withJevActivity(
				ctx,
				activity,
				() => choose(state, offered, rate, catalog, evaluator(ctx), event.signal),
			));
		}
		decision = withReadiness(decision);
		const selected = slots.length === 1 ? slots[0] : slots.find(({ profile }) => profile.id === decision.choice);
		if (decision.source === "baseline" || !selected) {
			reportDecision(ctx, decision, event.agent, {}, latencyMs);
			return;
		}
		const exact = `${selected.model.provider}/${selected.model.id}`;
		const difficulty = decision.difficulty ?? ORDINARY;
		const effort = fitEffort(selected.profile.effort[difficulty], getSupportedEfforts(selected.model));
		const byBackupId = new Map(selected.backups.map(backup => [backup.profile.id, backup]));
		const order = decision.backupOrder?.[selected.profile.id] ?? selected.backups.map(backup => backup.profile.id);
		const backupRoutes = order.flatMap(id => {
			const backup = byBackupId.get(id);
			if (!backup) return [];
			const backupEffort = fitEffort(
				backup.profile.effort[difficulty],
				getSupportedEfforts(backup.model),
			);
			if (!backupEffort) return [];
			return [
				{
					slot: backup.profile.id,
					model: backup.model,
					exact: `${backup.model.provider}/${backup.model.id}`,
					effort: backupEffort,
				},
			];
		});
		const selectedRoute: RouteOption = { slot: selected.profile.id, model: selected.model, exact, effort };
		const poolMembers: PoolMember[] = [];
		const poolRoutes: RouteOption[] = [];
		const demotedPoolRoutes: RouteOption[] = [];
		let poolRoute: PoolRouteReport | undefined;
		if (selected.profile.speedPool) {
			const poolUsage = await fetchPoolUsage(ctx, event.signal);
			const nowMs = Date.now();
			for (const configured of selected.profile.speedPool) {
				const poolProfile = catalog.profiles.find(profile => profile.id === configured.id);
				const poolModel = poolProfile?.model ? ctx.models.resolve(poolProfile.model) : undefined;
				if (
					!poolProfile ||
					!poolModel ||
					!available.some(candidate => candidate.provider === poolModel.provider && candidate.id === poolModel.id)
				)
					continue;
				const poolEffort = fitEffort(poolProfile.effort[difficulty], getSupportedEfforts(poolModel));
				if (!poolEffort) continue;
				const counter = counterForModel(poolModel, poolUsage?.reports ?? []);
				poolMembers.push({
					...configured,
					model: { provider: poolModel.provider, id: poolModel.id },
					effort: poolEffort,
					...(counter !== undefined ? { counter } : {}),
					penaltyKind: poolModel.provider === "xai-oauth" ? "weekly" : "short",
				});
			}
			if (!poolUsage) {
				poolRoute = { status: "no-usage" };
			} else {
				const penalties = poolPenalties(poolMembers, poolUsage, nowMs);
				const rank = rankPool(
					poolMembers,
					poolUsage,
					penalties,
					activeDemotions(nowMs),
					catalog.speedPoolLimits,
					nowMs,
				);
				const poolById = new Map(poolMembers.map(member => [member.id, member]));
				const routeForMember = (id: string) => {
					const member = poolById.get(id);
					if (!member) return undefined;
					const poolProfile = selected.profile.speedPool?.find(configured => configured.id === id);
					const poolCatalogProfile = catalog.profiles.find(profile => profile.id === id);
					const poolModel = poolProfile && poolCatalogProfile?.model ? ctx.models.resolve(poolCatalogProfile.model) : undefined;
					if (!poolCatalogProfile || !poolModel) return undefined;
					const poolEffort = fitEffort(poolCatalogProfile.effort[difficulty], getSupportedEfforts(poolModel));
					if (!poolEffort) return undefined;
					return { slot: id, model: poolModel, exact: `${poolModel.provider}/${poolModel.id}`, effort: poolEffort };
				};
				for (const id of rank.order) {
					const route = routeForMember(id);
					if (route) poolRoutes.push(route);
				}
				for (const id of rank.demoted) {
					const route = routeForMember(id);
					if (route) demotedPoolRoutes.push(route);
				}
				const skipped = new Set(rank.skipped);
				const filteredBackups = backupRoutes.filter(route => !skipped.has(route.slot));
				backupRoutes.splice(0, backupRoutes.length, ...filteredBackups);
				poolRoute = {
					order: [],
					skipped: rank.skipped,
					demoted: rank.demoted,
					verdicts: rank.verdicts,
				};
			}
		}
		const assembled =
			selected.profile.speedPoolPlacement === "before"
				? [...poolRoutes, selectedRoute, ...demotedPoolRoutes, ...backupRoutes]
				: [selectedRoute, ...poolRoutes, ...backupRoutes, ...demotedPoolRoutes];
		const seen = new Set<string>();
		const attemptOrder = assembled.filter(option => {
			if (seen.has(option.exact)) return false;
			seen.add(option.exact);
			return true;
		});
		let firstUnblocked = 0;
		if (selectorSuppressed(ctx, attemptOrder[0].model, attemptOrder[0].effort)) {
			const candidate = attemptOrder.findIndex(option => !selectorSuppressed(ctx, option.model, option.effort));
			if (candidate >= 0) firstUnblocked = candidate;
		}
		const rolledOver = firstUnblocked > 0;
		const active = attemptOrder[firstUnblocked];
		const routedBackups = rolledOver ? attemptOrder.slice(firstUnblocked + 1) : attemptOrder.slice(1);
		const model = [active.exact, ...routedBackups.map(option => `${option.exact}:${option.effort}`)];
		const backups = backupRoutes.map(option => ({ slot: option.slot, model: option.exact, thinking: option.effort }));
		if (poolRoute) {
			poolRoute.active = active.exact;
			poolRoute.order = attemptOrder.map(option => option.exact);
		}
		const activePoolMember = poolMembers.find(member => `${member.model.provider}/${member.model.id}` === active.exact);
		if (activePoolMember) {
			const counter = activePoolMember.counter ?? counterForModel(activePoolMember.model, []);
			if (counter !== undefined) reservationToken(event.agent, active.exact, counter, Date.now());
		}
		return {
			model,
			thinkingLevel: active.effort ? thinkingLevel(active.effort) : ThinkingLevel.Off,
			note: reportDecision(
				ctx,
				decision,
				event.agent,
				{
					slot: selected.profile.id,
					model: exact,
					thinking: effort ?? "off",
					difficulty: decision.difficulty,
					backups,
					pool: poolRoute,
					...(rolledOver ? { rollover: { from: selected.profile.id, to: active.slot } } : {}),
				},
				latencyMs,
			),
		};
	});
}
