import { describe, expect, mock, test } from "bun:test";
import catalogData from "./catalog.json";
import type { Evaluate, PoolMember, Slot } from "./routing";

mock.module("@oh-my-pi/pi-ai", () => ({
	resolveUsedFraction: (limit: { amount: { usedFraction?: number; unit: string } }) => limit.amount.usedFraction,
	scopeAntigravityLimitsForModel: (report: { limits: unknown[] }) => report.limits,
	getAntigravityCounterKeyForModel: (modelId: string | undefined) => modelId,
	TypeSafeJudge: class {
		judge = async () => ({ answers: {} });
	},
}));

// The production module imports pi-ai helpers, so the mock must be registered before loading it.
const {
	EFFORTS,
	DIFFICULTY_NAMES,
	ORDINARY,
	parseCatalog,
	taskTypeEffortVaries,
	modelDifficultyEffort,
	clampEffort,
	capEffort,
	fitEffort,
	effortForModel,
	parseDirective,
	isLiteralModel,
	planProvenance,
	preferPlanReviewMembers,
	windowSamples,
	rankPool,
	choose,
	evaluatePlanningReadiness,
} = await import("./routing");

const catalog = parseCatalog(catalogData);

const member = (provider: string, id: string, extra: Partial<PoolMember> = {}): PoolMember => ({
	id: `${provider}/${id}`,
	model: { provider, id },
	penaltyKind: "short",
	...extra,
});

const evaluateFrom = (answers: Record<string, unknown>, usage?: Record<string, unknown>): Evaluate => async () =>
	usage ? { answers, usage } : { answers };

const choice = (id: string, ids: readonly string[], confidence = 0.9): Record<string, unknown> => ({
	type: "choice",
	choice: id,
	confidence,
	probabilities: Object.fromEntries(ids.map(candidate => [candidate, candidate === id ? 1 : 0])),
});
const score = (level: number, confidence = 0.9): Record<string, unknown> => ({ type: "score", score: level, confidence, probabilities: {} });

function report(provider: string, used: number, fetchedAt = Date.now()): Record<string, unknown> {
	const weekly = 7 * 24 * 60 * 60 * 1000;
	const window = (id: string, durationMs: number, shared = false) => ({
		id,
		label: id,
		scope: shared ? { provider, shared: true } : undefined,
		window: { id, label: id, durationMs, resetsAt: fetchedAt + durationMs * 0.8 },
		amount: { unit: "percent", usedFraction: used },
	});
	if (provider === "xai-oauth")
		return { provider, fetchedAt, limits: [window("xai-oauth:credits:weekly", weekly), window("xai-oauth:credits:monthly", 30 * 24 * 60 * 60 * 1000)] };
	return { provider, fetchedAt, limits: [window(`${provider}:5h`, 5 * 60 * 60 * 1000, true), window(`${provider}:weekly`, weekly, true)] };
}

describe("catalog v8", () => {
	test("parses the shipped catalog and its routing surface", () => {
		expect(catalog.version).toBe(8);
		expect(Object.keys(catalog.pools)).toEqual(["mechanical", "grunt", "plan-review"]);
		expect(Object.keys(catalog.taskTypes).sort()).toEqual([
			"frontier-review",
			"grunt",
			"lead",
			"mechanical",
			"plan",
			"plan-review",
			"security-review",
			"vision",
		]);
		expect(catalog.agents.covered).toEqual(["task", "sonic", "scout", "reviewer", "security-reviewer", "git", "plan"]);
		expect(catalog.agents.pinned).toContain("review-frontier-1");
		expect(catalog.agents.pinned).toContain("review-frontier-3");
		expect(catalog.directiveTargets).toMatchObject({ "frontier-1": "@frontier-1", grunt: "@grunt", vision: "@vision" });
		expect(catalog.nuances.length).toBeGreaterThan(0);
		expect(catalog.planningReadiness.agents).toEqual(["plan"]);
		expect(catalog.models["anthropic/claude-sonnet-5-5"].maxEffort).toBe("low");
		expect(catalog.reviewOnly.pools).toEqual(["plan-review"]);
		expect(catalog.poolLimits.burstPenaltyWindow["*"]).toBe("short");
		expect(catalog.blockedDirectiveTargets).toEqual(["luna", "astra"]);
		expect(catalog.jevInstructions.route.length).toBeGreaterThan(0);
	});

	test("rejects catalogs that break the routing contract", () => {
		const clone = (): Record<string, unknown> => structuredClone(catalogData) as Record<string, unknown>;
		const wrongVersion = clone();
		wrongVersion.version = 6;
		expect(() => parseCatalog(wrongVersion)).toThrow("settings");

		const missingPool = clone();
		delete (missingPool.pools as Record<string, unknown>)["mechanical"];
		expect(() => parseCatalog(missingPool)).toThrow("unknown pool");

		const unknownPool = clone();
		(unknownPool.taskTypes as Record<string, Record<string, unknown>>).grunt.pool = "nope";
		expect(() => parseCatalog(unknownPool)).toThrow("unknown pool");

		const both = clone();
		(both.taskTypes as Record<string, Record<string, unknown>>).grunt.model = "@lead";
		expect(() => parseCatalog(both)).toThrow("both a pool and a model");

		const badMap = clone();
		delete ((badMap.models as Record<string, Record<string, unknown>>)["anthropic/claude-opus-5-5"] as Record<string, unknown>)
			.supports;
		expect(() => parseCatalog(badMap)).toThrow("model map");

		const mappedOutOfRange = clone();
		((mappedOutOfRange.models as Record<string, Record<string, unknown>>)["anthropic/claude-opus-5-5"] as Record<string, unknown>)
			.critical = "max";
		// Supports includes max, so this parses; a map value outside `supports` is what the parser rejects.
		expect(() => parseCatalog(mappedOutOfRange)).not.toThrow();

		const maxOnFallback = clone();
		((maxOnFallback.models as Record<string, Record<string, unknown>>)["*"] as Record<string, unknown>).maxEffort = "low";
		expect(() => parseCatalog(maxOnFallback)).toThrow("settings");

		const maxOutsideSupports = clone();
		(
			(maxOutsideSupports.models as Record<string, Record<string, unknown>>)["google-antigravity/gemini-3.8-flash"] as Record<
				string,
				unknown
			>
		).maxEffort = "xhigh";
		expect(() => parseCatalog(maxOutsideSupports)).toThrow("model map");

		const missingInstructions = clone();
		delete (missingInstructions.jevInstructions as Record<string, unknown>).route;
		expect(() => parseCatalog(missingInstructions)).toThrow("settings");

		const emptyReadinessAgents = clone();
		(emptyReadinessAgents.planningReadiness as Record<string, unknown>).agents = [];
		expect(() => parseCatalog(emptyReadinessAgents)).toThrow("settings");

		const duplicateReadinessAgents = clone();
		(duplicateReadinessAgents.planningReadiness as Record<string, unknown>).agents = ["plan", "plan"];
		expect(() => parseCatalog(duplicateReadinessAgents)).toThrow("settings");

		const missingWindowDefault = clone();
		delete ((missingWindowDefault.poolLimits as Record<string, unknown>).burstPenaltyWindow as Record<string, unknown>)["*"];
		expect(() => parseCatalog(missingWindowDefault)).toThrow("settings");

		const unknownReviewPool = clone();
		(unknownReviewPool.reviewOnly as Record<string, unknown>).pools = ["nope"];
		expect(() => parseCatalog(unknownReviewPool)).toThrow("unknown pool");

		const solPool = clone();
		(
			((solPool.pools as Record<string, Record<string, unknown>>).grunt.members as Array<Record<string, unknown>>)[0]
		).model = "openai-codex/gpt-6.1-sol";
		expect(() => parseCatalog(solPool)).toThrow("cannot take worker work");

		const solTaskModel = clone();
		(solTaskModel.taskTypes as Record<string, Record<string, unknown>>).lead.model = "@manager";
		expect(() => parseCatalog(solTaskModel)).toThrow("cannot take worker work");

		const solBackup = clone();
		(solBackup.taskTypes as Record<string, Record<string, unknown>>).vision.backups = ["@advisor"];
		expect(() => parseCatalog(solBackup)).toThrow("cannot take worker work");

		const lunaDirective = clone();
		(lunaDirective.directiveTargets as Record<string, string>)["frontier-1"] = "openai-codex/gpt-5.6-luna";
		expect(() => parseCatalog(lunaDirective)).toThrow("cannot name");

		const astraDirective = clone();
		(astraDirective.directiveTargets as Record<string, string>)["frontier-1"] = "provider/astra-1";
		expect(() => parseCatalog(astraDirective)).toThrow("cannot name");

		const solPlanReview = clone();
		(
			((solPlanReview.pools as Record<string, Record<string, unknown>>)["plan-review"].members as Array<Record<string, unknown>>)[0]
		).model = "openai-codex/gpt-6.1-sol";
		expect(() => parseCatalog(solPlanReview)).not.toThrow();

		// The fixed mechanical/grunt/plan-review pools are no longer required; only task-type pool
		// references must resolve.
		const noFixedPools = clone();
		delete (noFixedPools.pools as Record<string, unknown>)["mechanical"];
		(noFixedPools.taskTypes as Record<string, Record<string, unknown>>).mechanical.pool = "grunt";
		expect(() => parseCatalog(noFixedPools)).not.toThrow();
	});
});

describe("effort resolution", () => {
	test("maps difficulty per model with a `*` fallback", () => {
		expect(modelDifficultyEffort(catalog, "anthropic/claude-sonnet-5-5", "critical")).toBe("low");
		expect(modelDifficultyEffort(catalog, "xai-oauth/grok-4.6", "ordinary")).toBe("high");
		expect(modelDifficultyEffort(catalog, "no-such/model", "hard")).toBe("high");
		expect(modelDifficultyEffort(catalog, "no-such/model", "ordinary")).toBe("medium");
	});

	test("clamps into a task-type range, caps the model's maxEffort, then fits its supported efforts", () => {
		expect(clampEffort("xhigh", ["medium", "high"])).toBe("high");
		expect(clampEffort("low", ["medium", "high"])).toBe("medium");
		expect(clampEffort("high", undefined)).toBe("high");
		expect(capEffort(catalog, "anthropic/claude-sonnet-5-5", "xhigh")).toBe("low");
		expect(capEffort(catalog, "anthropic/claude-sonnet-5-5", "low")).toBe("low");
		expect(capEffort(catalog, "xai-oauth/grok-4.6", "xhigh")).toBe("xhigh");
		expect(capEffort(catalog, "no-such/model", "max")).toBe("max");
		expect(fitEffort("xhigh", ["low", "high"])).toBe("high");
		expect(fitEffort("medium", ["low", "high"])).toBe("low");
		expect(fitEffort("high", ["low"])).toBe("low");
		expect(fitEffort("medium", [])).toBeUndefined();
		expect(effortForModel(catalog, "anthropic/claude-opus-5-5", "critical", ["high", "xhigh"])).toBe("xhigh");
		expect(effortForModel(catalog, "surplus/deepseek-v4.1-flash", "critical", ["low", "high"])).toBe("low");
		expect(effortForModel(catalog, "xai-oauth/grok-4.6", "hard", ["low", "high"])).toBe("high");
	});

	test("caps a pinned effort at the model's catalog maxEffort", () => {
		// Sonnet's map already resolves hard work to low; a pool member pinning high is capped too.
		expect(effortForModel(catalog, "anthropic/claude-sonnet-5-5", "critical", ["high", "xhigh"])).toBe("low");
		expect(capEffort(catalog, "anthropic/claude-sonnet-5-5", "max")).toBe("low");
	});

	test("knows which task types depend on the difficulty rating", () => {
		expect(taskTypeEffortVaries(catalog, "mechanical")).toBe(false);
		expect(taskTypeEffortVaries(catalog, "grunt")).toBe(true);
		expect(taskTypeEffortVaries(catalog, "lead")).toBe(true);
		expect(taskTypeEffortVaries(catalog, "plan-review")).toBe(true);
		expect(taskTypeEffortVaries(catalog, "unknown")).toBe(false);
	});

	test("exposes the effort ladder in order", () => {
		expect(EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(DIFFICULTY_NAMES).toEqual(["exact", "ordinary", "hard", "critical"]);
		expect(ORDINARY).toBe("ordinary");
	});
});

describe("brief directives", () => {
	test("parses a Directive line with and without a pinned effort", () => {
		expect(parseDirective("Do the thing\nDirective: use frontier-2\n")).toMatchObject({ target: "frontier-2", span: "Directive: use frontier-2" });
		expect(parseDirective("## Directive: use provider/model xhigh")).toMatchObject({ target: "provider/model", effort: "xhigh" });
		expect(parseDirective("directive: use LEAD high")).toMatchObject({ target: "LEAD", effort: "high" });
		expect(parseDirective("See Directive: use lead")).toBeUndefined();
		expect(parseDirective("no directive here")).toBeUndefined();
	});

	test("recognises literal provider/model ids but not roles or paths", () => {
		expect(isLiteralModel("anthropic/claude-opus-5-5")).toBe(true);
		expect(isLiteralModel("@lead")).toBe(false);
		expect(isLiteralModel("no-slash")).toBe(false);
		expect(isLiteralModel("/leading")).toBe(false);
		expect(isLiteralModel("trailing/")).toBe(false);
		expect(isLiteralModel("has space/x")).toBe(false);
	});
});

describe("plan provenance", () => {
	const plan = [
		"---",
		"plan:",
		"  authored-by:",
		"    - model: xai-oauth/grok-4.6",
		"    - model: @frontier-2",
		"  reviews:",
		"    - model: anthropic/claude-opus-5-5",
		"title: Example",
		"---",
		"# Body",
	].join("\n");

	test("reads authored-by and reviews from plan front matter", () => {
		expect(planProvenance(plan, catalog.planMetadata)).toEqual({
			authors: ["xai-oauth/grok-4.6", "@frontier-2"],
			reviews: ["anthropic/claude-opus-5-5"],
		});
	});

	test("returns undefined when there is no readable plan front matter", () => {
		expect(planProvenance("# No front matter", catalog.planMetadata)).toBeUndefined();
		expect(planProvenance("---\ntitle: x\n---\n", catalog.planMetadata)).toBeUndefined();
	});
});

describe("plan-review author exclusion", () => {
	const members = [member("openai-codex", "gpt-6.1-sol"), member("anthropic", "claude-opus-5-5"), member("xai-oauth", "grok-4.6")];

	test("drops authors and prefers models that have not reviewed", () => {
		const order = preferPlanReviewMembers(members, {
			authors: ["xai-oauth/grok-4.6"],
			reviews: ["anthropic/claude-opus-5-5"],
		});
		expect(order.excluded).toEqual(["xai-oauth/grok-4.6"]);
		expect(order.members.map(m => `${m.model.provider}/${m.model.id}`)).toEqual([
			"openai-codex/gpt-6.1-sol",
			"anthropic/claude-opus-5-5",
		]);
		expect(order.unknown).toBe(false);
	});

	test("reuses the first non-author when every non-author has reviewed", () => {
		const order = preferPlanReviewMembers(members, {
			authors: ["xai-oauth/grok-4.6"],
			reviews: ["openai-codex/gpt-6.1-sol", "anthropic/claude-opus-5-5"],
		});
		expect(order.members.map(m => `${m.model.provider}/${m.model.id}`)).toEqual([
			"openai-codex/gpt-6.1-sol",
			"anthropic/claude-opus-5-5",
		]);
	});

	test("falls back to the full pool when every member authored the plan", () => {
		const order = preferPlanReviewMembers(members, {
			authors: members.map(m => `${m.model.provider}/${m.model.id}`),
			reviews: [],
		});
		expect(order.members.length).toBe(3);
		expect(order.excluded.length).toBe(3);
	});

	test("reports an unknown author when there is no provenance", () => {
		const order = preferPlanReviewMembers(members, undefined);
		expect(order.unknown).toBe(true);
		expect(order.members).toEqual(members);
		expect(order.excluded).toEqual([]);
	});
});

describe("pool ranking", () => {
	const members = [
		member("xai-oauth", "grok-4.6", { penaltyKind: "weekly", minWeeklyHeadroom: 0.05, minMonthlyHeadroom: 0 }),
		member("anthropic", "claude-sonnet-5-5", { maxShortUsed: 0.7, minWeeklyHeadroom: 0.1 }),
	];

	test("orders eligible members and skips a member over the skip threshold", () => {
		const ranked = rankPool(members, { reports: [report("xai-oauth", 0.1), report("anthropic", 0.1)], credentialCounts: {} }, new Map(), [], catalog.poolLimits, Date.now());
		expect(ranked.order).toEqual(["xai-oauth/grok-4.6", "anthropic/claude-sonnet-5-5"]);

		const crowded = rankPool(members, { reports: [report("xai-oauth", 0.99), report("anthropic", 0.1)], credentialCounts: {} }, new Map(), [], catalog.poolLimits, Date.now());
		expect(crowded.skipped).toContain("xai-oauth/grok-4.6");
		expect(crowded.order).not.toContain("xai-oauth/grok-4.6");
		expect(crowded.order).toContain("anthropic/claude-sonnet-5-5");
	});

	test("treats a stale report as no usage", () => {
		const stale = report("xai-oauth", 0.1, Date.now() - catalog.poolLimits.maxReportAgeMs - 60_000);
		const ranked = rankPool(members, { reports: [stale], credentialCounts: {} }, new Map(), [], catalog.poolLimits, Date.now());
		expect(ranked.verdicts["xai-oauth/grok-4.6"]?.status).toBe("stale");
	});

	test("maps provider limits into the three pacing windows", () => {
		const samples = windowSamples(report("xai-oauth", 0.2) as never);
		expect(samples.map(sample => sample.kind).sort()).toEqual(["monthly", "weekly"]);
		expect(samples.every(sample => sample.usedFraction === 0.2)).toBe(true);
	});

	test("picks the burst-penalty window from the catalog", () => {
		const provider = "acme";
		const target = member(provider, "model", { maxShortUsed: 0.9, minWeeklyHeadroom: 0, penaltyKind: undefined });
		const penalties = new Map([[`${provider}/model`, 0.02]]);
		const usage = { reports: [report(provider, 0.79)] as never, credentialCounts: {} };
		const base = structuredClone(catalog.poolLimits);

		// No entry for the provider, so the `*` default (short) receives the penalty.
		const fallbackUsed = rankPool([target], usage, penalties, [], base, Date.now()).verdicts[`${provider}/model`]?.used;
		expect(fallbackUsed?.short).toBeCloseTo(0.81, 5);
		expect(fallbackUsed?.weekly).toBeCloseTo(0.79, 5);

		const weekly = { ...base, burstPenaltyWindow: { ...base.burstPenaltyWindow, [provider]: "weekly" as const } };
		const mappedUsed = rankPool([target], usage, penalties, [], weekly, Date.now()).verdicts[`${provider}/model`]?.used;
		expect(mappedUsed?.short).toBeCloseTo(0.79, 5);
		expect(mappedUsed?.weekly).toBeCloseTo(0.81, 5);
	});
});

describe("Jev classification", () => {
	const slots: Slot[] = [
		{ id: "grunt", description: "settled work" },
		{ id: "lead", description: "open decisions" },
	];

	test("chooses a task type and a difficulty", async () => {
		const decision = await choose(
			"state",
			slots,
			true,
			false,
			catalog,
			evaluateFrom({ route: choice("lead", ["grunt", "lead"]), difficulty: score(2) }),
		);
		expect(decision).toMatchObject({ source: "jev", choice: "lead", difficulty: "hard", reason: "classified" });
	});

	test("falls back to the baseline when a choice is uncertain", async () => {
		const decision = await choose(
			"state",
			slots,
			true,
			false,
			catalog,
			evaluateFrom({ route: choice("lead", ["grunt", "lead"], 0.2), difficulty: score(2) }),
		);
		expect(decision).toMatchObject({ source: "baseline", reason: "uncertain-choice", leading: "lead" });
	});

	test("keeps a confident choice when only the difficulty is uncertain", async () => {
		const decision = await choose(
			"state",
			slots,
			true,
			false,
			catalog,
			evaluateFrom({ route: choice("lead", ["grunt", "lead"]), difficulty: score(2, 0.4) }),
		);
		expect(decision).toMatchObject({ source: "jev", choice: "lead", reason: "uncertain-difficulty" });
		expect(decision.difficulty).toBeUndefined();
	});

	test("falls back to the baseline when only an uncertain difficulty was asked", async () => {
		const decision = await choose("state", [], true, false, catalog, evaluateFrom({ difficulty: score(2, 0.4) }));
		expect(decision).toMatchObject({ source: "baseline", reason: "uncertain-difficulty" });
	});

	test("sends the catalog's Jev instructions for both questions", async () => {
		const requests: Array<Parameters<Evaluate>[0]> = [];
		await choose("state", slots, true, false, catalog, async request => {
			requests.push(request);
			return { answers: { route: choice("lead", ["grunt", "lead"]), difficulty: score(2) } };
		});
		expect(requests[0].questions.route?.instructions).toBe(catalog.jevInstructions.route);
		expect(requests[0].questions.difficulty?.instructions).toBe(catalog.jevInstructions.difficulty);
	});

	test("returns a baseline when there is nothing to classify", async () => {
		expect(await choose("state", [], false, false, catalog, evaluateFrom({}))).toMatchObject({
			source: "baseline",
			reason: "nothing-to-classify",
		});
	});

	test("rethrows caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(choose("state", slots, true, false, catalog, evaluateFrom({}), controller.signal)).rejects.toThrow();
	});

	test("suggests a confident persona in the same call, even on a baseline decision", async () => {
		const requests: Array<Parameters<Evaluate>[0]> = [];
		const decision = await choose("state", slots, true, true, catalog, async request => {
			requests.push(request);
			return {
				answers: {
					route: choice("lead", ["grunt", "lead"], 0.2),
					difficulty: score(0),
					persona: choice("brute", ["normal", "brute"]),
				},
			};
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].questions.persona?.instructions).toBe(catalog.personas.instructions);
		expect(Object.keys(requests[0].questions.persona?.criteria ?? {})).toEqual(["normal", "brute"]);
		expect(decision).toMatchObject({ source: "baseline", reason: "uncertain-choice", persona: "brute" });
	});

	test("drops an uncertain or malformed persona without failing the route", async () => {
		const uncertain = await choose(
			"state",
			slots,
			true,
			true,
			catalog,
			evaluateFrom({
				route: choice("grunt", ["grunt", "lead"]),
				difficulty: score(1),
				persona: choice("brute", ["normal", "brute"], 0.3),
			}),
		);
		expect(uncertain).toMatchObject({ source: "jev", choice: "grunt" });
		expect(uncertain.persona).toBeUndefined();
		const orchestrate = await choose(
			"state",
			slots,
			true,
			true,
			catalog,
			evaluateFrom({
				route: choice("grunt", ["grunt", "lead"]),
				difficulty: score(1),
				persona: choice("orchestrate", ["normal", "orchestrate"]),
			}),
		);
		expect(orchestrate).toMatchObject({ source: "jev", choice: "grunt" });
		expect(orchestrate.persona).toBeUndefined();
	});

	test("rejects persona agents outside the covered list", () => {
		const bad = structuredClone(catalogData) as Record<string, any>;
		bad.personas.agents = ["orchestrator"];
		expect(() => parseCatalog(bad)).toThrow('personas names agent "orchestrator"');
	});

	test("sends the catalog's planning readiness instructions and routes", async () => {
		const requests: Array<Parameters<Evaluate>[0]> = [];
		await evaluatePlanningReadiness("task", catalog, async request => {
			requests.push(request);
			return { answers: { route: choice("autonomous-plan", ["autonomous-plan", "discuss-with-user"]) } };
		});
		expect(requests[0].questions.route?.instructions).toBe(catalog.planningReadiness.instructions);
		expect(Object.keys(requests[0].questions.route?.criteria ?? {})).toEqual(["autonomous-plan", "discuss-with-user"]);
	});

	test("rates planning readiness and defaults to discuss-with-user when unclear", async () => {
		const ready = await evaluatePlanningReadiness(
			"task",
			catalog,
			evaluateFrom({ route: choice("autonomous-plan", ["autonomous-plan", "discuss-with-user"]) }),
		);
		expect(ready.route).toBe("autonomous-plan");
		const unclear = await evaluatePlanningReadiness(
			"task",
			catalog,
			evaluateFrom({ route: choice("discuss-with-user", ["autonomous-plan", "discuss-with-user"], 0.2) }),
		);
		expect(unclear).toMatchObject({ route: "discuss-with-user", reason: "readiness-low-confidence" });
	});
});
