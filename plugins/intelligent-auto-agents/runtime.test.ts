import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, mock, test } from "bun:test";
import catalogData from "./catalog.json";
import type { Catalog } from "./routing";

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
let slotChoice: string | undefined;
let slotConfidence = 0.98;
let slotAnswer: "ok" | "missing" | "invalid" = "ok";
let slotProbabilities: Record<string, number> | undefined;
let routeChoice: string | undefined;
let routeConfidence = 0.98;
let difficultyScore = 1;
let difficultyConfidence = 0.9;
let judgeCalls = 0;
let personaChoice = "normal";
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
	if (request.questions.slot && slotAnswer !== "missing") {
		if (slotAnswer === "invalid") {
			answers.slot = { type: "choice", choice: "not-a-slot", confidence: 0.9, probabilities: { x: 1 } };
		} else {
			const options = Object.keys(request.questions.slot.criteria);
			const choice = slotChoice && options.includes(slotChoice) ? slotChoice : options[1];
			answers.slot = {
				type: "choice",
				choice,
				confidence: slotConfidence,
				probabilities:
					slotProbabilities ?? Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])),
			};
		}
	}
	if (request.questions.difficulty) {
		answers.difficulty = { type: "score", score: difficultyScore, confidence: difficultyConfidence, probabilities: {} };
	}
	if (request.questions.persona) {
		answers.persona = {
			type: "choice",
			choice: personaChoice,
			confidence: 0.9,
			probabilities: { normal: personaChoice === "normal" ? 1 : 0, brute: personaChoice === "brute" ? 1 : 0 },
		};
	}
	return { answers, usage: { input: 20, output: 0, totalTokens: 20, cost: { total: 0.0004 } } };
};

mock.module("@oh-my-pi/pi-ai", () => ({
	resolveUsedFraction: (limit: { amount: { usedFraction?: number; unit: string } }) => limit.amount.usedFraction,
	NativeJudge: class {
		judge = async (request: JudgeRequest) => judgeBridge.__intelligentAutoAgentsJudge?.(request) ?? { answers: {} };
	},
}));

mock.module("@oh-my-pi/pi-agent-core", () => ({
	ThinkingLevel: { Off: "off", Low: "low", Medium: "medium", High: "high", XHigh: "xhigh", Max: "max" },
}));

mock.module("@oh-my-pi/pi-coding-agent", () => ({
	getSupportedEfforts: (model: { thinking: { efforts: string[] } }) => model.thinking.efforts,
}));

// Load after the mocks: a static import of ./routing would run before mock.module and fail where OMP is not installed.
const { parseCatalog } = await import("./routing");
const { register, resetSpeedPoolStateForTests, setAccountPinIoForTests, setCatalogForTests, setExperimentAgentDirForTests } = await import("./runtime");

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
const TERRA = model("gpt-6.1-terra", ["low", "medium", "high", "xhigh", "max"], "openai-codex");
const LUNA = model("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"], "openai-codex");
const HAIKU = model("claude-haiku-5-5", ["low", "medium", "high", "xhigh", "max"], "anthropic");
const DEEPSEEK = model("deepseek-v4.1-flash", ["low", "high", "max"], "opencode-go");
const DEFAULT_BINDINGS: Record<string, RoutingTestModel> = {
	"@frontier-1": OPUS,
	"@frontier-2": SOL,
	"@frontier-3": GROK,
	"@lead": OPUS,
	"@fast": HAIKU,
	"@vision": OPUS,
	"@orchestrator": OPUS,
	"anthropic/claude-opus-5-5": OPUS,
	"anthropic/claude-haiku-5-5": HAIKU,
	"anthropic/claude-sonnet-5-5": model("claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"], "anthropic"),
	"xai-oauth/grok-4.6": GROK,
	"openai-codex/gpt-6.1-sol": SOL,
	"openai-codex/gpt-6.1-terra": TERRA,
	"openai-codex/gpt-5.6-luna": LUNA,
	"opencode-go/deepseek-v4.1-flash": DEEPSEEK,
	"xai-oauth/grok-4.7": model("grok-4.7", ["low", "medium", "high", "xhigh"], "xai-oauth"),
	"opencode-go/hy4-flash-free": model("hy4-flash-free", ["low", "medium", "high"], "opencode-go"),
	"anthropic/claude-fable-5-2": model("claude-fable-5-2", ["low", "medium", "high", "xhigh", "max"], "anthropic"),
	"openscale/deepseek/deepseek-v4.1-flash-1017": model("deepseek/deepseek-v4.1-flash-1017", ["low", "high", "max"], "openscale"),
	"openai-codex/gpt-6.2-astra": model("gpt-6.2-astra", ["low", "medium", "high", "xhigh", "max"], "openai-codex"),
};

interface Fixture {
	hooks: Record<string, Function>;
	entries: Array<{ type: string; data: unknown }>;
	statuses: Array<[string, string | undefined]>;
	workingMessages: Array<string | undefined>;
	notifications: Array<[string, string | undefined]>;
	ctx: Record<string, unknown>;
	oauthPins: Array<[string, number]>;
}

const experimentScratch = mkdtempSync(join(tmpdir(), "iaa-experiment-"));
let scratchCount = 0;
afterAll(() => rmSync(experimentScratch, { recursive: true, force: true }));

function scratchDir(): string {
	const dir = join(experimentScratch, String(++scratchCount));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Shipped catalog plus a fixture-only experiment block; the shipped catalog carries none. */
function splitTestCatalog(endsAt = "2999-01-01T00:00:00Z"): Catalog {
	const data = structuredClone(catalogData) as typeof catalogData;
	data.poolLimits.ignoreQuota = [];
	return parseCatalog({
		...data,
		experiment: {
			name: "split-test",
			enabled: true,
			endsAt,
			slots: [
				{
					pools: ["speed-moderate-difficulty"],
					difficulties: ["exact", "ordinary", "hard"],
					candidates: [
						{ model: "anthropic/claude-haiku-5-5", effort: "high" },
						{ model: "openai-codex/gpt-6.1-terra", effort: "high" },
						{ model: "openscale/deepseek/deepseek-v4.1-flash-1017", effort: "high" },
						{ model: "xai-oauth/grok-4.6", effort: "high" },
					],
				},
				{
					pools: ["speed-moderate-difficulty"],
					difficulties: ["critical"],
					candidates: [
						{ model: "anthropic/claude-sonnet-5-5", effort: "high" },
						{ model: "openai-codex/gpt-6.1-terra", effort: "high" },
					],
				},
			],
		},
	});
}

function catalogInMode(mode: "speed" | "cost"): Catalog {
	const data = structuredClone(catalogData) as typeof catalogData;
	data.mode = mode;
	data.poolLimits.ignoreQuota = [];
	return parseCatalog(data);
}

function createFixture(
	options: {
		enabled?: boolean;
		bindings?: Record<string, RoutingTestModel>;
		agent?: { kind: "main" | "sub"; id?: string; name: string; depth: number };
		model?: RoutingTestModel;
		sessionId?: string;
		suppressedSelectors?: readonly string[];
		cwd?: string;
		artifactsDir?: string;
		usageReports?: readonly unknown[];
		usageError?: Error;
		usageReportsImpl?: (options: { signal: AbortSignal }) => Promise<unknown>;
		oauthCredentials?: Record<string, readonly unknown[]>;
		oauthAccounts?: Record<string, readonly { provider: string; credentialId: number; email?: string }[]>;
		accountPin?: string;
		accountLabels?: string;
		experiment?: boolean;
		catalog?: Catalog;
		agentDir?: string;
	} = {},
): Fixture {
	const hooks: Record<string, Function> = {};
	const entries: Array<{ type: string; data: unknown }> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const workingMessages: Array<string | undefined> = [];
	const notifications: Array<[string, string | undefined]> = [];
	const oauthPins: Array<[string, number]> = [];
	const bindings = options.bindings ?? DEFAULT_BINDINGS;
	const models = { list: () => Object.values(bindings), resolve: (pattern: string) => bindings[pattern] };
	setExperimentAgentDirForTests(options.agentDir ?? scratchDir());
	if (options.accountPin !== undefined || options.accountLabels !== undefined) {
		setAccountPinIoForTests({
			pinText: () => options.accountPin,
			labelsText: () => options.accountLabels,
		});
	}
	if (options.catalog) {
		setCatalogForTests(options.catalog);
	} else if (options.experiment) {
		setCatalogForTests(splitTestCatalog());
	} else {
		const data = structuredClone(catalogData) as typeof catalogData & { experiment?: { enabled: boolean } };
		if (data.experiment) data.experiment.enabled = false;
		data.poolLimits.ignoreQuota = [];
		setCatalogForTests(parseCatalog(data));
	}
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
				listOAuthAccounts: (provider: string) => options.oauthAccounts?.[provider] ?? [],
				pinSessionOAuthAccount: (provider: string, _sessionId: string, credentialId: number) => {
					oauthPins.push([provider, credentialId]);
					return true;
				},
			},
		},
		models,
	};
	hooks.session_start?.({}, ctx);
	return { hooks, entries, statuses, workingMessages, notifications, ctx, oauthPins };
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
	slotChoice = undefined;
	slotConfidence = 0.98;
	slotAnswer = "ok";
	slotProbabilities = undefined;
	routeChoice = undefined;
	routeConfidence = 0.98;
	difficultyScore = 1;
	difficultyConfidence = 0.9;
	judgeCalls = 0;
	personaChoice = "normal";
	judgeRequests.length = 0;
	resetSpeedPoolStateForTests();
}

function usageReport(provider: string, modelId: string, fetchedAt = Date.now(), used = 0.1, weeklyUsed = used): Record<string, unknown> {
	const shortDuration = 5 * 60 * 60 * 1000;
	const weeklyDuration = 7 * 24 * 60 * 60 * 1000;
	const limit = (id: string, durationMs: number, value: number, elapsed: number, shared = false) => ({
		id,
		label: id,
		scope: { provider, ...(shared ? { shared: true } : {}) },
		window: { id, label: id, durationMs, resetsAt: fetchedAt + durationMs * (1 - elapsed) },
		amount: { unit: "percent", usedFraction: value },
	});
	// Anthropic reports only shared weekly windows: the 5-hour window was removed.
	if (provider === "anthropic")
		return { provider, fetchedAt, limits: [limit("anthropic:7d", weeklyDuration, weeklyUsed, 0.2, true), limit("anthropic:7d:fable", weeklyDuration, 0, 0.2, true)] };
	if (provider === "xai-oauth")
		return { provider, fetchedAt, limits: [limit("xai-oauth:credits:weekly", weeklyDuration, used, 0.2), limit("xai-oauth:credits:monthly", 30 * 24 * 60 * 60 * 1000, used, 0.2)] };
	return { provider, fetchedAt, limits: [limit(`${provider}:${modelId}:5h`, shortDuration, used, 0.2), limit(`${provider}:${modelId}:weekly`, weeklyDuration, used, 0.2)] };
}

/** Provider-wide usage at `used`; Anthropic and Codex windows are shared by every model of the provider. */
function usage(provider: string, used = 0.1, fetchedAt = Date.now()): Record<string, unknown> {
	if (provider !== "openai-codex") return usageReport(provider, "", fetchedAt, used);
	const shortDuration = 5 * 60 * 60 * 1000;
	const weeklyDuration = 7 * 24 * 60 * 60 * 1000;
	const limit = (id: string, durationMs: number) => ({
		id,
		label: id,
		scope: { provider, shared: true },
		window: { id, label: id, durationMs, resetsAt: fetchedAt + durationMs * 0.8 },
		amount: { unit: "percent", usedFraction: used },
	});
	return { provider, fetchedAt, limits: [limit("openai-codex:5h", shortDuration), limit("openai-codex:7d", weeklyDuration)] };
}
const ON_PACE = [usage("anthropic"), usage("xai-oauth"), usage("openai-codex")];

const personaRegistry = () =>
	(globalThis as Record<symbol, Map<string, { persona: string }> | undefined>)[Symbol.for("omp.persona-suggestions.v1")];

describe("persona suggestions", () => {
	const main = { kind: "main" as const, id: "main", name: "main", depth: 0 };

	test("hands a confident brute pick for exact work to session-persona under the child's key", async () => {
		reset();
		routeChoice = "code";
		difficultyScore = 0;
		personaChoice = "brute";
		const fixture = createFixture({ agent: main, usageReports: [usageReport("xai-oauth", "grok-4.6")] });
		const result = await spawn(fixture, { spawnKey: "Renamer" });
		expect(judgeCalls).toBe(1);
		expect(personaRegistry()?.get("main:Renamer")?.persona).toBe("brute");
		expect(result.note).toContain("suggests brute persona");
		expect(decisionData(fixture)).toMatchObject({ persona: "brute" });
		personaRegistry()?.delete("main:Renamer");
	});

	test("caps brute to normal above the catalog's difficulty ceiling", async () => {
		reset();
		routeChoice = "code";
		difficultyScore = 2;
		personaChoice = "brute";
		const fixture = createFixture({ agent: main, usageReports: [usageReport("xai-oauth", "grok-4.6")] });
		const result = await spawn(fixture, { spawnKey: "Migrator" });
		expect(personaRegistry()?.get("main:Migrator")?.persona).toBe("normal");
		expect(result.note).not.toContain("persona");
		personaRegistry()?.delete("main:Migrator");
	});

	test("asks no persona question for agents outside the catalog list or without a spawn key", async () => {
		reset();
		routeChoice = "code";
		personaChoice = "brute";
		const fixture = createFixture({ agent: main, usageReports: [usageReport("xai-oauth", "grok-4.6")] });
		await spawn(fixture, { agent: "scout", spawnKey: "Looker" });
		await spawn(fixture);
		expect(judgeRequests.every(request => request.questions.persona === undefined)).toBe(true);
		expect(personaRegistry()?.has("main:Looker") ?? false).toBe(false);
	});
});

describe("intelligent auto-agents runtime", () => {
	test("routes a covered agent through its task-type pool without persisting task text", async () => {
		reset();
		routeChoice = "code";
		const fixture = createFixture({ usageReports: ON_PACE });

		const result = await spawn(fixture);

		expect(result).toMatchObject({ thinkingLevel: "low" });
		expect(result.model).toEqual([
			"anthropic/claude-sonnet-5-5",
			"openai-codex/gpt-6.1-terra:high",
			"xai-oauth/grok-4.6:low",
			"opencode-go/hy4-flash-free:low",
			"opencode-go/deepseek-v4.1-flash:low",
		]);
		const data = decisionData(fixture);
		expect(data).toMatchObject({ codingSlot: "Moderate difficulty", difficulty: "ordinary" });
		expect(data.pool).toMatchObject({ active: "anthropic/claude-sonnet-5-5" });
		expect(JSON.stringify(data)).not.toContain("ASSIGNMENT_TEXT");
		expect(judgeRequests[0].state).toContain("Routing guidance:");
	});

	test("worker sessions pin the OAuth login email from the local pin file", () => {
		reset();
		const fixture = createFixture({
			agent: { kind: "sub", name: "task", depth: 1 },
			sessionId: "session-worker",
			accountPin: "anthropic: extra@example.com",
			oauthAccounts: {
				anthropic: [
					{ provider: "anthropic", credentialId: 1, email: "primary@example.com" },
					{ provider: "anthropic", credentialId: 2, email: "extra@example.com" },
				],
			},
		});
		expect(fixture.oauthPins).toEqual([["anthropic", 2]]);
	});

	test("main sessions ignore the worker account pin file", () => {
		reset();
		const fixture = createFixture({
			accountPin: "anthropic: extra@example.com",
			oauthAccounts: {
				anthropic: [{ provider: "anthropic", credentialId: 2, email: "extra@example.com" }],
			},
		});
		expect(fixture.oauthPins).toEqual([]);
	});



	test("case: DLG-001 routes bounded scout evidence through economical mechanical work", async () => {
		reset();
		difficultyScore = 0;
		const fixture = createFixture({ usageReports: ON_PACE });
		const result = await spawn(fixture, { agent: "scout" });

		// Scout is fixed to the Mechanical slot and never asked for difficulty, so Speed's mechanical pool serves it.
		expect(result).toMatchObject({ thinkingLevel: "low" });
		expect(result.model).toEqual([
			"anthropic/claude-sonnet-5-5",
			"openai-codex/gpt-6.1-terra:low",
			"xai-oauth/grok-4.6:low",
			"opencode-go/hy4-flash-free:high",
			"opencode-go/deepseek-v4.1-flash:high",
		]);
		expect(decisionData(fixture).pool).toMatchObject({ active: "anthropic/claude-sonnet-5-5" });
		expect(judgeCalls).toBe(0);
	});

	test("case: DLG-003 blocks a scout asked to make architecture or root-cause judgments", async () => {
		reset();
		const leadJob = await spawn(createFixture({ usageReports: ON_PACE }), { agent: "scout", assignment: "Directive: use investigation" });
		expect(leadJob).toMatchObject({ block: true });
		expect(leadJob.reason).toMatch(/reframe/i);

		reset();
		const codeJob = await spawn(createFixture({ usageReports: ON_PACE }), { agent: "scout", assignment: "Directive: use code" });
		expect(codeJob).toMatchObject({ block: true });
		expect(codeJob.reason).toMatch(/reframe/i);

		reset();
		const mechanicalJob = await spawn(createFixture({ usageReports: ON_PACE }), {
			agent: "scout",
			assignment: "Directive: use mechanical",
		});
		expect(mechanicalJob.block).toBeUndefined();
	});

	test("case: DLG-004 blocks uncertain automatic type or difficulty for parent clarification", async () => {
		reset();
		routeChoice = "lead";
		routeConfidence = 0.4;
		const uncertainType = createFixture({ usageReports: ON_PACE });
		const typeResult = await spawn(uncertainType);
		expect(typeResult).toMatchObject({ block: true });
		expect(typeResult.reason).toContain("Parent clarification required");

		reset();
		routeChoice = "lead";
		difficultyConfidence = 0.4;
		const uncertainDifficulty = createFixture({ usageReports: ON_PACE });
		const difficultyResult = await spawn(uncertainDifficulty);
		expect(difficultyResult).toMatchObject({ block: true });
		expect(difficultyResult.reason).toContain("Parent clarification required");
		expect(decisionData(uncertainDifficulty)).toMatchObject({ choice: "lead", reason: "uncertain-difficulty" });

		// A slot task type (code) asks no difficulty, so only a difficulty-rated task type can block on it.
		reset();
		difficultyConfidence = 0.4;
		const taskTypeDirective = createFixture({ usageReports: ON_PACE });
		const directiveResult = await spawn(taskTypeDirective, { assignment: "Directive: use investigation" });
		expect(directiveResult).toMatchObject({ block: true });
		expect(directiveResult.reason).toContain("Parent clarification required");
		expect(decisionData(taskTypeDirective)).toMatchObject({ source: "baseline", reason: "uncertain-difficulty" });
	});

	test("case: DLG-005 accepts a clarified resubmission without persistent retry state", async () => {
		reset();
		routeChoice = "lead";
		routeConfidence = 0.4;
		const fixture = createFixture({ usageReports: ON_PACE });
		expect(await spawn(fixture)).toMatchObject({ block: true });

		routeChoice = "code";
		routeConfidence = 0.98;
		difficultyConfidence = 0.9;
		const result = await spawn(fixture);
		expect(result).toMatchObject({ thinkingLevel: "low" });
		expect(result.block).toBeUndefined();
		expect(decisionData(fixture)).toMatchObject({ codingSlot: "Moderate difficulty" });
	});

	test("case: DLG-006 declines all automatic medium/slow selectors as chat-only", async () => {
		for (const agent of ["medium", "slow1", "slow2", "slow3"]) {
			reset();
			routeChoice = "code";
			routeConfidence = 0.98;
			difficultyScore = 1;
			difficultyConfidence = 0.9;
			const fixture = createFixture();
			const result = await spawn(fixture, { agent, patterns: ["@frontier-1"] });

			expect(result).toMatchObject({ block: true });
			expect(result.model).toBeUndefined();
			expect(result.reason).toContain("chat-only");
			expect(result.reason).toContain("choose a supported worker job instead");
			expect(judgeCalls).toBe(0);
			expect(decisionData(fixture)).toMatchObject({ source: "baseline", reason: "chat-only-selector" });
		}
	});

	test("case: DLG-007 leaves an explicit pinned review request on its baseline", async () => {
		reset();
		judgeError = new Error("judge down");
		const fixture = createFixture();
		const result = await spawn(fixture, { agent: "review-frontier-1", patterns: ["@frontier-1"] });

		expect(result).toBeUndefined();
		expect(decisionData(fixture)).toMatchObject({ source: "baseline", reason: "routing-unavailable" });
	});

	test("case: DLG-007 preserves a named model when its optional effort rating is unavailable", async () => {
		reset();
		judgeError = new Error("judge down");
		const fixture = createFixture();
		const result = await spawn(fixture, { assignment: "Directive: use xai-oauth/grok-4.6" });

		expect(result.model).toEqual(["xai-oauth/grok-4.6"]);
		expect(result.block).toBeUndefined();
		expect(decisionData(fixture).reason).toBe("routing-unavailable");
	});

	test("case: DLG-008 applies Codex quota gates in the spawn hook when no provider is ignored", async () => {
		reset();
		routeChoice = "code";
		difficultyScore = 1;
		const fixture = createFixture({
			catalog: parseCatalog(catalogData),
			usageReports: [usage("anthropic", 0.99), usage("xai-oauth", 0.99), usage("openai-codex", 0.99)],
		});
		const result = await spawn(fixture);

		// Every frontier-tier member over quota is skipped; the speed pool's OpenCode members serve the job.
		expect(result).toMatchObject({
			model: ["opencode-go/hy4-flash-free", "opencode-go/deepseek-v4.1-flash:low"],
			thinkingLevel: "low",
		});
		expect(decisionData(fixture).pool).toMatchObject({
			verdicts: { "openai-codex/gpt-6.1-terra": { status: "skipped" } },
		});
	});

	// The lead pool's third frontier raises the primary's effort by one step; the fallback stays explicit.
	for (const [taskType, agent, difficulty, level, primaryEffort, grokEffort] of [
		["lead", "task", "hard", 2, "high", "xhigh"],
		["lead", "task", "critical", 3, "xhigh", "xhigh"],
		["plan", "plan", "exact", 0, "medium", "high"],
		["plan", "plan", "ordinary", 1, "medium", "high"],
		["plan", "plan", "hard", 2, "high", "xhigh"],
		["security-review", "security-reviewer", "critical", 3, "xhigh", "xhigh"],
	] as const) {
		for (const [condition, weeklyUsed, codexUsed, xaiUsed, stage] of [
			["healthy", 0.05, 0.1, 0.1, 0],
			["weekly headroom at minimum", 0.15, 0.1, 0.1, 0],
			["weekly headroom below minimum", 0.16, 0.1, 0.1, 1],
			["Anthropic gated, Codex gated", 0.16, 0.99, 0.1, 2],
			["Anthropic, Codex, and xAI gated", 0.16, 0.99, 0.99, 3],
		] as const) {
			test(`${taskType} ${difficulty} routes with ${condition}`, async () => {
				reset();
				readinessChoice = "autonomous-plan";
				routeChoice = taskType;
				difficultyScore = level;
				const fixture = createFixture({
					usageReports: [
						usageReport("anthropic", "", Date.now(), weeklyUsed, weeklyUsed),
						usage("openai-codex", codexUsed),
						usage("xai-oauth", xaiUsed),
					],
				});
				const result = await spawn(fixture, { agent });
				const opus = "anthropic/claude-opus-5-5";
				const sol = "openai-codex/gpt-6.1-sol";
				const grok = "xai-oauth/grok-4.6";
				const activeEffort = stage === 0 || stage === 1 ? primaryEffort : stage === 2 ? grokEffort : "high";
				expect(result.thinkingLevel).toBe(activeEffort);
				expect(result.model).toEqual(
					stage === 0 ? [opus, `${sol}:${primaryEffort}`, `${grok}:${grokEffort}`]
					: stage === 1 ? [`${sol}`, `${grok}:${grokEffort}`]
					: stage === 2 ? [grok]
					: ["opencode-go/deepseek-v4.1-flash"],
				);
			});
		}
	}

	test("rollover follows the rebound frontier role while retaining frontier-1's effort", async () => {
		reset();
		readinessChoice = "autonomous-plan";
		routeChoice = "plan";
		difficultyScore = 1;
		const fixture = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@frontier-2": GROK, "@frontier-3": SOL },
			usageReports: [usage("anthropic", 0.99), usage("xai-oauth"), usage("openai-codex")],
		});
		expect(await spawn(fixture, { agent: "plan" })).toMatchObject({
			model: ["xai-oauth/grok-4.6", "openai-codex/gpt-6.1-sol:high"], thinkingLevel: "medium",
		});

		reset();
		routeChoice = "lead";
		difficultyScore = 3;
		const capped = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@frontier-2": GROK, "@frontier-3": SOL },
			usageReports: [usage("anthropic", 0.99), usage("xai-oauth", 0.99), usage("openai-codex")],
		});
		// Sol supports max, but the third frontier's uplift must still stop at the task ceiling.
		expect(await spawn(capped)).toMatchObject({
			model: ["openai-codex/gpt-6.1-sol"], thinkingLevel: "xhigh",
		});
	});

	test("rollover preserves the source model's effort ceiling before applying the third-frontier step", async () => {
		reset();
		routeChoice = "lead";
		difficultyScore = 2;
		const fixture = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@frontier-1": DEFAULT_BINDINGS["anthropic/claude-sonnet-5-5"] },
			usageReports: [usage("anthropic", 0.99), usage("openai-codex"), usage("xai-oauth")],
		});
		expect(await spawn(fixture)).toMatchObject({
			model: ["openai-codex/gpt-6.1-sol", "xai-oauth/grok-4.6:xhigh"], thinkingLevel: "high",
		});
	});

	test("Grok rollover follows its rebound role and raises the primary's effort", async () => {
		reset();
		readinessChoice = "autonomous-plan";
		routeChoice = "plan";
		difficultyScore = 1;
		const fixture = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@frontier-3": model("grok-rebound", ["low", "medium", "high", "xhigh"], "xai-oauth") },
			usageReports: [usage("anthropic", 0.99), usage("openai-codex"), usage("xai-oauth")],
		});
		expect(await spawn(fixture, { agent: "plan" })).toMatchObject({
			model: ["openai-codex/gpt-6.1-sol", "xai-oauth/grok-rebound:high"], thinkingLevel: "medium",
		});
	});

	test("an unavailable effort source uses the explicit fallback instead of a rollover's own map", async () => {
		reset();
		routeChoice = "lead";
		difficultyScore = 2;
		const bindings = { ...DEFAULT_BINDINGS };
		delete bindings["@frontier-1"];
		const fixture = createFixture({ bindings, usageReports: ON_PACE });
		expect(await spawn(fixture)).toMatchObject({
			model: ["opencode-go/deepseek-v4.1-flash"], thinkingLevel: "high",
		});
	});

	test("lead uses an eligible rebound frontier-2 from the pool", async () => {
		reset();
		routeChoice = "lead";
		difficultyScore = 0;
		const fixture = createFixture({
			bindings: { ...DEFAULT_BINDINGS, "@frontier-2": model("fallback-rebound", ["high", "xhigh"], "openai-codex") },
			usageReports: [usage("anthropic", 0.99), usage("openai-codex"), usage("xai-oauth", 0.99)],
		});
		expect(await spawn(fixture)).toMatchObject({ model: ["openai-codex/fallback-rebound"], thinkingLevel: "high" });
	});

	test("lead keeps a provider-failure retry chain and rolls past a suppressed Opus selector", async () => {
		reset();
		routeChoice = "lead";
		difficultyScore = 3;
		const fixture = createFixture({
			usageReports: ON_PACE,
			suppressedSelectors: ["anthropic/claude-opus-5-5:xhigh"],
		});
		expect(await spawn(fixture)).toMatchObject({
			model: ["openai-codex/gpt-6.1-sol", "xai-oauth/grok-4.6:xhigh"],
			thinkingLevel: "xhigh",
		});
		expect(decisionData(fixture).rollover).toEqual({
			from: "anthropic/claude-opus-5-5",
			to: "openai-codex/gpt-6.1-sol",
		});
	});

	test("rolls over across providers, not across models of one provider", async () => {
		reset();
		routeChoice = "code";
		// An exhausted Codex quota skips Terra; the pool's next member is Sonnet on Anthropic.
		const codexOut = await spawn(
			createFixture({ usageReports: [usage("anthropic"), usage("xai-oauth"), usage("openai-codex", 0.99)] }),
		);
		expect(codexOut).toMatchObject({
			model: ["anthropic/claude-sonnet-5-5", "xai-oauth/grok-4.6:low", "opencode-go/hy4-flash-free:low", "opencode-go/deepseek-v4.1-flash:low"],
			thinkingLevel: "low",
		});

		reset();
		routeChoice = "code";
		// Anthropic and xAI exhausted: Terra is the first Codex model still eligible and is not replaced by another Codex model.
		const twoOut = await spawn(
			createFixture({ usageReports: [usage("anthropic", 0.99), usage("xai-oauth", 0.99), usage("openai-codex")] }),
		);
		expect(twoOut).toMatchObject({
			model: ["openai-codex/gpt-6.1-terra", "opencode-go/hy4-flash-free:low", "opencode-go/deepseek-v4.1-flash:low"],
			thinkingLevel: "high",
		});

		reset();
		routeChoice = "code";
		const allOutOptions = { usageReports: [usage("anthropic", 0.99), usage("xai-oauth", 0.99), usage("openai-codex", 0.99)] };
		// Demote Anthropic's first Moderate member; the next served model is Codex Terra, not another Anthropic model.
		for (const sessionId of ["demote-1", "demote-2"]) {
			const routed = createFixture({ usageReports: ON_PACE });
			await spawn(routed);
			const child = createFixture({
				agent: { kind: "sub", name: "task", depth: 1 },
				model: DEFAULT_BINDINGS["anthropic/claude-sonnet-5-5"],
				sessionId,
			});
			child.hooks.agent_end?.(
				{ messages: [{ role: "assistant", provider: "other", model: "other", stopReason: "stop" }], willContinue: false },
				child.ctx,
			);
		}
		const afterDemote = await spawn(createFixture({ usageReports: ON_PACE }));
		expect(afterDemote).toMatchObject({
			model: ["openai-codex/gpt-6.1-terra", "xai-oauth/grok-4.6:low", "opencode-go/hy4-flash-free:low", "opencode-go/deepseek-v4.1-flash:low"],
			thinkingLevel: "high",
		});

		reset();
		routeChoice = "mechanical";
		expect(await spawn(createFixture(allOutOptions))).toMatchObject({
			model: ["opencode-go/hy4-flash-free", "opencode-go/deepseek-v4.1-flash:high"],
			thinkingLevel: "high",
		});

		reset();
		difficultyScore = 2;
		routeChoice = "review";
		expect(await spawn(createFixture(allOutOptions), { agent: "reviewer" })).toMatchObject({
			model: ["opencode-go/deepseek-v4.1-flash"],
			thinkingLevel: "high",
		});
	});

	test("feature work keeps Sol first on pace and alone when others are over weekly pace", async () => {
		reset();
		slotChoice = "Feature work";
		routeChoice = "code";
		const onPace = await spawn(createFixture({ usageReports: ON_PACE }));
		expect(onPace).toMatchObject({
			model: [
				"anthropic/claude-sonnet-5-5",
				"openai-codex/gpt-6.1-sol:medium",
				"xai-oauth/grok-4.6:high",
				"opencode-go/hy4-flash-free:high",
				"opencode-go/deepseek-v4.1-flash:low",
			],
			thinkingLevel: "high",
		});

		reset();
		slotChoice = "Feature work";
		routeChoice = "code";
		// Anthropic/xAI are over weekly pace; Codex remains on pace and is eligible.
		const overPace = [usage("anthropic", 0.5), usage("xai-oauth", 0.5), usage("openai-codex", 0.1)];
		const fixture = createFixture({ usageReports: overPace });
		expect(await spawn(fixture)).toMatchObject({
			model: ["openai-codex/gpt-6.1-sol", "opencode-go/hy4-flash-free:high", "opencode-go/deepseek-v4.1-flash:low"],
			thinkingLevel: "medium",
		});
		expect(decisionData(fixture).pool).toMatchObject({ active: "openai-codex/gpt-6.1-sol" });
	});

	for (const [difficulty, level, solEffort] of [
		["exact", 0, "low"],
		["ordinary", 1, "medium"],
		["hard", 2, "high"],
		["critical", 3, "xhigh"],
	] as const) {
		test(`${difficulty} review keeps Sol when others are over weekly pace`, async () => {
			reset();
			difficultyScore = level;
			routeChoice = "review";
			const onPace = await spawn(createFixture({ usageReports: ON_PACE }), { agent: "reviewer" });
			expect(onPace.model.at(-1)).toBe(`openai-codex/gpt-6.1-sol:${solEffort}`);

			reset();
			difficultyScore = level;
			routeChoice = "review";
			const overPace = [usage("anthropic", 0.5), usage("xai-oauth", 0.5), usage("openai-codex", 0.1)];
			expect(await spawn(createFixture({ usageReports: overPace }), { agent: "reviewer" })).toMatchObject({
				model: ["openai-codex/gpt-6.1-sol"],
				thinkingLevel: solEffort,
			});
		});
	}

	test("a git spawn routes through the commit pool without a task-type question", async () => {
		reset();
		difficultyScore = 0;
		routeChoice = "lead";
		const fixture = createFixture({ usageReports: ON_PACE });
		const result = await spawn(fixture, { agent: "git" });
		expect(result).toMatchObject({
			model: [
				"anthropic/claude-sonnet-5-5",
				"openai-codex/gpt-6.1-terra:low",
				"xai-oauth/grok-4.6:low",
				"opencode-go/hy4-flash-free:high",
				"opencode-go/deepseek-v4.1-flash:high",
			],
			thinkingLevel: "low",
		});
		expect(decisionData(fixture)).toMatchObject({ slot: "commit" });
		expect(judgeCalls).toBe(0);

		reset();
		difficultyScore = 0;
		routeChoice = "lead";
		const directed = createFixture({ usageReports: ON_PACE });
		await spawn(directed, { agent: "git", assignment: "Resolve it\nDirective: use code\n" });
		expect(decisionData(directed)).toMatchObject({ slot: "code" });
	});

	test("a Directive line wins over the pool and pins the model", async () => {
		reset();
		routeChoice = "code";
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
		expect(result.thinkingLevel).toBe("medium");
		expect(decisionData(fixture)).toMatchObject({ slot: "pinned" });
	});

	test("a pinned agent with no routable effort keeps the baseline", async () => {
		reset();
		const fixture = createFixture();
		const result = await spawn(fixture, { agent: "review-frontier-1", patterns: ["@missing"] });
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
		expect(result.model[0]).toBe("anthropic/claude-opus-5-5");
	});

	test("case: DLG-004 a failed automatic difficulty rating blocks for parent clarification", async () => {
		reset();
		judgeError = new Error("judge down");
		routeChoice = "code";
		const fixture = createFixture();
		const result = await spawn(fixture);
		expect(result).toMatchObject({ block: true });
		expect(result.reason).toContain("Parent clarification required");
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
		await fixture.hooks.before_subagent_spawn?.(routeEvent({ agent: "plan" }), fixture.ctx);

		// Readiness and difficulty are separate Jev calls, so their usage is summed.
		expect(decisionData(fixture)).toMatchObject({ slot: "plan", usage: { totalTokens: 40 } });
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
		routeChoice = "code";
		const fixture = createFixture();
		await spawn(fixture, { agent: "task" });
		expect(judgeRequests.every(request => !Object.keys(request.questions.route?.criteria ?? {}).includes("discuss-with-user"))).toBe(true);
	});

	test("solutionSpace is fed to Jev but never persisted", async () => {
		reset();
		routeChoice = "code";
		const fixture = createFixture();
		await spawn(fixture, { solutionSpace: "SOLUTION_SPACE_TEXT" });
		expect(judgeRequests[0].state).toContain("SOLUTION_SPACE_TEXT");
		expect(JSON.stringify(decisionData(fixture))).not.toContain("SOLUTION_SPACE_TEXT");
	});

	test("skips a suppressed pool member for the next route", async () => {
		reset();
		difficultyScore = 0;
		routeChoice = "code";
		// Sonnet is suppressed at its pinned effort, so exact work rolls over to the next provider.
		const fixture = createFixture({
			usageReports: ON_PACE,
			suppressedSelectors: ["anthropic/claude-sonnet-5-5:low"],
		});
		const result = await spawn(fixture);
		expect(result.model[0]).toBe("openai-codex/gpt-6.1-terra");
		expect(decisionData(fixture).rollover).toMatchObject({ from: "anthropic/claude-sonnet-5-5" });
	});

	test("usage fetch failure still routes through the declared pool order", async () => {
		reset();
		routeChoice = "code";
		const fixture = createFixture({ usageError: new Error("usage unavailable") });
		const result = await spawn(fixture);
		expect(result.model[0]).toBe("anthropic/claude-sonnet-5-5");
		expect(decisionData(fixture).pool).toMatchObject({ status: "no-usage" });
	});

	test("keeps the routed member when a pool member is over quota", async () => {
		reset();
		routeChoice = "code";
		const fixture = createFixture({ usageReports: [usageReport("xai-oauth", "grok-4.6", Date.now(), 0.99), usageReport("anthropic", "claude-opus-5-5")] });
		const result = await spawn(fixture);
		expect(result.model[0]).not.toBe("xai-oauth/grok-4.6");
		expect(decisionData(fixture).pool).toMatchObject({ skipped: expect.arrayContaining(["xai-oauth/grok-4.6"]) });
	});

	test("records a child failure as a rollover and leaves an abort unchanged", async () => {
		reset();
		routeChoice = "code";
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
		routeChoice = "code";
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

describe("slot routing outcomes", () => {
	for (const [mode, slot, model, effort] of [
		["speed", "Mechanical", "anthropic/claude-sonnet-5-5", "low"],
		["speed", "Moderate difficulty", "anthropic/claude-sonnet-5-5", "low"],
		["speed", "Feature work", "anthropic/claude-sonnet-5-5", "high"],
		["cost", "Mechanical", "anthropic/claude-haiku-5-5", "low"],
		["cost", "Moderate difficulty", "anthropic/claude-haiku-5-5", "high"],
		["cost", "Feature work", "anthropic/claude-haiku-5-5", "high"],
	] as const) {
		test(`${mode} ${slot} starts on the slot's first member`, async () => {
			reset();
			routeChoice = "code";
			slotChoice = slot;
			const fixture = createFixture({
				usageReports: ON_PACE,
				...(mode === "cost" ? { catalog: catalogInMode("cost") } : {}),
			});
			const result = await spawn(fixture);
			expect(result.block).toBeUndefined();
			expect(result.model[0]).toBe(model);
			expect(result.thinkingLevel).toBe(effort);
		});
	}

	test("a low-confidence slot answer takes the higher of the two likeliest and does not block", async () => {
		reset();
		routeChoice = "code";
		slotChoice = "Moderate difficulty";
		slotConfidence = 0.5;
		slotProbabilities = {
			Mechanical: 0.2,
			"Moderate difficulty": 0.45,
			"Feature work": 0.35,
		};
		const fixture = createFixture({ usageReports: ON_PACE });
		const result = await spawn(fixture);
		expect(result.block).toBeUndefined();
		expect(result.model[0]).toBe("anthropic/claude-sonnet-5-5");
		expect(result.thinkingLevel).toBe("high");
	});

	for (const answer of ["missing", "invalid"] as const) {
		test(`${answer} slot answer uses Feature work and does not block`, async () => {
			reset();
			routeChoice = "code";
			slotAnswer = answer;
			const fixture = createFixture({ usageReports: ON_PACE });
			const result = await spawn(fixture);
			expect(result.block).toBeUndefined();
			expect(result.model[0]).toBe("anthropic/claude-sonnet-5-5");
			expect(result.thinkingLevel).toBe("high");
		});
	}

	for (const agent of ["git", "scout"] as const) {
		test(`${agent} uses the Mechanical slot pool`, async () => {
			reset();
			const fixture = createFixture({ usageReports: ON_PACE });
			const result = await spawn(fixture, { agent });
			expect(result.block).toBeUndefined();
			expect(result).toMatchObject({
				model: [
					"anthropic/claude-sonnet-5-5",
					"openai-codex/gpt-6.1-terra:low",
					"xai-oauth/grok-4.6:low",
					"opencode-go/hy4-flash-free:high",
					"opencode-go/deepseek-v4.1-flash:high",
				],
				thinkingLevel: "low",
			});
		});
	}

	for (const [difficulty, level, first, effort] of [
		["exact", 0, "anthropic/claude-sonnet-5-5", "high"],
		["ordinary", 1, "anthropic/claude-sonnet-5-5", "high"],
		["hard", 2, "anthropic/claude-opus-5-5", "high"],
		["critical", 3, "anthropic/claude-opus-5-5", "high"],
	] as const) {
		test(`investigation ${difficulty} starts on ${first} at ${effort}`, async () => {
			reset();
			routeChoice = "investigation";
			difficultyScore = level;
			const fixture = createFixture({ usageReports: ON_PACE });
			const result = await spawn(fixture);
			expect(result.block).toBeUndefined();
			expect(result.model[0]).toBe(first);
			expect(result.thinkingLevel).toBe(effort);
		});
	}

	for (const [difficulty, level, solEffort] of [
		["exact", 0, "medium"],
		["ordinary", 1, "medium"],
		["hard", 2, "high"],
		["critical", 3, "high"],
	] as const) {
		test(`investigation ${difficulty} skips gated Anthropic for Sol then Grok 4.7`, async () => {
			reset();
			routeChoice = "investigation";
			difficultyScore = level;
			const fixture = createFixture({
				usageReports: [usage("anthropic", 0.99), usage("openai-codex"), usage("xai-oauth")],
			});
			const result = await spawn(fixture);
			expect(result.block).toBeUndefined();
			expect(result).toMatchObject({
				model: ["openai-codex/gpt-6.1-sol", "xai-oauth/grok-4.7:high"],
				thinkingLevel: solEffort,
			});
		});
	}

	for (const target of [
		"openai-codex/gpt-6.2-astra",
		"openai-codex/gpt-5.6-luna",
		"anthropic/claude-fable-5-2",
	]) {
		test(`a Directive naming ${target} always routes to it`, async () => {
			reset();
			const fixture = createFixture();
			const result = await spawn(fixture, { assignment: `Directive: use ${target}` });
			expect(result.block).toBeUndefined();
			expect(result).toMatchObject({ model: [target] });
		});
	}

	test("a Directive naming a quota-skipped model still routes to it", async () => {
		reset();
		const fixture = createFixture({ usageReports: [usage("anthropic", 0.99), usage("openai-codex", 0.99), usage("xai-oauth", 0.99)] });
		const result = await spawn(fixture, { assignment: "Directive: use anthropic/claude-sonnet-5-5 high" });
		expect(result).toMatchObject({ model: ["anthropic/claude-sonnet-5-5"], thinkingLevel: "high" });
	});

	test("a Directive effort is not capped by the catalog maxEffort", async () => {
		reset();
		const fixture = createFixture();
		const result = await spawn(fixture, { assignment: "Directive: use anthropic/claude-haiku-5-5 max" });
		expect(result).toMatchObject({ model: ["anthropic/claude-haiku-5-5"], thinkingLevel: "max" });
	});

	test("a scout with a Directive model goes to that model even at high difficulty", async () => {
		reset();
		difficultyScore = 3;
		const fixture = createFixture();
		const result = await spawn(fixture, { agent: "scout", assignment: "Directive: use openai-codex/gpt-6.2-astra" });
		expect(result.block).toBeUndefined();
		expect(result).toMatchObject({ model: ["openai-codex/gpt-6.2-astra"] });
	});

	test("a Directive model bypasses planning readiness, the chat-only block, unknown agents, and routing off", async () => {
		reset();
		readinessChoice = "discuss-with-user";
		const plan = await spawn(createFixture(), { agent: "plan", assignment: "Directive: use openai-codex/gpt-6.2-astra" });
		expect(plan).toMatchObject({ model: ["openai-codex/gpt-6.2-astra"] });

		const chatOnly = await spawn(createFixture(), { agent: "slow1", assignment: "Directive: use anthropic/claude-fable-5-2" });
		expect(chatOnly).toMatchObject({ model: ["anthropic/claude-fable-5-2"] });

		const ghost = await spawn(createFixture(), { agent: "ghost", assignment: "Directive: use openai-codex/gpt-5.6-luna low" });
		expect(ghost).toMatchObject({ model: ["openai-codex/gpt-5.6-luna"], thinkingLevel: "low" });

		const pinned = await spawn(createFixture(), { agent: "design-master", assignment: "Directive: use xai-oauth/grok-4.6 high" });
		expect(pinned).toMatchObject({ model: ["xai-oauth/grok-4.6"], thinkingLevel: "high" });

		const off = await spawn(createFixture({ enabled: false }), { assignment: "Directive: use openai-codex/gpt-5.6-luna high" });
		expect(off).toMatchObject({ model: ["openai-codex/gpt-5.6-luna"], thinkingLevel: "high" });
	});

	test("empty ignoreQuota paces OpenAI so over-skipAt Codex is skipped", async () => {
		reset();
		routeChoice = "code";
		slotChoice = "Feature work";
		const fixture = createFixture({
			usageReports: [usage("anthropic", 0.99), usage("openai-codex", 0.97), usage("xai-oauth")],
		});
		const result = await spawn(fixture);
		expect(result.block).toBeUndefined();
		expect(result.model[0]).toBe("xai-oauth/grok-4.6");
		expect(result.thinkingLevel).toBe("high");
	});
});


describe("split-test runtime", () => {
	const splitUsage = [
		usage("anthropic"),
		usage("openai-codex"),
		usage("openscale"),
		usage("xai-oauth"),
	];

	test("four jobs in one slot start on four candidates in catalog order", async () => {
		reset();
		routeChoice = "code";
		difficultyScore = 0;
		const fixture = createFixture({ experiment: true, usageReports: splitUsage });
		const started: string[] = [];
		for (let i = 0; i < 4; i++) {
			const result = await spawn(fixture);
			started.push(result.model[0]);
		}
		expect(started).toEqual([
			"anthropic/claude-haiku-5-5",
			"openai-codex/gpt-6.1-terra",
			"openscale/deepseek/deepseek-v4.1-flash-1017",
			"xai-oauth/grok-4.6",
		]);
	});

	test("a candidate at 99% is unavailable and the job still routes", async () => {
		reset();
		routeChoice = "code";
		difficultyScore = 0;
		const fixture = createFixture({
			experiment: true,
			usageReports: [usage("anthropic", 0.99), usage("openai-codex"), usage("openscale"), usage("xai-oauth")],
		});
		const result = await spawn(fixture);
		expect(result.model[0]).toBe("openai-codex/gpt-6.1-terra");
		expect(decisionData(fixture).experiment).toMatchObject({
			slot: "speed-moderate-difficulty/exact",
			fellBack: false,
			candidate: "openai-codex/gpt-6.1-terra",
			unavailable: ["anthropic/claude-haiku-5-5"],
		});
		expect(result.note).toContain("split test speed-moderate-difficulty/exact");
	});

	test("every candidate unavailable falls back to the pool and records fellBack", async () => {
		reset();
		routeChoice = "code";
		difficultyScore = 1;
		const fixture = createFixture({
			experiment: true,
			usageReports: [usage("anthropic", 0.99), usage("openai-codex", 0.99), usage("openscale", 0.99), usage("xai-oauth", 0.99)],
		});
		const result = await spawn(fixture);
		expect(result).toMatchObject({
			model: ["opencode-go/hy4-flash-free", "opencode-go/deepseek-v4.1-flash:low"],
			thinkingLevel: "low",
		});
		expect(decisionData(fixture).experiment).toMatchObject({ slot: "speed-moderate-difficulty/ordinary", fellBack: true });
		expect(decisionData(fixture).experiment).not.toHaveProperty("candidate");
		expect(result.note).toContain("split test speed-moderate-difficulty/ordinary");
	});

	test("disabled or expired experiment matches a catalog with no experiment block", async () => {
		reset();
		routeChoice = "code";
		difficultyScore = 1;
		const without = structuredClone(catalogData) as typeof catalogData;
		const expiredCatalog = splitTestCatalog("2020-01-01T00:00:00Z");
		const noBlock = createFixture({ catalog: parseCatalog(without), usageReports: splitUsage });
		const disabled = createFixture({ experiment: false, usageReports: splitUsage });
		const past = createFixture({ catalog: expiredCatalog, usageReports: splitUsage });
		const expected = await spawn(noBlock);
		expect(await spawn(disabled)).toMatchObject({ model: expected.model, thinkingLevel: expected.thinkingLevel });
		expect(await spawn(past)).toMatchObject({ model: expected.model, thinkingLevel: expected.thinkingLevel });
		expect(decisionData(disabled).experiment).toBeUndefined();
		expect(decisionData(past).experiment).toBeUndefined();
	});

	test("an unlisted slot and a Directive route as before while the test is active", async () => {
		reset();
		routeChoice = "review";
		difficultyScore = 1;
		const activeReview = createFixture({ experiment: true, usageReports: splitUsage });
		const inactiveReview = createFixture({ experiment: false, usageReports: splitUsage });
		const reviewActive = await spawn(activeReview, { agent: "reviewer" });
		const reviewInactive = await spawn(inactiveReview, { agent: "reviewer" });
		expect(reviewActive.model).toEqual(reviewInactive.model);
		expect(reviewActive.thinkingLevel).toBe(reviewInactive.thinkingLevel);
		expect(decisionData(activeReview).experiment).toBeUndefined();

		reset();
		const activeDirective = createFixture({ experiment: true, usageReports: splitUsage });
		const result = await spawn(activeDirective, { assignment: "Directive: use xai-oauth/grok-4.6 low" });
		expect(result).toMatchObject({ model: ["xai-oauth/grok-4.6"], thinkingLevel: "low" });
		expect(decisionData(activeDirective).experiment).toBeUndefined();
	});

	test("Sonnet as a candidate at high receives high despite maxEffort low", async () => {
		reset();
		routeChoice = "code";
		difficultyScore = 3;
		const fixture = createFixture({
			experiment: true,
			usageReports: [usage("openai-codex", 0.99), usage("anthropic"), usage("openscale"), usage("xai-oauth")],
		});
		const result = await spawn(fixture);
		expect(result.model[0]).toBe("anthropic/claude-sonnet-5-5");
		expect(result.thinkingLevel).toBe("high");
		expect(decisionData(fixture).experiment).toMatchObject({
			candidate: "anthropic/claude-sonnet-5-5",
			effort: "high",
			fellBack: false,
		});
	});
});

