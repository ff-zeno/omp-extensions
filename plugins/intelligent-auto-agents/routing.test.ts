import { describe, expect, mock, test } from "bun:test";
import catalogData from "./catalog.json";
import type { Evaluate, PoolMember, Slot } from "./routing";

mock.module("@oh-my-pi/pi-ai", () => ({
	resolveUsedFraction: (limit: { amount: { usedFraction?: number; unit: string } }) => limit.amount.usedFraction,
	NativeJudge: class {
		judge = async () => ({ answers: {} });
	},
}));

// The production module imports pi-ai helpers, so the mock must be registered before loading it.
const {
	EFFORTS,
	DIFFICULTY_NAMES,
	ORDINARY,
	parseCatalog,
	parseWorkerAccountPins,
	parseAccountLabels,
	matchOAuthAccount,
	planWorkerAccountPins,
	createCatalogReloader,
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
	rotateCandidates,
	activeExperimentSlot,
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

describe("catalog v9", () => {
	test("parses the shipped catalog and its routing surface", () => {
		expect(catalog.version).toBe(9);
		expect(Object.keys(catalog.taskTypes).sort()).toEqual([
			"code",
			"commit",
			"frontier-review",
			"lead",
			"mechanical",
			"plan",
			"plan-review",
			"review",
			"security-review",
			"vision",
		]);
		expect(catalog.agents.taskTypes).toEqual({ git: "commit" });
		expect(catalog.agents.covered).toEqual(["task", "sonic", "scout", "reviewer", "security-reviewer", "git", "plan"]);
		expect(catalog.agents.pinned).toContain("review-frontier-1");
		expect(catalog.agents.pinned).toContain("review-frontier-3");
		expect(catalog.directiveTargets).toMatchObject({ "frontier-1": "@frontier-1", vision: "@vision" });
		expect(catalog.nuances.length).toBeGreaterThan(0);
		expect(catalog.planningReadiness.agents).toEqual(["plan"]);
		expect(catalog.blockedDirectiveTargets).toEqual(["luna", "astra"]);
		expect(catalog.jevInstructions.route.length).toBeGreaterThan(0);
	});

	test("parses worker account pins from a local file, not the catalog", () => {
		expect(parseWorkerAccountPins("")).toBeUndefined();
		expect(parseWorkerAccountPins("account: extra@example.com")).toEqual({ all: "extra@example.com", byProvider: {} });
		expect(parseWorkerAccountPins("anthropic: extra@example.com")).toEqual({ byProvider: { anthropic: "extra@example.com" } });
		expect(parseWorkerAccountPins("# comment\nextra@example.com\n")).toEqual({ all: "extra@example.com", byProvider: {} });
		expect(parseWorkerAccountPins('{"anthropic":"extra@example.com"}')).toEqual({ byProvider: { anthropic: "extra@example.com" } });
		const accounts = [
			{ provider: "anthropic", credentialId: 1, email: "primary@example.com" },
			{ provider: "anthropic", credentialId: 2, email: "extra@example.com" },
		];
		const noLabels = parseAccountLabels("");
		expect(matchOAuthAccount(accounts, "extra@example.com", noLabels)?.credentialId).toBe(2);
		expect(
			planWorkerAccountPins({ byProvider: { anthropic: "extra@example.com" } }, provider => (provider === "anthropic" ? accounts : []), noLabels),
		).toEqual([{ provider: "anthropic", credentialId: 2 }]);
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
		(unknownPool.taskTypes as Record<string, Record<string, unknown>>).code.pool = "nope";
		expect(() => parseCatalog(unknownPool)).toThrow("unknown pool");

		const both = clone();
		(both.taskTypes as Record<string, Record<string, unknown>>).code.model = "@lead";
		expect(() => parseCatalog(both)).toThrow("both a pool and a model");

		const uncoveredAgentTaskType = clone();
		((uncoveredAgentTaskType.agents as Record<string, unknown>).taskTypes as Record<string, string>).orchestrator = "code";
		expect(() => parseCatalog(uncoveredAgentTaskType)).toThrow('names agent "orchestrator" that is not covered');

		const unknownAgentTaskType = clone();
		((unknownAgentTaskType.agents as Record<string, unknown>).taskTypes as Record<string, string>).git = "nope";
		expect(() => parseCatalog(unknownAgentTaskType)).toThrow('unknown task type "nope"');

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
		((maxOutsideSupports.models as Record<string, Record<string, unknown>>)["xai-oauth/grok-4.6"] as Record<string, unknown>)
			.maxEffort = "max";
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

		const duplicateIgnoreQuota = clone();
		((duplicateIgnoreQuota.poolLimits as Record<string, unknown>).ignoreQuota = ["openai-codex", "openai-codex"]);
		expect(() => parseCatalog(duplicateIgnoreQuota)).toThrow("settings");

		const ignoreQuotaNotArray = clone();
		(ignoreQuotaNotArray.poolLimits as Record<string, unknown>).ignoreQuota = "openai-codex";
		expect(() => parseCatalog(ignoreQuotaNotArray)).toThrow("settings");

		const unknownReviewPool = clone();
		(unknownReviewPool.reviewOnly as Record<string, unknown>).pools = ["nope"];
		expect(() => parseCatalog(unknownReviewPool)).toThrow("unknown pool");

		// Protected role aliases may serve lead/plan review, but not ordinary worker pools.
		for (const pool of ["lead", "code", "mechanical"]) {
			const solAliasPool = clone();
			(
				((solAliasPool.pools as Record<string, Record<string, unknown>>)[pool].members as Array<Record<string, unknown>>)[0]
			).model = "@frontier-2";
			if (pool === "lead") expect(() => parseCatalog(solAliasPool)).not.toThrow();
			else expect(() => parseCatalog(solAliasPool)).toThrow("cannot take worker work");
		}

		const solTaskModel = clone();
		(solTaskModel.taskTypes as Record<string, Record<string, unknown>>).vision.model = "@manager";
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
		).model = "openai-codex/gpt-6.2-sol";
		expect(() => parseCatalog(solPlanReview)).not.toThrow();

		// The fixed pools are not required; only task-type pool references must resolve.
		const noFixedPools = clone();
		delete (noFixedPools.pools as Record<string, unknown>)["mechanical"];
		(noFixedPools.taskTypes as Record<string, Record<string, unknown>>).mechanical.pool = "code";
		delete noFixedPools.experiment;
		expect(() => parseCatalog(noFixedPools)).not.toThrow();
	});

	test("rejects invalid or conflicting pool effort policies", () => {
		for (const policy of [
			{ effortStep: -1 }, { effortStep: 0.5 }, { effortStep: 5 }, { effortStep: "1" },
			{ effortFrom: "" }, { effort: "high", effortFrom: "@frontier-1" },
			{ effort: "high", effortStep: 1 },
		]) {
			const invalid = structuredClone(catalogData);
			Object.assign(invalid.pools.lead.members[1], policy);
			expect(() => parseCatalog(invalid)).toThrow("Invalid auto-agents pool");
		}
	});
});

describe("split-test experiment", () => {
	const clone = (): Record<string, unknown> => structuredClone(catalogData) as Record<string, unknown>;
	const candidates = [
		{ model: "openai-codex/gpt-6.1-terra", effort: "high" },
		{ model: "anthropic/claude-sonnet-5-5", effort: "medium" },
	];
	const experimentBlock = (overrides: Record<string, unknown> = {}) => ({
		name: "worker-split-2026-11",
		enabled: true,
		endsAt: "2026-12-15T00:00:00Z",
		slots: [{ pools: ["code"], difficulties: ["hard"], candidates }],
		...overrides,
	});
	const withExperiment = (overrides: Record<string, unknown> = {}) => {
		const next = clone();
		next.experiment = experimentBlock(overrides);
		return next;
	};

	test("parses a valid experiment block", () => {
		const parsed = parseCatalog(withExperiment());
		expect(parsed.experiment?.name).toBe("worker-split-2026-11");
		expect(parsed.experiment?.enabled).toBe(true);
		expect(parsed.experiment?.slots).toHaveLength(1);
	});

	test("rejects each invalid experiment block", () => {
		expect(() => parseCatalog(withExperiment({ name: "worker split" }))).toThrow("experiment");
		expect(() => parseCatalog(withExperiment({ name: "a/b" }))).toThrow("experiment");
		expect(() => parseCatalog(withExperiment({ enabled: "yes" }))).toThrow("experiment");
		expect(() => parseCatalog(withExperiment({ endsAt: "not-a-date" }))).toThrow("experiment");
		expect(() => parseCatalog(withExperiment({ slots: [{ pools: ["missing"], difficulties: ["hard"], candidates }] }))).toThrow(
			"unknown pool",
		);
		expect(() =>
			parseCatalog(withExperiment({ slots: [{ pools: ["plan-review"], difficulties: ["hard"], candidates }] })),
		).toThrow("excluded pool");
		expect(() =>
			parseCatalog(
				withExperiment({
					slots: [
						{ pools: ["code"], difficulties: ["hard"], candidates },
						{ pools: ["code"], difficulties: ["hard"], candidates },
					],
				}),
			),
		).toThrow("repeats slot");
		expect(() =>
			parseCatalog(withExperiment({ slots: [{ pools: ["code"], difficulties: ["hard"], candidates: [candidates[0]] }] })),
		).toThrow("experiment");
		expect(() =>
			parseCatalog(
				withExperiment({
					slots: [{ pools: ["code"], difficulties: ["hard"], candidates: [candidates[0], candidates[0]] }],
				}),
			),
		).toThrow("experiment");
		expect(() =>
			parseCatalog(
				withExperiment({
					slots: [
						{
							pools: ["code"],
							difficulties: ["hard"],
							candidates: [{ model: "openai-codex/gpt-6.1-terra" }, candidates[1]],
						},
					],
				}),
			),
		).toThrow("experiment");
		expect(() =>
			parseCatalog(
				withExperiment({
					slots: [
						{
							pools: ["code"],
							difficulties: ["hard"],
							candidates: [
								{ model: "@frontier-2", effort: "low" },
								{ model: "openai-codex/gpt-6.1-terra", effort: "high" },
							],
						},
					],
				}),
			),
		).toThrow("cannot take worker work");
	});

	test("activeExperimentSlot follows enabled, endsAt, and listed slots", () => {
		const parsed = parseCatalog(withExperiment());
		const beforeEnd = Date.parse("2026-12-14T00:00:00Z");
		const afterEnd = Date.parse("2026-12-15T00:00:00Z");
		expect(activeExperimentSlot(parsed, "code", "hard", beforeEnd)?.candidates).toEqual(candidates);
		expect(activeExperimentSlot(parsed, "code", "ordinary", beforeEnd)).toBeUndefined();
		expect(activeExperimentSlot(parsed, "lead", "hard", beforeEnd)).toBeUndefined();
		expect(activeExperimentSlot(parsed, "code", "hard", afterEnd)).toBeUndefined();
		const disabled = parseCatalog(withExperiment({ enabled: false }));
		expect(activeExperimentSlot(disabled, "code", "hard", beforeEnd)).toBeUndefined();
		const none = clone();
		delete none.experiment;
		expect(activeExperimentSlot(parseCatalog(none), "code", "hard", beforeEnd)).toBeUndefined();
	});

	test("rotateCandidates starts at counter mod n", () => {
		const items = ["a", "b", "c", "d"];
		expect(rotateCandidates(items, 0)).toEqual(["a", "b", "c", "d"]);
		expect(rotateCandidates(items, 1)).toEqual(["b", "c", "d", "a"]);
		expect(rotateCandidates(items, 4)).toEqual(["a", "b", "c", "d"]);
		expect(rotateCandidates(items, -1)).toEqual(["d", "a", "b", "c"]);
		expect(rotateCandidates([], 3)).toEqual([]);
	});

	test("the shipped catalog experiment lists a candidate set for every declared slot", () => {
		const parsed = parseCatalog(catalogData);
		expect(parsed.experiment).toBeDefined();
		const beforeEnd = Date.parse(parsed.experiment!.endsAt) - 1;
		for (const slot of parsed.experiment!.slots) {
			for (const pool of slot.pools) {
				for (const difficulty of slot.difficulties) {
					expect(activeExperimentSlot(parsed, pool, difficulty, beforeEnd)?.candidates).toEqual(slot.candidates);
				}
			}
		}
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
		expect(effortForModel(catalog, "xai-oauth/grok-4.6", "hard", ["low", "high"])).toBe("high");
	});

	test("caps a pinned effort at the model's catalog maxEffort", () => {
		// Sonnet's map already resolves hard work to low; a pool member pinning high is capped too.
		expect(effortForModel(catalog, "anthropic/claude-sonnet-5-5", "critical", ["high", "xhigh"])).toBe("low");
		expect(capEffort(catalog, "anthropic/claude-sonnet-5-5", "max")).toBe("low");
	});

	test("knows which task types depend on the difficulty rating", () => {
		expect(taskTypeEffortVaries(catalog, "mechanical")).toBe(true);
		expect(taskTypeEffortVaries(catalog, "code")).toBe(true);
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
	const members = [member("openai-codex", "gpt-6.2-sol"), member("anthropic", "claude-opus-5-5"), member("xai-oauth", "grok-4.6")];

	test("drops authors and prefers models that have not reviewed", () => {
		const order = preferPlanReviewMembers(members, {
			authors: ["xai-oauth/grok-4.6"],
			reviews: ["anthropic/claude-opus-5-5"],
		});
		expect(order.excluded).toEqual(["xai-oauth/grok-4.6"]);
		expect(order.members.map(m => `${m.model.provider}/${m.model.id}`)).toEqual([
			"openai-codex/gpt-6.2-sol",
			"anthropic/claude-opus-5-5",
		]);
		expect(order.unknown).toBe(false);
	});

	test("reuses the first non-author when every non-author has reviewed", () => {
		const order = preferPlanReviewMembers(members, {
			authors: ["xai-oauth/grok-4.6"],
			reviews: ["openai-codex/gpt-6.2-sol", "anthropic/claude-opus-5-5"],
		});
		expect(order.members.map(m => `${m.model.provider}/${m.model.id}`)).toEqual([
			"openai-codex/gpt-6.2-sol",
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
	const pacedLimits = { ...catalog.poolLimits, ignoreQuota: undefined };
	const members = [
		member("xai-oauth", "grok-4.6", { penaltyKind: "weekly", minWeeklyHeadroom: 0 }),
		member("anthropic", "claude-sonnet-5-5", { maxShortUsed: 0.7, minWeeklyHeadroom: 0.1 }),
	];

	test("orders eligible members and skips a member over the skip threshold", () => {
		const ranked = rankPool(members, { reports: [report("xai-oauth", 0.1), report("anthropic", 0.1)], credentialCounts: {} }, new Map(), [], pacedLimits, Date.now());
		expect(ranked.order).toEqual(["xai-oauth/grok-4.6", "anthropic/claude-sonnet-5-5"]);

		const crowded = rankPool(members, { reports: [report("xai-oauth", 0.99), report("anthropic", 0.1)], credentialCounts: {} }, new Map(), [], pacedLimits, Date.now());
		expect(crowded.skipped).toContain("xai-oauth/grok-4.6");
		expect(crowded.order).not.toContain("xai-oauth/grok-4.6");
		expect(crowded.order).toContain("anthropic/claude-sonnet-5-5");
	});

	test("treats a stale report as no usage", () => {
		const stale = report("xai-oauth", 0.1, Date.now() - pacedLimits.maxReportAgeMs - 60_000);
		const ranked = rankPool(members, { reports: [stale], credentialCounts: {} }, new Map(), [], pacedLimits, Date.now());
		expect(ranked.verdicts["xai-oauth/grok-4.6"]?.status).toBe("stale");
	});

	const hour = 60 * 60 * 1000;
	const week = 7 * 24 * hour;
	const weeklyReport = (provider: string, used: number, untilResetMs: number) => {
		const now = Date.now();
		// xAI usage is read only from its aggregate credit pool.
		const id = provider === "xai-oauth" ? "xai-oauth:credits:weekly" : `${provider}:weekly`;
		return {
			provider,
			fetchedAt: now,
			limits: [
				{
					id,
					label: id,
					scope: { provider, shared: true },
					window: { id, label: id, durationMs: week, resetsAt: now + untilResetMs },
					amount: { unit: "percent", usedFraction: used },
				},
			],
		};
	};
	const luna = member("openai-codex", "gpt-5.6-luna", { penaltyKind: "weekly", minWeeklyHeadroom: 0 });
	const lunaStatus = (used: number, untilResetMs: number) =>
		rankPool([luna], { reports: [weeklyReport("openai-codex", used, untilResetMs)], credentialCounts: {} }, new Map(), [], pacedLimits, Date.now())
			.verdicts["openai-codex/gpt-5.6-luna"]?.status;

	test("a weekly pace gate of 0 admits usage behind pace and rejects usage ahead of it", () => {
		// report() puts the weekly window at 20% elapsed.
		const status = (used: number) =>
			rankPool([members[0]!], { reports: [report("xai-oauth", used)], credentialCounts: {} }, new Map(), [], pacedLimits, Date.now())
				.verdicts["xai-oauth/grok-4.6"]?.status;
		expect(status(0.15)).toBe("eligible");
		expect(status(0.25)).toBe("below-pace");
	});

	test("ranks a gated member with no usage report after crowded members instead of excluding it", () => {
		const ranked = rankPool(
			[luna, members[0]!],
			{ reports: [weeklyReport("xai-oauth", 0.82, 24 * hour)], credentialCounts: {} },
			new Map(),
			[],
			pacedLimits,
			Date.now(),
		);
		expect(ranked.verdicts["xai-oauth/grok-4.6"]?.status).toBe("crowded");
		expect(ranked.verdicts["openai-codex/gpt-5.6-luna"]?.status).toBe("no-usage");
		expect(ranked.order).toEqual(["xai-oauth/grok-4.6", "openai-codex/gpt-5.6-luna"]);
	});

	test("keeps a freshly reset, unused window on pace while dispatches are in flight", () => {
		// 30 minutes into the week, two in-flight dispatches add a 0.02 burst penalty to an unused window.
		const ranked = rankPool(
			[luna],
			{ reports: [weeklyReport("openai-codex", 0, week - hour / 2)], credentialCounts: {} },
			new Map([["openai-codex/gpt-5.6-luna", 0.02]]),
			[],
			pacedLimits,
			Date.now(),
		);
		expect(ranked.verdicts["openai-codex/gpt-5.6-luna"]?.status).toBe("eligible");
		expect(ranked.order).toEqual(["openai-codex/gpt-5.6-luna"]);
	});

	test("counts the first 6 hours after a reset as on pace while usage is under 3%", () => {
		// One hour into the week, 2% used is ahead of linear pace (about 0.6% elapsed) but still a fresh start.
		expect(lunaStatus(0.02, week - hour)).toBe("eligible");
		// At 3% used the exemption ends and the pace check applies again. After 6 hours, under 3% used is
		// already behind linear pace (6 hours is about 3.6% of a week), so the hand-off has no gap.
		expect(lunaStatus(0.03, week - hour)).toBe("below-pace");
		expect(lunaStatus(0.02, week - 7 * hour)).toBe("eligible");
	});

	test("a fresh start counts as on pace but does not waive a member's extra weekly headroom", () => {
		const sonnet = member("anthropic", "claude-sonnet-5-5", { minWeeklyHeadroom: 0.1 });
		const sonnetStatus = (used: number, untilResetMs: number) =>
			rankPool([sonnet], { reports: [weeklyReport("anthropic", used, untilResetMs)], credentialCounts: {} }, new Map(), [], pacedLimits, Date.now())
				.verdicts["anthropic/claude-sonnet-5-5"]?.status;
		// Anthropic keeps its 10% reserve for the main chat, so subagents stay off it early in the week.
		expect(sonnetStatus(0, week - hour / 2)).toBe("below-pace");
		expect(sonnetStatus(0.02, week - 5 * hour)).toBe("below-pace");
	});

	test("lifts weekly crowding 12 hours before a weekly reset", () => {
		expect(lunaStatus(0.85, 13 * hour)).toBe("crowded");
		expect(lunaStatus(0.85, 11 * hour)).toBe("eligible");
	});

	test("lifts the weekly skip threshold 5 hours before a weekly reset, but not exhaustion", () => {
		expect(lunaStatus(0.96, 6 * hour)).toBe("skipped");
		expect(lunaStatus(0.96, 4 * hour)).toBe("eligible");
		expect(lunaStatus(1, 4 * hour)).toBe("skipped");
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
		const base = { ...structuredClone(catalog.poolLimits), burstPenaltyWindow: { "*": "short" as const } };

		// No entry for the provider, so the `*` default (short here) receives the penalty.
		const fallbackUsed = rankPool([target], usage, penalties, [], base, Date.now()).verdicts[`${provider}/model`]?.used;
		expect(fallbackUsed?.short).toBeCloseTo(0.81, 5);
		expect(fallbackUsed?.weekly).toBeCloseTo(0.79, 5);

		const weekly = { ...base, burstPenaltyWindow: { ...base.burstPenaltyWindow, [provider]: "weekly" as const } };
		const mappedUsed = rankPool([target], usage, penalties, [], weekly, Date.now()).verdicts[`${provider}/model`]?.used;
		expect(mappedUsed?.short).toBeCloseTo(0.79, 5);
		expect(mappedUsed?.weekly).toBeCloseTo(0.81, 5);
	});

	test("[DLG-008] quota gates Codex members past skipAt and exhaustion", () => {
		const openai = member("openai-codex", "gpt-5.6-luna", { penaltyKind: "weekly", minWeeklyHeadroom: 0 });
		const ranked = rankPool(
			[members[0]!, openai],
			{ reports: [report("xai-oauth", 0.99), weeklyReport("openai-codex", 1, 24 * hour)], credentialCounts: {} },
			new Map(),
			[],
			pacedLimits,
			Date.now(),
		);
		expect(ranked.skipped).toContain("xai-oauth/grok-4.6");
		expect(ranked.verdicts["openai-codex/gpt-5.6-luna"]?.status).toBe("skipped");
		expect(ranked.order).not.toContain("openai-codex/gpt-5.6-luna");
	});

	test("eligible Codex still honors failure demotion", () => {
		const openai = member("openai-codex", "gpt-5.6-luna", { penaltyKind: "weekly", minWeeklyHeadroom: 0 });
		const ranked = rankPool(
			[openai],
			{ reports: [weeklyReport("openai-codex", 0.1, 24 * hour)], credentialCounts: {} },
			new Map(),
			["openai-codex/gpt-5.6-luna"],
			pacedLimits,
			Date.now(),
		);
		expect(ranked.verdicts["openai-codex/gpt-5.6-luna"]?.status).toBe("demoted");
		expect(ranked.order).not.toContain("openai-codex/gpt-5.6-luna");
	});

	test("skipWithoutGates skips a spent window on members with no headroom thresholds", () => {
		const ungated = member("openai-codex", "gpt-6.1-terra");
		const usage = { reports: [report("openai-codex", 0.99)], credentialCounts: {} };
		const open = rankPool([ungated], usage, new Map(), [], pacedLimits, Date.now());
		expect(open.verdicts[ungated.id]?.status).toBe("eligible");
		const skipped = rankPool([ungated], usage, new Map(), [], pacedLimits, Date.now(), { skipWithoutGates: true });
		expect(skipped.skipped).toContain(ungated.id);
	});
});

describe("catalog reloader", () => {
	test("re-parses when mtime changes and keeps the last valid catalog on error", () => {
		let mtime = 1;
		let text = JSON.stringify(catalogData);
		const reloader = createCatalogReloader(
			{
				mtimeMs: () => mtime,
				text: () => text,
			},
			parseCatalog(catalogData),
		);
		expect(reloader.get().poolLimits.ignoreQuota).toEqual(["openai-codex"]);

		const next = structuredClone(catalogData) as { poolLimits: { ignoreQuota?: string[] } };
		next.poolLimits.ignoreQuota = ["anthropic"];
		mtime = 2;
		text = JSON.stringify(next);
		expect(reloader.get().poolLimits.ignoreQuota).toEqual(["anthropic"]);

		mtime = 3;
		text = "{";
		expect(reloader.get().poolLimits.ignoreQuota).toEqual(["anthropic"]);

		mtime = 4;
		text = JSON.stringify({ ...next, poolLimits: { ...next.poolLimits, ignoreQuota: ["xai-oauth"] } });
		expect(reloader.get().poolLimits.ignoreQuota).toEqual(["xai-oauth"]);

		text = JSON.stringify({ ...next, poolLimits: { ...next.poolLimits, ignoreQuota: ["anthropic"] } });
		expect(reloader.get().poolLimits.ignoreQuota).toEqual(["xai-oauth"]);
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
