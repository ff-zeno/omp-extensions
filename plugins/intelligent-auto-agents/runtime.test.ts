import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

interface JudgeRequest {
	state: string;
	questions: {
		route?: { criteria: Record<string, string> };
		difficulty?: { criteria: string[] };
		[key: string]: unknown;
	};
}
let judgeError: Error | undefined;
let readinessChoice: "autonomous-plan" | "discuss-with-user" = "discuss-with-user";
let routeChoice: string | undefined;
let routeConfidence = 0.98;
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
			confidence: routeConfidence,
			probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])),
		};
	}
	if (request.questions.difficulty) {
		answers.difficulty = { type: "score", score: difficultyScore, confidence: difficultyConfidence, probabilities: {} };
	}
	return { answers, usage: { input: 20, output: 0, totalTokens: 20, cost: { total: 0.0004 } } };
};

mock.module("@oh-my-pi/pi-ai", () => ({
	resolveUsedFraction: (limit: { amount: { usedFraction?: number; unit: string } }) => limit.amount.usedFraction,
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
const CHAT_MODEL = model("chat", ["low", "high", "xhigh"]);
const OPUS = model("claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"], "anthropic");
const GROK = model("grok-4.6", ["low", "medium", "high", "xhigh"], "xai-oauth");
const SOL = model("gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"], "openai-codex");
const GEMINI = model("gemini-3.8-flash", ["low", "medium", "high"], "google-antigravity");
const DEFAULT_BINDINGS: Record<string, RoutingTestModel> = {
	"@frontier-1": OPUS,
	"@frontier-2": SOL,
	"@frontier-3": GROK,
	"@lead": OPUS,
	"@grunt": model("deepseek-v4.1-flash", ["low", "high", "max"], "surplus"),
	"@vision": GEMINI,
	"@orchestrator": GEMINI,
	"anthropic/claude-opus-5-5": OPUS,
	"anthropic/claude-sonnet-5-5": model("claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"], "anthropic"),
	"xai-oauth/grok-4.6": GROK,
	"openai-codex/gpt-6.1-sol": SOL,
};

interface Fixture {
	hooks: Record<string, Function>;
	entries: Array<{ type: string; data: unknown }>;
	statuses: Array<[string, string | undefined]>;
	workingMessages: Array<string | undefined>;
	notifications: Array<[string, string | undefined]>;
	ctx: Record<string, unknown>;
}

function createFixture(
	options: {
		enabled?: boolean;
		bindings?: Record<string, RoutingTestModel>;
		agent?: { kind: "main" | "sub"; name: string; depth: number };
		model?: RoutingTestModel;
		sessionId?: string;
		suppressedSelectors?: readonly string[];
		cwd?: string;
		artifactsDir?: string;
		usageReports?: readonly unknown[];
		usageError?: Error;
		usageReportsImpl?: (options: { signal: AbortSignal }) => Promise<unknown>;
		oauthCredentials?: Record<string, readonly unknown[]>;
	} = {},
): Fixture {
	const hooks: Record<string, Function> = {};
	const entries: Array<{ type: string; data: unknown }> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const workingMessages: Array<string | undefined> = [];
	const notifications: Array<[string, string | undefined]> = [];
	const bindings = options.bindings ?? DEFAULT_BINDINGS;
	const models = { list: () => Object.values(bindings), resolve: (pattern: string) => bindings[pattern] };
	const mockPi = {
		on: (name: string, handler: Function) => {
			hooks[name] = handler;
		},
		registerCommand: () => {},
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	};
	register(mockPi as Parameters<typeof register>[0]);

	const sessionId = options.sessionId ?? "session-main";
	const ctx = {
		hasUI: true,
		agent: options.agent ?? { kind: "main" as const, name: "main", depth: 0 },
		model: options.model ?? CHAT_MODEL,
		cwd: options.cwd ?? process.cwd(),
		localProtocolOptions: options.artifactsDir
			? { getArtifactsDir: () => options.artifactsDir, getSessionId: () => sessionId }
			: undefined,
		ui: {
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setStatus: (key: string, message?: string) => statuses.push([key, message]),
			notify: (message: string, severity?: string) => notifications.push([message, severity]),
		},
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "intelligent-auto-agents-state", data: { enabled: options.enabled ?? true } },
			],
			getSessionId: () => sessionId,
		},
		modelRegistry: {
			getApiKeyForProvider: async () => "local-test-key",
			isSelectorSuppressed: (selector: string) => options.suppressedSelectors?.includes(selector) ?? false,
			authStorage: {
				usage: {
					reports: async (request: { signal: AbortSignal }) => {
						if (options.usageReportsImpl) return options.usageReportsImpl(request);
						if (options.usageError) throw options.usageError;
						return options.usageReports ?? [];
					},
				},
				credentials: {
					credentials: (provider: string) => options.oauthCredentials?.[provider] ?? [{ credential: { type: "oauth" } }],
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

function spawn(fixture: Fixture, overrides: Record<string, unknown> = {}) {
	return fixture.hooks.before_subagent_spawn?.(routeEvent(overrides), fixture.ctx);
}

function decisionData(fixture: Fixture): Record<string, unknown> {
	const data = fixture.entries.at(-1)?.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Missing routing decision entry");
	return data as Record<string, unknown>;
}

function reset(): void {
	judgeError = undefined;
	readinessChoice = "discuss-with-user";
	routeChoice = undefined;
	routeConfidence = 0.98;
	difficultyScore = 1;
	difficultyConfidence = 0.9;
	judgeCalls = 0;
	judgeRequests.length = 0;
	resetSpeedPoolStateForTests();
}

function usageReport(provider: string, modelId: string, fetchedAt = Date.now(), used = 0.1): Record<string, unknown> {
	const shortDuration = 5 * 60 * 60 * 1000;
	const weeklyDuration = 7 * 24 * 60 * 60 * 1000;
	const limit = (id: string, durationMs: number, value: number, elapsed: number, shared = false) => ({
		id,
		label: id,
		scope: { provider, ...(shared ? { shared: true } : {}) },
		window: { id, label: id, durationMs, resetsAt: fetchedAt + durationMs * (1 - elapsed) },
		amount: { unit: "percent", usedFraction: value },
	});
	if (provider === "anthropic")
		return { provider, fetchedAt, limits: [limit("anthropic:5h", shortDuration, used, 0.2, true), limit("anthropic:7d", weeklyDuration, used, 0.2, true)] };
	if (provider === "xai-oauth")
		return { provider, fetchedAt, limits: [limit("xai-oauth:credits:weekly", weeklyDuration, used, 0.2), limit("xai-oauth:credits:monthly", 30 * 24 * 60 * 60 * 1000, used, 0.2)] };
	return { provider, fetchedAt, limits: [limit(`${provider}:${modelId}:5h`, shortDuration, used, 0.2), limit(`${provider}:${modelId}:weekly`, weeklyDuration, used, 0.2)] };
}

describe("intelligent auto-agents runtime", () => {
	test("routes a covered agent through its task-type pool without persisting task text", async () => {
		reset();
		routeChoice = "grunt";
		const fixture = createFixture({ usageReports: [usageReport("xai-oauth", "grok-4.6")] });

		const result = await spawn(fixture);

		expect(result).toMatchObject({ model: ["xai-oauth/grok-4.6"], thinkingLevel: "high" });
		const data = decisionData(fixture);
		expect(data).toMatchObject({ slot: "grunt", difficulty: "ordinary" });
		expect(data.pool).toMatchObject({ active: "xai-oauth/grok-4.6" });
		expect(JSON.stringify(data)).not.toContain("ASSIGNMENT_TEXT");
		expect(judgeRequests[0].state).toContain("Routing guidance:");
	});

	test("routes exact grunt work to Sonnet and harder work away from it", async () => {
		reset();
		difficultyScore = 0;
		routeChoice = "grunt";
		// Grok leads the grunt pool while its quota is on pace; only when it is skipped does exact work fall to Sonnet.
		const exact = createFixture({
			usageReports: [usageReport("xai-oauth", "grok-4.6", Date.now(), 0.99), usageReport("anthropic", "claude-opus-5-5")],
		});
		const result = await spawn(exact);
		expect(result.model[0]).toBe("anthropic/claude-sonnet-5-5");
		expect(result.thinkingLevel).toBe("low");
		expect(decisionData(exact).pool).toMatchObject({ skipped: expect.arrayContaining(["xai-oauth/grok-4.6"]) });

		reset();
		difficultyScore = 2;
		routeChoice = "grunt";
		const hard = createFixture({
			usageReports: [usageReport("xai-oauth", "grok-4.6", Date.now(), 0.99), usageReport("anthropic", "claude-opus-5-5")],
		});
		const harder = await spawn(hard);
		expect(harder.model[0]).toBe("anthropic/claude-opus-5-5");
	});

	test("a Directive line wins over the pool and pins the model", async () => {
		reset();
		routeChoice = "grunt";
		const fixture = createFixture();
		const result = await spawn(fixture, { assignment: "Do it\nDirective: use frontier-2\n" });

		expect(result).toMatchObject({ model: ["openai-codex/gpt-6.1-sol"], thinkingLevel: "medium" });
		expect(decisionData(fixture)).toMatchObject({ directive: "Directive: use frontier-2" });
		expect(judgeRequests[0].questions.route).toBeUndefined();
		expect(judgeCalls).toBe(1);
	});

	test("a Directive naming a literal provider/model is honoured", async () => {
		reset();
		const fixture = createFixture();
		const result = await spawn(fixture, { assignment: "Directive: use xai-oauth/grok-4.6 low" });
		expect(result).toMatchObject({ model: ["xai-oauth/grok-4.6"], thinkingLevel: "low" });
		expect(judgeCalls).toBe(0);
	});

	test("a spawn lock wins over the directive and the pool", async () => {
		reset();
		const fixture = createFixture();
		const result = await spawn(fixture, { assignment: "Directive: use frontier-2", modelLocked: true });

		expect(result).toBeUndefined();
		expect(judgeCalls).toBe(0);
		expect(decisionData(fixture)).toMatchObject({ source: "baseline", reason: "model-locked" });

		const effortLocked = createFixture();
		await spawn(effortLocked, { effortLocked: true });
		expect(decisionData(effortLocked)).toMatchObject({ source: "baseline", reason: "effort-locked" });
	});

	test("a pinned agent keeps its bound model and only receives effort", async () => {
		reset();
		const fixture = createFixture();
		const result = await spawn(fixture, { agent: "orchestrator", patterns: ["@orchestrator"] });

		expect(result.model).toBeUndefined();
		expect(result.thinkingLevel).toBe("high");
		expect(decisionData(fixture)).toMatchObject({ slot: "pinned" });
	});

	test("a pinned agent with no routable effort keeps the baseline", async () => {
		reset();
		const fixture = createFixture();
		const result = await spawn(fixture, { agent: "medium", patterns: ["@missing"] });
		expect(result).toBeUndefined();
		expect(decisionData(fixture)).toMatchObject({ source: "baseline", reason: "no-routable-effort" });
	});

	test("an unknown agent is reported once and left alone", async () => {
		reset();
		const fixture = createFixture();
		const result = await spawn(fixture, { agent: "ghost" });
		expect(result).toBeUndefined();
		expect(judgeCalls).toBe(0);
		expect(decisionData(fixture)).toMatchObject({ source: "baseline", reason: "unknown-agent" });
	});

	test("routing off, locked, and unknown states are distinguished", async () => {
		reset();
		const off = createFixture({ enabled: false });
		await spawn(off);
		expect(decisionData(off)).toMatchObject({ reason: "routing-off" });

		const locked = createFixture();
		await spawn(locked, { modelLocked: true });
		expect(decisionData(locked)).toMatchObject({ reason: "model-locked" });

		const unknown = createFixture();
		await spawn(unknown, { agent: "nobody" });
		expect(decisionData(unknown)).toMatchObject({ reason: "unknown-agent" });
	});

	test("plan review excludes the plan's author model", async () => {
		reset();
		routeChoice = "plan-review";
		const dir = mkdtempSync(join(tmpdir(), "jev-plan-"));
		try {
			writeFileSync(
				join(dir, "plan.md"),
				["---", "plan:", "  authored-by:", "    - model: xai-oauth/grok-4.6", "  reviews: []", "---", "# Plan"].join("\n"),
			);
			const fixture = createFixture({ cwd: dir });
			const result = await spawn(fixture, { agent: "reviewer", assignment: "Review the plan at plan.md" });

			expect(result.model[0]).toBe("openai-codex/gpt-6.1-sol");
			expect(result.model).not.toContain("xai-oauth/grok-4.6");
			expect(result.note ?? "").toContain("plan authors excluded");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("plan review resolves a local:// plan path through the session directory", async () => {
		reset();
		routeChoice = "plan-review";
		const dir = mkdtempSync(join(tmpdir(), "jev-local-"));
		try {
			// OMP resolves `local://` under <artifactsDir>/local.
			const localDir = join(dir, "local");
			mkdirSync(localDir, { recursive: true });
			writeFileSync(
				join(localDir, "plan.md"),
				["---", "plan:", "  authored-by:", "    - model: openai-codex/gpt-6.1-sol", "  reviews:", "    - model: anthropic/claude-opus-5-5", "---", "# Plan"].join("\n"),
			);
			const fixture = createFixture({ artifactsDir: dir });
			const result = await spawn(fixture, { agent: "reviewer", assignment: "Review local://plan.md" });
			// Sol authored and Opus already reviewed, so Grok is preferred.
			expect(result.model[0]).toBe("xai-oauth/grok-4.6");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a media task routes to the vision model when Jev picks vision", async () => {
		reset();
		routeChoice = "vision";
		const fixture = createFixture();
		const result = await spawn(fixture, { assignment: "Describe this screenshot.png" });

		expect(Object.keys(judgeRequests[0].questions.route?.criteria ?? {})).toContain("vision");
		// The spawn carries the primary model followed by the task type's backups.
		expect(result.model[0]).toBe("google-antigravity/gemini-3.8-flash");
	});

	test("a failed difficulty rating keeps the baseline spawn", async () => {
		reset();
		judgeError = new Error("judge down");
		routeChoice = "grunt";
		const fixture = createFixture();
		const result = await spawn(fixture);
		expect(result).toBeUndefined();
		expect(decisionData(fixture)).toMatchObject({ source: "baseline" });
	});

	test("planning readiness interception blocks an open-ended plan and merges upstream usage", async () => {
		reset();
		readinessChoice = "discuss-with-user";
		const blocked = createFixture();
		const blockedResult = await blocked.hooks.before_subagent_spawn?.(
			routeEvent({ agent: "plan" }),
			blocked.ctx,
		);
		expect(blockedResult).toMatchObject({ block: true });
		expect(blockedResult.reason).toContain("[JEV Intercept]");
	});

	test("a cleared plan routes through the plan task type with readiness usage attached", async () => {
		reset();
		readinessChoice = "autonomous-plan";
		routeChoice = "plan";
		const fixture = createFixture();
		const result = await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "plan" }), fixture.ctx);

		expect(result).toMatchObject({ model: ["anthropic/claude-opus-5-5"], thinkingLevel: "medium" });
		// Readiness and difficulty are separate Jev calls, so their usage is summed.
		expect(decisionData(fixture).usage).toMatchObject({ totalTokens: 40 });
		expect(fixture.entries.length).toBe(1);
	});

	test("nested plan spawns skip readiness interception", async () => {
		reset();
		routeChoice = "plan";
		const fixture = createFixture({ agent: { kind: "sub", name: "main", depth: 1 } });
		await spawn(fixture, { agent: "plan" });
		expect(judgeRequests.every(request => !Object.keys(request.questions.route?.criteria ?? {}).includes("discuss-with-user"))).toBe(true);
	});

	test("planning readiness only runs for a catalog readiness agent on main", async () => {
		reset();
		routeChoice = "grunt";
		const fixture = createFixture();
		await spawn(fixture, { agent: "task" });
		expect(judgeRequests.every(request => !Object.keys(request.questions.route?.criteria ?? {}).includes("discuss-with-user"))).toBe(true);
	});

	test("solutionSpace is fed to Jev but never persisted", async () => {
		reset();
		routeChoice = "grunt";
		const fixture = createFixture();
		await spawn(fixture, { solutionSpace: "SOLUTION_SPACE_TEXT" });
		expect(judgeRequests[0].state).toContain("SOLUTION_SPACE_TEXT");
		expect(JSON.stringify(decisionData(fixture))).not.toContain("SOLUTION_SPACE_TEXT");
	});

	test("skips a suppressed pool member for the next route", async () => {
		reset();
		difficultyScore = 0;
		routeChoice = "grunt";
		// Grok is suppressed at its resolved exact-work effort, so exact work rolls over to Sonnet.
		const fixture = createFixture({
			usageReports: [usageReport("xai-oauth", "grok-4.6"), usageReport("anthropic", "claude-opus-5-5")],
			suppressedSelectors: ["xai-oauth/grok-4.6:medium"],
		});
		const result = await spawn(fixture);
		expect(result.model[0]).toBe("anthropic/claude-sonnet-5-5");
		expect(decisionData(fixture).rollover).toMatchObject({ from: "xai-oauth/grok-4.6" });
	});

	test("usage fetch failure still routes through the declared pool order", async () => {
		reset();
		routeChoice = "grunt";
		const fixture = createFixture({ usageError: new Error("usage unavailable") });
		const result = await spawn(fixture);
		expect(result.model[0]).toBe("xai-oauth/grok-4.6");
		expect(decisionData(fixture).pool).toMatchObject({ status: "no-usage" });
	});

	test("keeps the routed member when a pool member is over quota", async () => {
		reset();
		routeChoice = "grunt";
		const fixture = createFixture({ usageReports: [usageReport("xai-oauth", "grok-4.6", Date.now(), 0.99), usageReport("anthropic", "claude-opus-5-5")] });
		const result = await spawn(fixture);
		expect(result.model[0]).not.toBe("xai-oauth/grok-4.6");
		expect(decisionData(fixture).pool).toMatchObject({ skipped: expect.arrayContaining(["xai-oauth/grok-4.6"]) });
	});

	test("records a child failure as a rollover and leaves an abort unchanged", async () => {
		reset();
		routeChoice = "grunt";
		const run = async (sessionId: string, provider: string, modelId: string, stopReason: string) => {
			const parent = createFixture({ usageReports: [usageReport("xai-oauth", "grok-4.6")] });
			await spawn(parent);
			const child = createFixture({
				agent: { kind: "sub", name: "task", depth: 1 },
				sessionId,
				model: DEFAULT_BINDINGS["@frontier-3"],
			});
			child.hooks.agent_end?.(
				{ messages: [{ role: "assistant", provider, model: modelId, stopReason }], willContinue: false },
				child.ctx,
			);
			return child;
		};
		const rollover = await run("rollover", "other", "other", "stop");
		expect(rollover.entries.at(-1)?.data).toMatchObject({ outcome: "failure", reason: "rollover", failureStreak: 1 });

		const aborted = await run("aborted", "xai-oauth", "grok-4.6", "aborted");
		expect(aborted.entries.at(-1)?.data).toMatchObject({ outcome: "unchanged", reason: "aborted" });
	});

	test.skip("demotes a pool member after repeated failures", () => {});

	test("the /auto-agents command reports status without changing the chat model", async () => {
		reset();
		routeChoice = "grunt";
		const fixture = createFixture({ usageReports: [usageReport("xai-oauth", "grok-4.6")] });
		await spawn(fixture);
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const mockPi = {
			on: () => {},
			registerCommand: (name: string, command: unknown) =>
				commands.set(name, command as { handler: (args: string, ctx: unknown) => Promise<void> }),
			appendEntry: () => {},
		};
		register(mockPi as Parameters<typeof register>[0]);
		await commands.get("auto-agents")?.handler("status", fixture.ctx);
		expect(fixture.notifications.at(-1)?.[0]).toContain("Chat model unchanged");
	});
});
