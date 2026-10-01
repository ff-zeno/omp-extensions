import { describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import catalogData from "./catalog.json";
import type { Evaluate, PoolMember } from "./routing";
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
		judge = async (request: unknown) => {
			const bridge = globalThis as unknown as { __intelligentAutoAgentsJudge?: (value: unknown) => Promise<unknown> };
			return bridge.__intelligentAutoAgentsJudge?.(request) ?? { answers: {} };
		};
	},
}));
// The production module imports pi-ai helpers; register a deterministic test seam before loading it.
const { choose, evaluatePlanningReadiness, fitEffort, parseCatalog, rankPool, windowSamples } = await import("./routing");

const catalog = parseCatalog(catalogData);
const poolLimits = {
	demoteAt: 0.8,
	skipAt: 0.95,
	burstPenalty: 0.01,
	usageTimeoutMs: 1500,
	maxReportAgeMs: 900000,
	clockSkewMs: 60000,
	failureDemoteAfter: 2,
	demoteForMs: 1800000,
};
const nowMs = 1_000_000;
const poolMember = (id: string, provider: string, thresholds: Partial<PoolMember> = {}): PoolMember => ({
	id,
	model: { provider, id },
	...thresholds,
});
const usageReport = (
	provider: string,
	limits: Array<{ id: string; durationMs?: number; used: number; elapsed?: number; status?: string }>,
	fetchedAt = nowMs,
) => ({
	provider,
	fetchedAt,
	limits: limits.map(limit => ({
		id: limit.id,
		label: limit.id,
		scope: { provider },
		window: {
			id: limit.id,
			label: limit.id,
			...(limit.durationMs === undefined ? {} : { durationMs: limit.durationMs }),
			...(limit.elapsed === undefined || limit.durationMs === undefined
				? {}
				: { resetsAt: nowMs + limit.durationMs * (1 - limit.elapsed) }),
		},
		amount: { unit: "percent", usedFraction: limit.used },
		...(limit.status === undefined ? {} : { status: limit.status }),
	})),
});
const candidates = [
	{ id: "small", description: "Exact mechanical task" },
	{ id: "strong", description: "Ambiguous architecture" },
];
const strong: Evaluate = async () => ({
	answers: {
		route: { type: "choice", choice: "strong", confidence: 0.9, probabilities: { small: 0.05, strong: 0.95 } },
	},
	usage: { input: 12, output: 3, totalTokens: 15, cost: { total: 0.0004 } },
});
const difficultyAnswer = (score: number, confidence = 0.9) => ({
	type: "score",
	score,
	confidence,
	probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, [String(Math.round(score))]: 1 },
});
/** Agents OMP ships as built-ins rather than as files under omp/agents. */
const BUILTIN_AGENTS = ["task", "scout", "reviewer"];
/** This catalog also supports the operator's machine-local preset. */
const MACHINE_LOCAL_AGENTS = ["sonic"];

describe("catalog contract", () => {
	test("Jev-facing text never names a model, provider, or family", () => {
		const jevText = [
			...catalog.difficulty,
			...Object.values(catalog.planningReadiness),
			...catalog.profiles.map(profile => profile.description),
		].join("\n");
		expect(jevText).not.toMatch(
			/\b(opus|sonnet|claude|anthropic|gpt|openai|codex|sol|luna|astra|grok|xai|gemini|flash|google)\b/i,
		);
	});

	test("every agent the catalog names exists", () => {
		const defined = new Set([
			...BUILTIN_AGENTS,
			...MACHINE_LOCAL_AGENTS,
			...readdirSync(join(import.meta.dir, "agents"))
				.filter(file => file.endsWith(".md"))
				.map(file => file.slice(0, -3)),
		]);
		const named = catalog.profiles.flatMap(profile => profile.agents);
		expect(named.filter(agent => !defined.has(agent))).toEqual([]);
	});

	test("accepts max as a slot effort and validates catalog boundaries", () => {
		const [first] = catalog.profiles;
		expect(() => parseCatalog({ ...catalog, version: 3 })).toThrow("settings");
		expect(() => parseCatalog({ ...catalog, profiles: [first, first] })).toThrow("unique");
		expect(() =>
			parseCatalog({
				...catalog,
				profiles: [
					{
						...first,
						effort: ["max", "max", "max", "max"],
						backups: [],
						speedPool: undefined,
						speedPoolPlacement: undefined,
					},
				],
			}),
		).not.toThrow();
		expect(() => parseCatalog({ ...catalog, profiles: [{ ...first, effort: ["low", "medium"] }] })).toThrow("profile");
		expect(() => parseCatalog({ ...catalog, difficulty: catalog.difficulty.slice(0, 2) })).toThrow("settings");
		expect(() => parseCatalog({ ...catalog, minConfidence: Number.NaN })).toThrow("settings");
		expect(() =>
			parseCatalog({
				...catalog,
				profiles: [
					{ id: "seat", effort: ["high", "high", "high", "high"], agents: ["task"], description: "Seat" },
					{ ...first, id: "slot", backups: [], speedPool: undefined, speedPoolPlacement: undefined },
				],
			}),
		).toThrow('seat agent "task"');
	});

	test("validates backup references, seat backups, and empty-agent backup-only slots", () => {
		const [first] = catalog.profiles;
		expect(() =>
			parseCatalog({
				...catalog,
				profiles: catalog.profiles.map(profile => (profile.id === "grunt" ? { ...profile, backups: ["missing"] } : profile)),
			}),
		).toThrow('backup "missing"');
		expect(() =>
			parseCatalog({
				...catalog,
				profiles: catalog.profiles.map(profile =>
					profile.id === "orchestrator" ? { ...profile, backups: ["grunt"] } : profile,
				),
			}),
		).toThrow("seat");
		expect(() =>
			parseCatalog({
				...catalog,
				profiles: catalog.profiles.map(profile =>
					profile.id === first.id ? { ...profile, agents: [], backups: [] } : profile,
				),
			}),
		).toThrow("no agents");
	});
	test("requires speedPoolPlacement exactly when a pool is declared", () => {
		const grunt = catalog.profiles.find(profile => profile.id === "grunt");
		if (!grunt) throw new Error("missing grunt profile");
		expect(() =>
			parseCatalog({
				...catalog,
				profiles: catalog.profiles.map(profile =>
					profile.id === "grunt" ? { ...profile, speedPoolPlacement: undefined } : profile,
				),
			}),
		).toThrow("speedPoolPlacement");
		expect(() =>
			parseCatalog({
				...catalog,
				profiles: catalog.profiles.map(profile =>
					profile.id === "grunt" ? { ...profile, speedPoolPlacement: "middle" } : profile,
				),
			}),
		).toThrow("profile");
		expect(() =>
			parseCatalog({
				...catalog,
				profiles: catalog.profiles.map(profile =>
					profile.id === "lookup-fast" ? { ...profile, speedPoolPlacement: "before" } : profile,
				),
			}),
		).toThrow("speedPoolPlacement");
	});
	test("rejects a zero demotion threshold", () => {
		expect(() =>
			parseCatalog({
				...catalog,
				speedPoolLimits: { ...catalog.speedPoolLimits, demoteAt: 0 },
			}),
		).toThrow("settings");
	});
});
describe("speed pool pacing", () => {
	test("maps five-hour and daily windows to short, and filters xAI products", () => {
		const gemini = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.2, elapsed: 0.2 },
			{ id: "daily", durationMs: 24 * 60 * 60 * 1000, used: 0.3, elapsed: 0.4 },
		]);
		expect(windowSamples(gemini, "gemini-3.8-flash").map(sample => sample.kind)).toEqual(["short", "short"]);
		const grok = usageReport("xai-oauth", [
			{ id: "xai-oauth:credits:weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
			{ id: "xai-oauth:product:monthly", durationMs: 30 * 24 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
		]);
		expect(windowSamples(grok, "grok-4.6").map(sample => sample.kind)).toEqual(["weekly"]);
	});
	test("rejects malformed pacing windows instead of masking them with valid siblings", () => {
		const member = poolMember("lookup-fast", "google-antigravity", { maxShortUsed: 0.5, minWeeklyHeadroom: 0 });
		const sibling = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
			{ id: "daily", durationMs: 24 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
		]);
		sibling.limits[1].window.resetsAt = Number.POSITIVE_INFINITY;
		expect(rankPool([member], [sibling], new Map(), new Set(), poolLimits, nowMs).order).toEqual([]);
		expect(rankPool([member], [sibling], new Map(), new Set(), poolLimits, nowMs).verdicts["lookup-fast"].status).toBe("no-usage");
		const negative = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: -0.1, elapsed: 0.2 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
		]);
		expect(rankPool([member], [negative], new Map(), new Set(), poolLimits, nowMs).verdicts["lookup-fast"].status).toBe("no-usage");
	});

	test("enforces break-even, Grok margins, optional monthly, demotion, and skip", () => {
		const gemini = poolMember("lookup-fast", "google-antigravity", { maxShortUsed: 0.5, minWeeklyHeadroom: 0 });
		const under = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.49, elapsed: 0.5 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.2, elapsed: 0.2 },
		]);
		expect(rankPool([gemini], [under], new Map(), new Set(), poolLimits, nowMs).order).toEqual(["lookup-fast"]);
		const atBoundary = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.5, elapsed: 0.5 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.2, elapsed: 0.2 },
		]);
		expect(rankPool([gemini], [atBoundary], new Map(), new Set(), poolLimits, nowMs).order).toEqual([]);
		const grok = poolMember("lookup-grok", "xai-oauth", { minWeeklyHeadroom: 0.05, minMonthlyHeadroom: 0 });
		const grokUsage = usageReport("xai-oauth", [
			{ id: "xai-oauth:credits:weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.1, elapsed: 0.15 },
			{ id: "xai-oauth:credits:monthly", durationMs: 30 * 24 * 60 * 60 * 1000, used: 0.5, elapsed: 0.55 },
		]);
		expect(rankPool([grok], [grokUsage], new Map(), new Set(), poolLimits, nowMs).order).toEqual(["lookup-grok"]);
		// xAI reports only a weekly credit window today; the monthly gate must not require one.
		const weeklyOnly = usageReport("xai-oauth", [
			{ id: "xai-oauth:credits:1w", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.02, elapsed: 0.17 },
		]);
		expect(rankPool([grok], [weeklyOnly], new Map(), new Set(), poolLimits, nowMs).order).toEqual(["lookup-grok"]);
		const nearPace = usageReport("xai-oauth", [
			{ id: "xai-oauth:credits:1w", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.13, elapsed: 0.17 },
		]);
		expect(rankPool([grok], [nearPace], new Map(), new Set(), poolLimits, nowMs).verdicts["lookup-grok"].status).toBe("below-pace");
		const invalidMonthly = usageReport("xai-oauth", [
			{ id: "xai-oauth:credits:1w", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.02, elapsed: 0.17 },
			{ id: "xai-oauth:credits:monthly", durationMs: 30 * 24 * 60 * 60 * 1000, used: 0.1 },
		]);
		expect(rankPool([grok], [invalidMonthly], new Map(), new Set(), poolLimits, nowMs).verdicts["lookup-grok"].status).toBe("no-usage");
		const monthlyOnly = usageReport("xai-oauth", [
			{ id: "xai-oauth:credits:monthly", durationMs: 30 * 24 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
		]);
		expect(rankPool([grok], [monthlyOnly], new Map(), new Set(), poolLimits, nowMs).verdicts["lookup-grok"].status).toBe("no-usage");
		const crowdMember = poolMember("lookup-fast", "google-antigravity", { maxShortUsed: 1, minWeeklyHeadroom: 0 });
		const crowded = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.8, elapsed: 0.9 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.2, elapsed: 0.2 },
		]);
		expect(rankPool([crowdMember], [crowded], new Map(), new Set(), poolLimits, nowMs).order).toEqual(["lookup-fast"]);
		expect(rankPool([crowdMember], [crowded], new Map(), new Set(), poolLimits, nowMs).verdicts["lookup-fast"].status).toBe("crowded");
		const skipped = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.95, elapsed: 0.95 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.2, elapsed: 0.2 },
		]);
		expect(rankPool([gemini], [skipped], new Map(), new Set(), poolLimits, nowMs).skipped).toEqual(["lookup-fast"]);
	});

	test("uses worst account, rejects stale/partial/skewed data, preserves exhausted skips, and applies penalties", () => {
		const member = poolMember("lookup-fast", "google-antigravity", { maxShortUsed: 0.5, minWeeklyHeadroom: 0 });
		const first = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.2, elapsed: 0.4 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.2, elapsed: 0.2 },
		]);
		const worst = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.49, elapsed: 0.5 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.3, elapsed: 0.3 },
		]);
		expect(rankPool([member], [first, worst], new Map(), new Set(), poolLimits, nowMs).order).toEqual(["lookup-fast"]);
		// Each account must report every required window; another account's window does not cover the gap.
		const weeklyMissing = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.1, elapsed: 0.4 },
		]);
		expect(rankPool([member], [first, weeklyMissing], new Map(), new Set(), poolLimits, nowMs).verdicts["lookup-fast"].status).toBe("no-usage");
		expect(rankPool([member], { reports: [first], credentialCounts: { "google-antigravity": 2 } }, new Map(), new Set(), poolLimits, nowMs).verdicts["lookup-fast"].status).toBe("partial-usage");
		const stale = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
		], nowMs - poolLimits.maxReportAgeMs - 1);
		expect(rankPool([member], [stale], new Map(), new Set(), poolLimits, nowMs).verdicts["lookup-fast"].status).toBe("stale");
		const exhausted = usageReport("google-antigravity", [
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0, elapsed: 0.2, status: "exhausted" },
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
		]);
		expect(rankPool([member], [exhausted], new Map(), new Set(), poolLimits, nowMs).skipped).toEqual(["lookup-fast"]);
		expect(rankPool([member], [first], new Map([["lookup-fast", 0.31]]), new Set(), poolLimits, nowMs).verdicts["lookup-fast"].status).toBe("below-pace");
	});

	test("returns telemetry-demoted members separately", () => {
		const member = poolMember("lookup-fast", "google-antigravity", { maxShortUsed: 0.5, minWeeklyHeadroom: 0 });
		const report = usageReport("google-antigravity", [
			{ id: "5h", durationMs: 5 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
			{ id: "weekly", durationMs: 7 * 24 * 60 * 60 * 1000, used: 0.1, elapsed: 0.2 },
		]);
		const result = rankPool([member], [report], new Map(), new Set(["lookup-fast"]), poolLimits, nowMs);
		expect(result.order).toEqual([]);
		expect(result.demoted).toEqual(["lookup-fast"]);
	});
});

describe("effort fitting", () => {
	test("keeps a supported effort, else the nearest lower one, else the nearest higher one", () => {
		expect(fitEffort("high", ["medium", "high", "xhigh"])).toBe("high");
		expect(fitEffort("xhigh", ["low", "medium", "high"])).toBe("high");
		expect(fitEffort("low", ["high", "xhigh"])).toBe("high");
		expect(fitEffort("medium", [])).toBeUndefined();
	});
});

describe("classification", () => {
	test("selects an allowed option from a typed answer", async () => {
		let state: string | undefined;
		const result = await choose(
			"Investigate a cross-service migration",
			candidates,
			false,
			catalog,
			async (request, signal) => {
				state = request.state;
				expect(signal.aborted).toBe(false);
				expect(request.questions.difficulty).toBeUndefined();
				return strong(request, signal);
			},
		);
		expect(state).toBe("Investigate a cross-service migration");
		expect(result).toEqual({
			source: "jev",
			choice: "strong",
			confidence: 0.9,
			reason: "classified",
			usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cost: 0.0004 },
		});
	});

	test("asks route and difficulty in one call and returns both", async () => {
		let calls = 0;
		const result = await choose("task", candidates, true, catalog, async request => {
			calls++;
			expect(request.questions.difficulty?.criteria).toEqual(catalog.difficulty);
			return {
				answers: {
					route: { type: "choice", choice: "small", confidence: 1, probabilities: { small: 1, strong: 0 } },
					difficulty: difficultyAnswer(2.6),
				},
			};
		});
		expect(calls).toBe(1);
		expect(result).toMatchObject({ source: "jev", choice: "small", difficulty: 3 });
	});
	test("ranks each selectable slot's backups in the same Jev call", async () => {
		const slots = [
			{
				id: "grunt",
				description: "settled code",
				backups: [
					{ id: "grunt-backup", description: "settled code at full effort" },
					{ id: "peer", description: "adversarial investigation" },
				],
			},
			{
				id: "lead",
				description: "judgment-heavy implementation",
				backups: [{ id: "peer", description: "adversarial investigation" }],
			},
		];
		let calls = 0;
		const result = await choose("task", slots, false, catalog, async request => {
			calls++;
			expect(request.questions.route?.criteria).toEqual({ grunt: "settled code", lead: "judgment-heavy implementation" });
			expect(request.questions["backup:grunt"]?.criteria).toEqual({
				"grunt-backup": "settled code at full effort",
				peer: "adversarial investigation",
			});
			expect(request.questions["backup:lead"]).toBeUndefined();
			return {
				answers: {
					route: { type: "choice", choice: "grunt", confidence: 0.95, probabilities: { grunt: 1, lead: 0 } },
					"backup:grunt": {
						type: "choice",
						choice: "peer",
						confidence: 0.9,
						probabilities: { "grunt-backup": 0.2, peer: 0.8 },
					},
				},
			};
		});
		expect(calls).toBe(1);
		expect(result).toMatchObject({
			source: "jev",
			choice: "grunt",
			backupOrder: { grunt: ["peer", "grunt-backup"], lead: ["peer"] },
		});
	});

	test("keeps catalog backup order for invalid or uncertain backup answers", async () => {
		const slots = [
			{
				id: "grunt",
				description: "settled code",
				backups: [
					{ id: "grunt-backup", description: "settled code at full effort" },
					{ id: "peer", description: "adversarial investigation" },
				],
			},
			{ id: "lead", description: "judgment-heavy implementation" },
		];
		for (const answer of [
			{ type: "choice", choice: "peer", confidence: 0.9 },
			{
				type: "choice",
				choice: "peer",
				confidence: 0.2,
				probabilities: { "grunt-backup": 0.2, peer: 0.8 },
			},
		]) {
			const result = await choose("task", slots, false, catalog, async () => ({
				answers: {
					route: { type: "choice", choice: "grunt", confidence: 0.9, probabilities: { grunt: 1, lead: 0 } },
					"backup:grunt": answer,
				},
			}));
			expect(result).toMatchObject({
				source: "jev",
				choice: "grunt",
				backupOrder: { grunt: ["grunt-backup", "peer"] },
			});
		}
	});

	test("can call Jev for backups when one fixed slot is selected", async () => {
		const result = await choose(
			"task",
			[
				{
					id: "grunt",
					description: "settled code",
					backups: [
						{ id: "grunt-backup", description: "settled code at full effort" },
						{ id: "peer", description: "adversarial investigation" },
					],
				},
			],
			false,
			catalog,
			async request => {
				expect(request.questions.route).toBeUndefined();
				expect(request.questions["backup:grunt"]).toBeDefined();
				return {
					answers: {
						"backup:grunt": {
							type: "choice",
							choice: "peer",
							confidence: 0.9,
							probabilities: { "grunt-backup": 0.1, peer: 0.9 },
						},
					},
				};
			},
		);
		expect(result).toEqual({
			source: "jev",
			backupOrder: { grunt: ["peer", "grunt-backup"] },
			reason: "classified",
		});
	});

	test("rates difficulty alone when no slots compete", async () => {
		const result = await choose("task", [], true, catalog, async request => {
			expect(request.questions.route).toBeUndefined();
			return { answers: { difficulty: difficultyAnswer(0.2) } };
		});
		expect(result).toEqual({ source: "jev", difficulty: 0, reason: "classified" });
	});

	test("an uncertain difficulty keeps a confident route but fails a difficulty-only call", async () => {
		const routed = await choose("task", candidates, true, catalog, async () => ({
			answers: {
				route: { type: "choice", choice: "strong", confidence: 1, probabilities: { small: 0, strong: 1 } },
				difficulty: difficultyAnswer(3, 0.3),
			},
		}));
		expect(routed).toMatchObject({ source: "jev", choice: "strong" });
		expect(routed.difficulty).toBeUndefined();

		const alone = await choose("task", [], true, catalog, async () => ({
			answers: { difficulty: difficultyAnswer(3, 0.3) },
		}));
		expect(alone).toEqual({ source: "baseline", confidence: 0.3, reason: "uncertain-difficulty" });

		const malformed = await choose("task", [], true, catalog, async () => ({
			answers: { difficulty: { type: "score", score: 9, confidence: 1 } },
		}));
		expect(malformed.reason).toBe("routing-invalid-response");
	});

	test("retains the baseline on an uncertain or invented route", async () => {
		for (const route of [
			{ type: "choice", choice: "strong", confidence: 0.2, probabilities: { small: 0.4, strong: 0.6 } },
			{ type: "choice", choice: "invented", confidence: 1, probabilities: { small: 0, strong: 1 } },
			{ type: "choice", choice: "strong", confidence: 1, probabilities: { small: 0.9, strong: 0.1 } },
			{ type: "choice", choice: "strong", confidence: 1, probabilities: { small: 0, strong: Number.NaN } },
		]) {
			const result = await choose("task", candidates, false, catalog, async () => ({ answers: { route } }));
			expect(result.source).toBe("baseline");
			expect(result.choice).toBeUndefined();
		}
	});

	test("does not send oversized tasks or classify a single slot or an empty call", async () => {
		let calls = 0;
		const evaluate: Evaluate = async () => {
			calls++;
			return {};
		};
		expect((await choose("x".repeat(catalog.maxInputBytes), candidates, false, catalog, evaluate)).reason).toBe(
			"input-budget-exceeded",
		);
		expect((await choose("task", candidates.slice(0, 1), false, catalog, evaluate)).reason).toBe("nothing-to-classify");
		expect((await choose("task", [], false, catalog, evaluate)).reason).toBe("nothing-to-classify");
		expect(calls).toBe(0);
	});

	test("bounds a stuck evaluator without leaking provider error text", async () => {
		const result = await choose(
			"task",
			candidates,
			false,
			{ ...catalog, timeoutMs: 100 },
			async () => Promise.withResolvers<unknown>().promise,
		);
		expect(result.reason).toBe("routing-timeout");
		const failed = await choose("task", candidates, false, catalog, async () => {
			throw new Error("secret echoed by upstream");
		});
		expect(failed).toEqual({ source: "baseline", reason: "routing-unavailable" });
	});

	test("categorizes provider failures without retaining response text", async () => {
		const auth = await choose("task", candidates, false, catalog, async () => {
			throw Object.assign(new Error("secret auth response"), { status: 401 });
		});
		expect(auth.reason).toBe("routing-auth");

		const malformed = await choose("task", candidates, false, catalog, async () => ({ body: "malformed body" }));
		expect(malformed.reason).toBe("routing-invalid-response");
		expect(JSON.stringify({ auth, malformed })).not.toContain("secret");
		expect(JSON.stringify({ auth, malformed })).not.toContain("malformed body");
	});

	test("caller cancellation stops routing rather than dispatching a fallback", async () => {
		const controller = new AbortController();
		const running = choose(
			"task",
			candidates,
			false,
			catalog,
			async (_request, signal) => {
				controller.abort(new Error("cancelled"));
				signal.throwIfAborted();
				return {};
			},
			controller.signal,
		);
		await expect(running).rejects.toThrow("cancelled");
	});
});

describe("planning readiness", () => {
	test("classifies a clear, bounded planning request as autonomous", async () => {
		const result = await evaluatePlanningReadiness(
			"Update src/cache.ts to use an LRU map. Preserve current public behavior and cache size. Acceptance: existing cache tests pass and add coverage for eviction. Constraint: no new dependencies.",
			catalog,
			async () => ({
				answers: {
					route: {
						type: "choice",
						choice: "autonomous-plan",
						confidence: 0.94,
						probabilities: { "autonomous-plan": 0.94, "discuss-with-user": 0.06 },
					},
				},
				usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.0002 } },
			}),
		);
		expect(result.route).toBe("autonomous-plan");
		expect(result.confidence).toBe(0.94);
		expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12, cost: 0.0002 });
	});

	test("pushes an open-ended planning request to user discussion", async () => {
		const result = await evaluatePlanningReadiness("Improve our authentication architecture.", catalog, async () => ({
			answers: {
				route: {
					type: "choice",
					choice: "discuss-with-user",
					confidence: 0.91,
					probabilities: { "autonomous-plan": 0.09, "discuss-with-user": 0.91 },
				},
			},
		}));
		expect(result.route).toBe("discuss-with-user");
		expect(result.reason).toContain("unresolved product or architectural");
	});

	test("fails closed on low confidence or an aborted evaluator", async () => {
		const lowConfidence = await evaluatePlanningReadiness("Bounded task", catalog, async () => ({
			answers: {
				route: {
					type: "choice",
					choice: "autonomous-plan",
					confidence: 0.4,
					probabilities: { "autonomous-plan": 0.7, "discuss-with-user": 0.3 },
				},
			},
		}));
		expect(lowConfidence).toEqual({
			route: "discuss-with-user",
			confidence: 0.4,
			reason: "readiness-low-confidence",
		});
		const aborted = await evaluatePlanningReadiness("Bounded task", catalog, async () => {
			throw new DOMException("aborted", "AbortError");
		});
		expect(aborted.route).toBe("discuss-with-user");
		expect(aborted.confidence).toBe(0);
		expect(aborted.reason).toBe("readiness-routing-aborted");
	});
});
