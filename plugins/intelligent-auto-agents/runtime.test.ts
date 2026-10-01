import { describe, expect, mock, test } from "bun:test";

interface JudgeRequest {
	questions: {
		route?: { criteria: Record<string, string> };
		difficulty?: { criteria: string[] };
		[key: string]: unknown;
	};
}
let judgeError: Error | undefined;
let readinessChoice: "autonomous-plan" | "discuss-with-user" = "discuss-with-user";
let routeChoice: string | undefined;
let difficultyScore = 1;
let difficultyConfidence = 0.9;
let judgeCalls = 0;
const judgeRequests: JudgeRequest[] = [];
const judgeBridge = globalThis as unknown as { __intelligentAutoAgentsJudge?: (request: JudgeRequest) => Promise<unknown> };
judgeBridge.__intelligentAutoAgentsJudge = async (request: JudgeRequest) => {
	judgeCalls++;
	judgeRequests.push(request);
	if (judgeError) throw judgeError;
	const answers: Record<string, unknown> = {};
	if (request.questions.route) {
		const options = Object.keys(request.questions.route.criteria);
		const choice = options.includes("discuss-with-user")
			? readinessChoice
			: routeChoice && options.includes(routeChoice)
				? routeChoice
				: options[0];
		answers.route = {
			type: "choice",
			choice,
			confidence: 0.98,
			probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])),
		};
	}
	if (request.questions.difficulty) {
		answers.difficulty = { type: "score", score: difficultyScore, confidence: difficultyConfidence, probabilities: {} };
	}
	return { answers, usage: { input: 20, output: 0, totalTokens: 20, cost: { total: 0.0004 } } };
};

mock.module("@oh-my-pi/pi-ai", () => ({
	resolveUsedFraction: (limit: {
		amount: { usedFraction?: number; used?: number; limit?: number; remainingFraction?: number; unit: string };
	}) => {
		if (limit.amount.usedFraction !== undefined) return limit.amount.usedFraction;
		if (limit.amount.used !== undefined && limit.amount.limit !== undefined && limit.amount.limit > 0)
			return limit.amount.used / limit.amount.limit;
		if (limit.amount.unit === "percent" && limit.amount.used !== undefined) return limit.amount.used / 100;
		if (limit.amount.remainingFraction !== undefined) return Math.max(0, 1 - limit.amount.remainingFraction);
		return undefined;
	},
	scopeAntigravityLimitsForModel: (report: { limits: unknown[] }) => report.limits,
	getAntigravityCounterKeyForModel: (modelId: string | undefined) => modelId,
	TypeSafeJudge: class {
		judge = async (request: JudgeRequest) => judgeBridge.__intelligentAutoAgentsJudge?.(request) ?? { answers: {} };
	},
}));

mock.module("@oh-my-pi/pi-agent-core", () => ({
	ThinkingLevel: { Off: "off", Low: "low", Medium: "medium", High: "high", XHigh: "xhigh", Max: "max" },
}));


mock.module("@oh-my-pi/pi-coding-agent", () => ({
	getSupportedEfforts: (model: { thinking: { efforts: string[] } }) => model.thinking.efforts,
}));
// Bun mocks must be registered before the runtime evaluates its provider imports.
const { register, resetSpeedPoolStateForTests } = await import("./runtime");

interface RoutingTestModel {
	provider: string;
	id: string;
	reasoning: boolean;
	thinking: { efforts: string[] };
}
const model = (id: string, efforts: string[], provider = "routing-test"): RoutingTestModel => ({
	provider,
	id,
	reasoning: true,
	thinking: { efforts },
});
const DEFAULT_BINDINGS: Record<string, RoutingTestModel> = {
	"@mechanic": model("mechanic", ["low", "xhigh"]),
	"@grunt": model("grunt", ["low", "xhigh"]),
	"@lead": model("lead", ["medium", "high", "xhigh"]),
	"@peer-1": model("peer-1", ["low", "medium", "high", "xhigh"]),
	"@peer-2": model("grok-4.6", ["low"], "xai-oauth"),
	"@fast": model("gemini-3.8-flash", ["low"], "google-antigravity"),
	"@secondary-planner": model("secondary-planner", ["high", "xhigh"]),
	"@orchestrator": model("orchestrator", ["high", "xhigh"]),
	"@review.frontier-3": model("peer-2", ["high", "xhigh"]),
};

function createFixture(
	options: {
		enabled?: boolean;
		bindings?: Record<string, RoutingTestModel>;
		agent?: { kind: "main" | "sub"; name: string; depth: number };
		model?: RoutingTestModel;
		sessionId?: string;
		suppressedSelectors?: readonly string[];
		usageReports?: readonly unknown[];
		usageError?: Error;
	} = {},
) {
	const hooks: Record<string, Function> = {};
	const entries: Array<{ type: string; data: unknown }> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const workingMessages: Array<string | undefined> = [];
	const notifications: Array<[string, string | undefined]> = [];
	const bindings = options.bindings ?? DEFAULT_BINDINGS;
	const models = {
		list: () => Object.values(bindings),
		resolve: (pattern: string) => bindings[pattern],
	};
	const mockPi = {
		on: (name: string, handler: Function) => {
			hooks[name] = handler;
		},
		registerCommand: () => {},
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	};
	register(mockPi as Parameters<typeof register>[0]);

	const ctx = {
		hasUI: true,
		agent: options.agent ?? { kind: "main" as const, name: "main", depth: 0 },
		model: options.model ?? bindings["@mechanic"],
		ui: {
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setStatus: (key: string, message?: string) => statuses.push([key, message]),
			notify: (message: string, severity?: string) => notifications.push([message, severity]),
		},
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "intelligent-auto-agents-state", data: { enabled: options.enabled ?? true } },
			],
			getSessionId: () => options.sessionId ?? "session-main",
		},
		modelRegistry: {
			getApiKeyForProvider: async () => "local-test-key",
			isSelectorSuppressed: (selector: string) => options.suppressedSelectors?.includes(selector) ?? false,
			authStorage: {
				usage: {
					reports: async () => {
						if (options.usageError) throw options.usageError;
						return options.usageReports ?? [];
					},
				},
				credentials: {
					credentials: (provider: string) =>
						options.oauthCredentials?.[provider] ?? [{ credential: { type: "oauth" } }],
				},
			},
		},
		models,
	};
	hooks.session_start?.({}, ctx);
	return { hooks, entries, statuses, workingMessages, notifications, ctx };
}

function routeEvent(overrides: Record<string, unknown> = {}) {
	return {
		agent: "task",
		assignment: "ASSIGNMENT_TEXT_MUST_NOT_BE_PERSISTED",
		modelLocked: false,
		effortLocked: false,
		patterns: [],
		...overrides,
	};
}

function decisionData(fixture: { entries: Array<{ type: string; data: unknown }> }): Record<string, unknown> {
	const data = fixture.entries.at(-1)?.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Missing routing decision entry");
	return data as Record<string, unknown>;
}

function reset(): void {
	judgeError = undefined;
	readinessChoice = "discuss-with-user";
	routeChoice = undefined;
	difficultyScore = 1;
	difficultyConfidence = 0.9;
	judgeCalls = 0;
	judgeRequests.length = 0;
	resetSpeedPoolStateForTests();
}
function usageReport(
	provider: string,
	modelId: string,
	fetchedAt = Date.now(),
	shortUsed = 0.1,
): Record<string, unknown> {
	const shortDuration = 5 * 60 * 60 * 1000;
	const weeklyDuration = 7 * 24 * 60 * 60 * 1000;
	const limit = (id: string, durationMs: number, used: number, elapsed: number) => ({
		id,
		label: id,
		scope: { provider },
		window: { id, label: id, durationMs, resetsAt: fetchedAt + durationMs * (1 - elapsed) },
		amount: { unit: "percent", usedFraction: used },
	});
	if (provider === "xai-oauth") {
		return {
			provider,
			fetchedAt,
			limits: [
				limit("xai-oauth:credits:weekly", weeklyDuration, shortUsed, 0.2),
				limit("xai-oauth:credits:monthly", 30 * 24 * 60 * 60 * 1000, shortUsed, 0.2),
			],
		};
	}
	return {
		provider,
		fetchedAt,
		limits: [
			limit(`${provider}:${modelId}:5h`, shortDuration, shortUsed, 0.2),
			limit(`${provider}:${modelId}:weekly`, weeklyDuration, shortUsed, 0.2),
		],
	};
}

describe("intelligent auto-agents runtime", () => {
	test("shows pending classification and the selected slot without persisting task text", async () => {
		reset();
		const fixture = createFixture();

		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent(), fixture.ctx);

		expect(result).toMatchObject({
			model: ["routing-test/grunt", "routing-test/mechanic:xhigh", "routing-test/peer-1:high"],
			thinkingLevel: "low",
		});
		expect(judgeCalls).toBe(1);
		expect(Object.keys(judgeRequests[0].questions).filter(key => key.startsWith("backup:"))).toEqual(["backup:grunt"]);
		expect(decisionData(fixture)).toMatchObject({
			slot: "grunt",
			difficulty: 1,
			usage: { totalTokens: 20 },
			backups: [
				{ slot: "grunt-backup", model: "routing-test/mechanic", thinking: "xhigh" },
				{ slot: "peer", model: "routing-test/peer-1", thinking: "high" },
			],
		});
		expect(JSON.stringify(fixture.entries)).not.toContain("ASSIGNMENT_TEXT_MUST_NOT_BE_PERSISTED");
	});
	test("returns fitted efforts for Jev-ranked backups", async () => {
		reset();
		difficultyScore = 3;
		const fixture = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@mechanic": model("fallback-model", ["low", "high", "max"]) },
		});
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent(), fixture.ctx);
		expect(result).toMatchObject({
			model: ["routing-test/grunt", "routing-test/fallback-model:max", "routing-test/peer-1:xhigh"],
			thinkingLevel: "low",
		});
		expect(decisionData(fixture)).toMatchObject({
			backups: [
				{ slot: "grunt-backup", model: "routing-test/fallback-model", thinking: "max" },
				{ slot: "peer", model: "routing-test/peer-1", thinking: "xhigh" },
			],
		});
	});

	test("drops backups whose resolved model is unavailable", async () => {
		reset();
		const bindings = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).filter(([key]) => key !== "@peer-1"));
		const fixture = createFixture({ bindings });
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent(), fixture.ctx);
		expect(result).toMatchObject({ model: ["routing-test/grunt", "routing-test/mechanic:xhigh"] });
		expect(decisionData(fixture)).toMatchObject({
			backups: [{ slot: "grunt-backup", model: "routing-test/mechanic", thinking: "xhigh" }],
		});
		expect(result.note).not.toContain("peer");
	});

	test("rolls over a suppressed primary to the first available backup at spawn", async () => {
		reset();
		const fixture = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@mechanic": model("fallback-model", ["low", "high", "max"]) },
			suppressedSelectors: ["routing-test/grunt:low"],
		});
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent(), fixture.ctx);
		expect(result).toMatchObject({
			model: ["routing-test/fallback-model", "routing-test/peer-1:high"],
			thinkingLevel: "max",
		});
		expect(result.note).toContain("grunt cooling down → grunt-backup");
		expect(decisionData(fixture)).toMatchObject({
			slot: "grunt",
			backups: [
				{ slot: "grunt-backup", model: "routing-test/fallback-model", thinking: "max" },
				{ slot: "peer", model: "routing-test/peer-1", thinking: "high" },
			],
		});
	});

	test("clamps max review effort to xhigh when the model lacks max", async () => {
		reset();
		const fixture = createFixture();
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "reviewer" }), fixture.ctx);
		expect(result).toMatchObject({ model: ["routing-test/mechanic", "routing-test/peer-1:high"], thinkingLevel: "xhigh" });
		expect(judgeCalls).toBe(0);
	});

	test("routes reviewer to the mechanic at max without calling Jev", async () => {
		reset();
		const fixture = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@mechanic": model("mechanic", ["low", "xhigh", "max"]) },
		});
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "reviewer" }), fixture.ctx);
		expect(result).toMatchObject({ model: ["routing-test/mechanic", "routing-test/peer-1:high"], thinkingLevel: "max" });
		expect(decisionData(fixture)).toMatchObject({ source: "catalog", slot: "review", thinking: "max" });
		expect(judgeCalls).toBe(0);
	});

	test("routes git to peer-1 at low without calling Jev", async () => {
		reset();
		const fixture = createFixture();
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "git" }), fixture.ctx);
		expect(result).toMatchObject({ model: ["routing-test/peer-1", "routing-test/mechanic:low"], thinkingLevel: "low" });
		expect(decisionData(fixture)).toMatchObject({ source: "catalog", slot: "git", thinking: "low" });
		expect(judgeCalls).toBe(0);
	});

	test("clamps to the nearest effort the bound model supports instead of dropping the slot", async () => {
		reset();
		routeChoice = "lead";
		difficultyScore = 3;
		const fixture = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@lead": model("lead", ["medium", "high"]) },
		});
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent(), fixture.ctx);
		expect(result).toMatchObject({ model: ["routing-test/lead", "routing-test/peer-1:xhigh"], thinkingLevel: "high" });
	});

	test("rebinding a slot's model changes only the resolved model, never Jev's request", async () => {
		reset();
		routeChoice = "lead";
		const before = createFixture();
		const first = await before.hooks.before_subagent_spawn?.(routeEvent(), before.ctx);
		const after = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@lead": model("next-frontier", ["medium", "high", "xhigh"], "other-lab") },
		});
		const second = await after.hooks.before_subagent_spawn?.(routeEvent(), after.ctx);

		expect(first.model).toEqual(["routing-test/lead", "routing-test/peer-1:high"]);
		expect(second.model).toEqual(["other-lab/next-frontier", "routing-test/peer-1:high"]);
		expect(first.thinkingLevel).toBe(second.thinkingLevel);
		expect(judgeRequests).toHaveLength(2);
		expect(judgeRequests[0]).toEqual(judgeRequests[1]);
		expect(JSON.stringify(judgeRequests[0])).not.toContain("routing-test");
	});

	test("records planning interception and readiness usage without persisting the assignment", async () => {
		reset();
		const fixture = createFixture();
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "plan" }), fixture.ctx);

		expect(result).toMatchObject({ block: true });
		expect(fixture.statuses.at(-1)?.[1]).toBe("Auto-agents: on");
		expect(fixture.notifications.at(-1)?.[0]).toContain("JEV Intercept");
		expect(fixture.notifications.at(-1)?.[0]).toContain("20 tok");
		expect(decisionData(fixture).usage).toMatchObject({ totalTokens: 20, cost: 0.0004 });
		expect(JSON.stringify(fixture.entries)).not.toContain("ASSIGNMENT_TEXT_MUST_NOT_BE_PERSISTED");
	});

	test("rates plan difficulty on the lead and combines readiness usage", async () => {
		reset();
		readinessChoice = "autonomous-plan";
		difficultyScore = 3;
		const fixture = createFixture();
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "plan" }), fixture.ctx);

		expect(result).toMatchObject({ model: ["routing-test/lead", "routing-test/peer-1:high"], thinkingLevel: "xhigh" });
		expect(judgeCalls).toBe(2);
		expect(judgeRequests[1].questions.route).toBeUndefined();
		expect(result.note).toContain("40 tok");
		expect(result.note).toContain("critical");
		expect(decisionData(fixture).usage).toMatchObject({ totalTokens: 40, cost: 0.0008 });
	});

	test("nested plan spawns skip readiness interception but keep caller attribution", async () => {
		reset();
		const fixture = createFixture({ agent: { kind: "sub", name: "orchestrator", depth: 1 } });

		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "plan" }), fixture.ctx);

		expect(result).toMatchObject({ model: ["routing-test/lead", "routing-test/peer-1:high"], thinkingLevel: "medium" });
		expect(result.note).toContain("Jev routing (from orchestrator, depth 1): plan:");
		expect(judgeCalls).toBe(1);
		expect(decisionData(fixture)).toMatchObject({ callerAgent: "orchestrator", callerDepth: 1 });
		expect(fixture.notifications).toHaveLength(0);
	});

	test("a seat keeps its bound model and routes only effort", async () => {
		reset();
		difficultyScore = 3;
		const fixture = createFixture();
		const result = await fixture.hooks.before_subagent_spawn?.(
			routeEvent({ agent: "peer-review-frontier-3", patterns: ["@review.frontier-3"] }),
			fixture.ctx,
		);
		expect(result).toMatchObject({ thinkingLevel: "xhigh" });
		expect(result.model).toBeUndefined();
		expect(result.note).toContain("frontier-review");
		expect(result.note).toContain("routing-test/peer-2");
		expect(judgeRequests[0].questions.route).toBeUndefined();

		difficultyScore = 1;
		const ordinary = createFixture();
		expect(
			await ordinary.hooks.before_subagent_spawn?.(
				routeEvent({ agent: "peer-review-frontier-3", patterns: ["@review.frontier-3"] }),
				ordinary.ctx,
			),
		).toMatchObject({ thinkingLevel: "high" });
	});

	test("an uncertain seat difficulty keeps the baseline effort", async () => {
		reset();
		difficultyConfidence = 0.3;
		const fixture = createFixture();
		const result = await fixture.hooks.before_subagent_spawn?.(
			routeEvent({ agent: "peer-review-frontier-3", patterns: ["@review.frontier-3"] }),
			fixture.ctx,
		);
		expect(result).toBeUndefined();
		expect(decisionData(fixture).reason).toBe("uncertain-difficulty");
	});

	test("reports provider failure as a baseline fallback without exposing its error", async () => {
		reset();
		const providerError = "PROVIDER_ERROR_MUST_NOT_BE_PERSISTED";
		judgeError = new Error(providerError);
		const fixture = createFixture();
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent(), fixture.ctx);
		expect(result).toBeUndefined();
		expect(fixture.statuses.at(-1)?.[1]).toMatch(/^Jev routing: fallback · routing unavailable · baseline kept · \d+ms$/);
		expect(decisionData(fixture).reason).toBe("routing-unavailable");
		expect(JSON.stringify(fixture.entries)).not.toContain(providerError);
		expect(JSON.stringify(fixture.entries)).not.toContain("ASSIGNMENT_TEXT_MUST_NOT_BE_PERSISTED");
	});

	test("distinguishes disabled, locked, unbound, and single-slot routing", async () => {
		reset();
		const disabled = createFixture({ enabled: false });
		await disabled.hooks.before_subagent_spawn?.(routeEvent(), disabled.ctx);
		expect(disabled.statuses.at(-1)?.[1]).toContain("Jev routing off");
		expect(decisionData(disabled)).toMatchObject({
			source: "baseline",
			reason: "routing-off",
			agent: "task",
			jevModel: "jev-latest",
		});
		expect(disabled.entries.at(-1)?.type).toBe("intelligent-auto-agents-decision");
		expect(JSON.stringify(disabled.entries)).not.toContain("ASSIGNMENT_TEXT_MUST_NOT_BE_PERSISTED");

		const locked = createFixture();
		await locked.hooks.before_subagent_spawn?.(routeEvent({ modelLocked: true, effortLocked: true }), locked.ctx);
		expect(locked.statuses.at(-1)?.[1]).toContain("model locked");

		const single = createFixture({ bindings: { "@mechanic": DEFAULT_BINDINGS["@mechanic"] } });
		const selected = await single.hooks.before_subagent_spawn?.(
			routeEvent({ agent: "sonic", patterns: ["@mechanic"] }),
			single.ctx,
		);
		expect(selected).toMatchObject({ model: ["routing-test/mechanic"], thinkingLevel: "low" });
		expect(judgeCalls).toBe(0);
		const unbound = createFixture({ bindings: {} });
		expect(await unbound.hooks.before_subagent_spawn?.(routeEvent(), unbound.ctx)).toBeUndefined();
		expect(unbound.statuses.at(-1)?.[1]).toContain("no bound model");

		const unslotted = createFixture({ agent: { kind: "sub", name: "orchestrator", depth: 1 } });
		expect(await unslotted.hooks.before_subagent_spawn?.(routeEvent({ agent: "review-closer" }), unslotted.ctx)).toBeUndefined();
		expect(unslotted.statuses.at(-1)?.[1]).toContain("no slot for review-closer");
		expect(decisionData(unslotted)).toMatchObject({
			source: "baseline",
			reason: "no-slot",
			agent: "review-closer",
			callerAgent: "orchestrator",
			callerDepth: 1,
			jevModel: "jev-latest",
		});
		expect(unslotted.entries.at(-1)?.type).toBe("intelligent-auto-agents-decision");
		expect(JSON.stringify(unslotted.entries)).not.toContain("ASSIGNMENT_TEXT_MUST_NOT_BE_PERSISTED");
		expect(judgeCalls).toBe(0);
	});
	test("orders the quota pool before/after the selected slot and counts only OAuth credentials", async () => {
		reset();
		routeChoice = undefined;
		const reports = [
			usageReport("google-antigravity", "gemini-3.8-flash"),
			usageReport("xai-oauth", "grok-4.6"),
		];
		const credentials = {
			"google-antigravity": [{ credential: { type: "oauth" } }, { credential: { type: "api-key" } }],
			"xai-oauth": [{ credential: { type: "oauth" } }],
		};
		const before = createFixture({ usageReports: reports, oauthCredentials: credentials });
		const beforeResult = await before.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), before.ctx);
		expect(beforeResult?.model).toEqual([
			"google-antigravity/gemini-3.8-flash",
			"xai-oauth/grok-4.6:low",
			"routing-test/mechanic:low",
		]);
		expect(decisionData(before).pool).toMatchObject({
			active: "google-antigravity/gemini-3.8-flash",
			order: ["google-antigravity/gemini-3.8-flash", "xai-oauth/grok-4.6", "routing-test/mechanic"],
		});

		reset();
		routeChoice = undefined;
		const after = createFixture({ usageReports: reports, oauthCredentials: credentials });
		const afterResult = await after.hooks.before_subagent_spawn?.(routeEvent(), after.ctx);
		expect(afterResult?.model).toEqual([
			"routing-test/grunt",
			"google-antigravity/gemini-3.8-flash:low",
			"xai-oauth/grok-4.6:low",
			"routing-test/mechanic:xhigh",
			"routing-test/peer-1:high",
		]);
	});

	test("leaves a pool partially covered when two OAuth accounts have one report", async () => {
		reset();
		routeChoice = undefined;
		const fixture = createFixture({
			usageReports: [usageReport("google-antigravity", "gemini-3.8-flash")],
			oauthCredentials: {
				"google-antigravity": [{ credential: { type: "oauth" } }, { credential: { type: "oauth" } }],
			},
		});
		await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), fixture.ctx);
		expect(decisionData(fixture).pool.verdicts["lookup-fast"].status).toBe("partial-usage");
		expect(decisionData(fixture).pool.order).toContain("routing-test/mechanic");
	});

	test("settles keep-alive children at agent_end, not shutdown, and never closes a sibling or revival", async () => {
		reset();
		routeChoice = undefined;
		const parent = createFixture({
			usageReports: [usageReport("google-antigravity", "gemini-3.8-flash")],
			sessionId: "parent",
		});
		await parent.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), parent.ctx);
		await parent.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), parent.ctx);

		const childOne = createFixture({
			agent: { kind: "sub", name: "sonic", depth: 1 },
			sessionId: "child-one",
			model: DEFAULT_BINDINGS["@fast"],
		});
		const childTwo = createFixture({
			agent: { kind: "sub", name: "sonic", depth: 1 },
			sessionId: "child-two",
			model: DEFAULT_BINDINGS["@fast"],
		});
		childOne.hooks.session_shutdown?.({}, childOne.ctx);
		expect(childOne.entries).toEqual([]);
		const success = {
			messages: [
				{
					role: "assistant",
					provider: "google-antigravity",
					model: "gemini-3.8-flash",
					stopReason: "stop",
				},
			],
			willContinue: false,
		};
		childOne.hooks.agent_end?.(success, childOne.ctx);
		expect(childOne.entries.at(-1)?.data).toMatchObject({ outcome: "success" });
		const revival = createFixture({
			agent: { kind: "sub", name: "sonic", depth: 1 },
			sessionId: "child-one",
			model: DEFAULT_BINDINGS["@fast"],
		});
		revival.hooks.agent_end?.({ ...success, willContinue: false }, revival.ctx);
		expect(revival.entries).toEqual([]);
		childTwo.hooks.agent_end?.({ ...success, willContinue: false }, childTwo.ctx);
		expect(childTwo.entries.at(-1)?.data).toMatchObject({ outcome: "success" });
	});

	test("does not prune a closed reservation until every account has refreshed", async () => {
		reset();
		routeChoice = undefined;
		const firstFetchedAt = Date.now();
		const firstReport = usageReport("google-antigravity", "gemini-3.8-flash", firstFetchedAt);
		const parent = createFixture({ usageReports: [firstReport], sessionId: "parent" });
		await parent.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), parent.ctx);
		const child = createFixture({
			agent: { kind: "sub", name: "sonic", depth: 1 },
			sessionId: "child",
			model: DEFAULT_BINDINGS["@fast"],
		});
		child.hooks.agent_end?.(
			{
				messages: [
					{
						role: "assistant",
						provider: "google-antigravity",
						model: "gemini-3.8-flash",
						stopReason: "stop",
					},
				],
				willContinue: false,
			},
			child.ctx,
		);
		const staggered = [
			usageReport("google-antigravity", "gemini-3.8-flash", firstFetchedAt + 1),
			usageReport("google-antigravity", "gemini-3.8-flash", firstFetchedAt - 1),
		];
		const next = createFixture({
			usageReports: staggered,
			sessionId: "next",
		});
		await next.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), next.ctx);
		expect(decisionData(next).pool.verdicts["lookup-fast"].status).toBe("eligible");
	});
	test("removes a skipped legacy backup when its pool member is over quota", async () => {
		reset();
		const fixture = createFixture({
			usageReports: [
				usageReport("google-antigravity", "gemini-3.8-flash", Date.now(), 0.96),
			],
		});
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), fixture.ctx);
		expect(result?.model).toEqual(["routing-test/mechanic"]);
		expect(decisionData(fixture).pool).toMatchObject({ skipped: ["lookup-fast"] });
	});

	test("uses the legacy pool backup and reserves it when usage fetch fails", async () => {
		reset();
		const fixture = createFixture({
			suppressedSelectors: ["routing-test/mechanic:low"],
			usageError: new Error("usage unavailable"),
		});
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), fixture.ctx);
		expect(result?.model).toEqual(["google-antigravity/gemini-3.8-flash"]);
		expect(decisionData(fixture).pool).toMatchObject({
			status: "no-usage",
			active: "google-antigravity/gemini-3.8-flash",
		});
	});
	test("demotes after two failures and clears the streak on a successful retry", async () => {
		reset();
		const run = async (
			sessionId: string,
			message: { provider: string; model: string; stopReason: string },
			suppressedSelectors: readonly string[] = [],
		) => {
			const parent = createFixture({
				usageReports: [usageReport("google-antigravity", "gemini-3.8-flash")],
				suppressedSelectors,
			});
			await parent.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), parent.ctx);
			const child = createFixture({
				agent: { kind: "sub", name: "sonic", depth: 1 },
				sessionId,
				model: DEFAULT_BINDINGS["@fast"],
			});
			child.hooks.agent_end?.({ messages: [{ role: "assistant", ...message }], willContinue: false }, child.ctx);
			return { child, parent };
		};
		const first = await run("failure-one", { provider: "other", model: "other", stopReason: "stop" });
		expect(first.child.entries.at(-1)?.data).toMatchObject({ outcome: "failure", failureStreak: 1, reason: "rollover" });
		const second = await run("failure-two", { provider: "other", model: "other", stopReason: "stop" });
		expect(second.child.entries.at(-1)?.data).toMatchObject({ outcome: "failure", failureStreak: 2 });
		expect((second.child.entries.at(-1)?.data as Record<string, unknown>).demotedUntil).toBeNumber();
		const success = await run(
			"success-after-failures",
			{ provider: "google-antigravity", model: "gemini-3.8-flash", stopReason: "stop" },
			["routing-test/mechanic:low"],
		);
		expect(success.parent.hooks).toBeDefined();
		expect(success.child.entries.at(-1)?.data).toMatchObject({ outcome: "success", failureStreak: 0 });
		expect((success.child.entries.at(-1)?.data as Record<string, unknown>).demotedUntil).toBeUndefined();
	});

	test("expires a demotion before the next failure can extend it", async () => {
		reset();
		const realNow = Date.now;
		let now = 10_000_000;
		Date.now = () => now;
		try {
			const runFailure = async (sessionId: string) => {
				const parent = createFixture({
					usageReports: [usageReport("google-antigravity", "gemini-3.8-flash")],
				});
				await parent.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), parent.ctx);
				const child = createFixture({
					agent: { kind: "sub", name: "sonic", depth: 1 },
					sessionId,
					model: DEFAULT_BINDINGS["@fast"],
				});
				child.hooks.agent_end?.(
					{
						messages: [{ role: "assistant", provider: "other", model: "other", stopReason: "stop" }],
						willContinue: false,
					},
					child.ctx,
				);
			};
			await runFailure("expiry-one");
			await runFailure("expiry-two");
			now += 1_800_001;
			const parent = createFixture({
				usageReports: [usageReport("google-antigravity", "gemini-3.8-flash")],
				suppressedSelectors: ["routing-test/mechanic:low"],
			});
			const result = await parent.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), parent.ctx);
			expect(result?.model[0]).toBe("google-antigravity/gemini-3.8-flash");
			expect(decisionData(parent).pool.verdicts["lookup-fast"].status).toBe("eligible");
		} finally {
			Date.now = realNow;
		}
	});

	test("counts rollover as failure and abort as unchanged", async () => {
		reset();
		const run = async (sessionId: string, stopReason: string, provider: string, modelId: string) => {
			const parent = createFixture({
				usageReports: [usageReport("google-antigravity", "gemini-3.8-flash")],
			});
			await parent.hooks.before_subagent_spawn?.(routeEvent({ agent: "sonic" }), parent.ctx);
			const child = createFixture({
				agent: { kind: "sub", name: "sonic", depth: 1 },
				sessionId,
				model: DEFAULT_BINDINGS["@fast"],
			});
			child.hooks.agent_end?.(
				{ messages: [{ role: "assistant", provider, model: modelId, stopReason }], willContinue: false },
				child.ctx,
			);
			return child;
		};
		const rollover = await run("rollover", "stop", "other", "other");
		expect(rollover.entries.at(-1)?.data).toMatchObject({ outcome: "failure", reason: "rollover", failureStreak: 1 });
		const aborted = await run("aborted", "aborted", "google-antigravity", "gemini-3.8-flash");
		expect(aborted.entries.at(-1)?.data).toMatchObject({ outcome: "unchanged", reason: "aborted", failureStreak: 1 });
	});
});
