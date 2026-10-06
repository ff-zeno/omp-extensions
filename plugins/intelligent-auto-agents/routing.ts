import {
	resolveUsedFraction,
	scopeAntigravityLimitsForModel,
	type UsageLimit,
	type UsageReport,
} from "@oh-my-pi/pi-ai";

/** Efforts Jev may assign, lowest to highest. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
/**
 * Difficulty names, lowest first. Jev scores difficulty 0..3 against this order, so index 0 is
 * `exact` and index 1 (`ordinary`) is the fallback when the rating is uncertain.
 */
export const DIFFICULTY_NAMES = ["exact", "ordinary", "hard", "critical"] as const;
export type Difficulty = (typeof DIFFICULTY_NAMES)[number];
export const DIFFICULTY_LEVELS = 4;
export const ORDINARY: Difficulty = "ordinary";
/** Usage windows, shortest first. */
export const WINDOW_KINDS = ["short", "weekly", "monthly"] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];
export type EffortRange = readonly [Effort, Effort];

export type ModelRef = { provider: string; id: string };

/**
 * What each difficulty means for one concrete model. `supports` mirrors OMP model metadata; a
 * mapped effort outside it is rejected at parse time. `models["*"]` is the fallback map for a
 * resolved model with no entry and never carries `supports`.
 */
export type ModelMap = {
	supports?: readonly string[];
	/** Ceiling for this model's resolved effort, even when a pool member or range asks higher. */
	maxEffort?: Effort;
	exact: Effort;
	ordinary: Effort;
	hard: Effort;
	critical: Effort;
};

/** A pool member as written in the catalog: a role alias or a literal provider/model. */
export type PoolMemberSpec = {
	id?: string;
	model: string;
	/** Pins this member's effort, overriding the model map and the task-type range. */
	effort?: Effort;
	/** Difficulties this member serves. Absent means every difficulty. */
	difficulties?: Difficulty[];
	maxShortUsed?: number;
	minWeeklyHeadroom?: number;
	minMonthlyHeadroom?: number;
};

/** A pool fallback; a pinned effort overrides the model map, otherwise the map plus task-type range decides. */
export type PoolFallback = { model: string; effort?: Effort };
export type PoolSpec = {
	/** When true, the router reads the plan front matter named in the brief and excludes authors. */
	excludePlanAuthors?: boolean;
	members: PoolMemberSpec[];
	fallback: PoolFallback;
};

/** Where a task type gets its model: a pool, a fixed role/literal, or the agent's bound model. */
export type TaskTypeSpec = {
	pool?: string;
	model?: string;
	effort?: EffortRange;
	/** Provider-failure fallbacks for a fixed `model` only; quota never moves these. */
	backups?: string[];
	description: string;
};

export type PlanMetadata = {
	frontMatterKey: string;
	authorsField: string;
	reviewsField: string;
	scanLines: number;
};

export type PoolLimits = {
	demoteAt: number;
	skipAt: number;
	burstPenalty: number;
	/**
	 * Final stretch before a weekly reset. Inside it, unused weekly quota is lost, so the
	 * weekly pace check and weekly crowding are lifted, in-flight burst penalties also count
	 * against the weekly window, and the short-window cap rises to demoteAt. skipAt still
	 * stops new work, leaving 1 - skipAt for tasks that are already running.
	 */
	finalWindowMs: number;
	usageTimeoutMs: number;
	maxReportAgeMs: number;
	clockSkewMs: number;
	failureDemoteAfter: number;
	demoteForMs: number;
	/** Which window a provider's in-flight burst penalty counts against; `*` is the default. */
	burstPenaltyWindow: Record<string, WindowKind>;
};

export type Catalog = {
	version: 7;
	enabled: boolean;
	timeoutMs: number;
	maxInputBytes: number;
	minConfidence: number;
	jevModel: string;
	/** Instructions Jev receives for the task-type question and the difficulty rating. */
	jevInstructions: { route: string; difficulty: string };
	planningReadiness: { agents: string[]; instructions: string; routes: Record<PlanningRoute, string> };
	difficulty: Record<Difficulty, string>;
	/** Judgment notes fed verbatim into Jev's prompt. */
	nuances: string[];
	/** Difficulty-to-effort maps keyed by concrete provider/model, plus the `*` fallback. */
	models: Record<string, ModelMap>;
	/** Model references kept off worker duty; they may only appear in the named pools. */
	reviewOnly: { models: string[]; containing: string[]; pools: string[] };
	poolLimits: PoolLimits;
	pools: Record<string, PoolSpec>;
	taskTypes: Record<string, TaskTypeSpec>;
	agents: { covered: string[]; pinned: string[] };
	planMetadata: PlanMetadata;
	/** Case-insensitive substrings no directive target may contain. */
	blockedDirectiveTargets: string[];
	/** Directive names Jev may resolve through OMP roles or literal provider/model ids. */
	directiveTargets: Record<string, string>;
};

export type PlanningRoute = "autonomous-plan" | "discuss-with-user";
export type UsageSummary = { inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: number };
export type PlanningReadiness = {
	route: PlanningRoute;
	confidence: number;
	reason: string;
	usage?: UsageSummary;
};
/** One selectable option Jev chooses between: a task type here. */
export type Slot = { id: string; description: string; backups?: readonly Slot[] };
export type Decision = {
	/** `catalog` is a fixed task type or seat that needed no Jev call. */
	source: "jev" | "baseline" | "catalog";
	/** Chosen task-type id when Jev picked between two or more. */
	choice?: string;
	/** Jev's top task type when its route confidence fell below `minConfidence`. */
	leading?: string;
	/** Difficulty name when Jev rated it with enough confidence. */
	difficulty?: Difficulty;
	confidence?: number;
	reason: string;
	usage?: UsageSummary;
};
export type ChoiceRequest = {
	state: string;
	questions: {
		route?: { type: "choice"; instructions: string; criteria: Record<string, string> };
		difficulty?: { type: "score"; instructions: string; criteria: string[] };
	};
};
export type Evaluate = (request: ChoiceRequest, signal: AbortSignal) => Promise<unknown>;

/** A `Directive: use <target> [effort]` line parsed from the brief's task text. */
export type Directive = { target: string; effort?: Effort; span: string };
/** Model metadata read from a plan document's front matter. */
export type PlanProvenance = { authors: string[]; reviews: string[] };

export class RoutingAuthenticationError extends Error {}

class InvalidResponseError extends Error {}
class RoutingTimeoutError extends Error {}
class InputBudgetError extends Error {}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function unit(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function summarizeUsage(value: unknown): UsageSummary | undefined {
	if (!record(value)) return undefined;
	const inputTokens = numberValue(value.input);
	const outputTokens = numberValue(value.output);
	const totalTokens =
		numberValue(value.totalTokens) ??
		(inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
	const cost = record(value.cost) ? numberValue(value.cost.total) : undefined;
	if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && cost === undefined)
		return undefined;
	return {
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(cost !== undefined ? { cost } : {}),
	};
}

function safeFailureCategory(error: unknown): string {
	if (error instanceof RoutingTimeoutError) return "routing-timeout";
	if (error instanceof RoutingAuthenticationError) return "routing-auth";
	if (error instanceof InvalidResponseError || error instanceof SyntaxError) return "routing-invalid-response";
	if (record(error)) {
		if (error.name === "AbortError") return "routing-aborted";
		const status = numberValue(error.status);
		if (status === 401 || status === 403) return "routing-auth";
		if (status === 400 || status === 422 || error.kind === "envelope") return "routing-invalid-response";
	}
	return "routing-unavailable";
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(text);
}
function agentNames(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(text);
}
function unique(ids: string[]): boolean {
	return new Set(ids).size === ids.length;
}

function positiveInteger(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}

function isEffort(value: unknown): value is Effort {
	return EFFORTS.some(effort => effort === value);
}

function isWindowKind(value: unknown): value is WindowKind {
	return WINDOW_KINDS.some(kind => kind === value);
}

function isDifficulty(value: unknown): value is Difficulty {
	return DIFFICULTY_NAMES.some(name => name === value);
}

function difficultyScope(value: unknown): value is Difficulty[] {
	if (!Array.isArray(value) || value.length === 0) return false;
	if (!value.every(isDifficulty)) return false;
	return unique(value);
}

function effortRange(value: unknown): value is EffortRange {
	if (!Array.isArray(value) || value.length !== 2) return false;
	const [min, max] = value;
	if (!isEffort(min) || !isEffort(max)) return false;
	return EFFORTS.indexOf(min) <= EFFORTS.indexOf(max);
}

function poolMember(value: unknown): value is PoolMemberSpec {
	if (
		!record(value) ||
		!text(value.model) ||
		(value.id !== undefined && !text(value.id)) ||
		(value.effort !== undefined && !isEffort(value.effort))
	)
		return false;
	const thresholds = [value.maxShortUsed, value.minWeeklyHeadroom, value.minMonthlyHeadroom];
	if (!thresholds.every(threshold => threshold === undefined || unit(threshold))) return false;
	if (!strings([value.model])) return false;
	return value.difficulties === undefined || difficultyScope(value.difficulties);
}

function poolSpec(value: unknown): value is PoolSpec {
	if (!record(value) || !Array.isArray(value.members) || value.members.length === 0) return false;
	if (!value.members.every(poolMember)) return false;
	if (value.excludePlanAuthors !== undefined && typeof value.excludePlanAuthors !== "boolean") return false;
	return record(value.fallback) && text(value.fallback.model) && (value.fallback.effort === undefined || isEffort(value.fallback.effort));
}

function taskTypeSpec(value: unknown): value is TaskTypeSpec {
	if (!record(value) || !text(value.description)) return false;
	if (value.pool !== undefined && !text(value.pool)) return false;
	if (value.model !== undefined && !text(value.model)) return false;
	if (value.effort !== undefined && !effortRange(value.effort)) return false;
	if (value.backups !== undefined && (!Array.isArray(value.backups) || !value.backups.every(text) || !unique(value.backups)))
		return false;
	return true;
}

function modelMap(value: unknown, fallback: boolean): value is ModelMap {
	if (!record(value)) return false;
	if (!isEffort(value.exact) || !isEffort(value.ordinary) || !isEffort(value.hard) || !isEffort(value.critical))
		return false;
	if (fallback) return value.supports === undefined && value.maxEffort === undefined;
	if (!strings(value.supports)) return false;
	if (![value.exact, value.ordinary, value.hard, value.critical].every(effort => value.supports!.includes(effort)))
		return false;
	return value.maxEffort === undefined || (isEffort(value.maxEffort) && value.supports.includes(value.maxEffort));
}

function poolLimits(value: unknown): value is PoolLimits {
	if (!record(value)) return false;
	if (!record(value.burstPenaltyWindow)) return false;
	if (!Object.entries(value.burstPenaltyWindow).every(([provider, kind]) => text(provider) && isWindowKind(kind)))
		return false;
	if (!isWindowKind(value.burstPenaltyWindow["*"])) return false;
	return (
		unit(value.demoteAt) &&
		unit(value.skipAt) &&
		value.demoteAt > 0 &&
		value.demoteAt < value.skipAt &&
		unit(value.burstPenalty) &&
		positiveInteger(value.finalWindowMs, 86_400_000) &&
		positiveInteger(value.usageTimeoutMs, 60_000) &&
		positiveInteger(value.maxReportAgeMs, 86_400_000) &&
		positiveInteger(value.clockSkewMs, 3_600_000) &&
		positiveInteger(value.failureDemoteAfter, 255) &&
		positiveInteger(value.demoteForMs, 86_400_000)
	);
}

/** True when a catalog model reference is kept off worker duty by the catalog's reviewOnly policy. */
function reviewOnlyRef(reviewOnly: Catalog["reviewOnly"], spec: string): boolean {
	if (reviewOnly.models.includes(spec)) return true;
	const lower = spec.toLowerCase();
	return reviewOnly.containing.some(substring => lower.includes(substring.toLowerCase()));
}

function assertWorkerSafeModel(reviewOnly: Catalog["reviewOnly"], spec: string, context: string): void {
	if (reviewOnlyRef(reviewOnly, spec))
		throw new Error(`Auto-agents ${context} names a model that cannot take worker work: ${spec}`);
}

function assertModelSafeMap(
	value: Record<string, unknown>,
	pools: Record<string, PoolSpec>,
	taskTypes: Record<string, TaskTypeSpec>,
	reviewOnly: Catalog["reviewOnly"],
	blockedDirectiveTargets: string[],
): void {
	for (const [name, pool] of Object.entries(pools)) {
		if (reviewOnly.pools.includes(name)) continue;
		for (const member of pool.members) assertWorkerSafeModel(reviewOnly, member.model, `pool member "${name}"`);
		assertWorkerSafeModel(reviewOnly, pool.fallback.model, `pool fallback "${name}"`);
	}
	for (const [name, taskType] of Object.entries(taskTypes)) {
		if (taskType.model) assertWorkerSafeModel(reviewOnly, taskType.model, `task type "${name}"`);
		for (const backup of taskType.backups ?? []) assertWorkerSafeModel(reviewOnly, backup, `task type "${name}" backup`);
	}
	for (const target of Object.values(value.directiveTargets as Record<string, string>)) {
		const lower = target.toLowerCase();
		if (blockedDirectiveTargets.some(substring => lower.includes(substring.toLowerCase())))
			throw new Error(`Auto-agents directive target cannot name ${target}`);
	}
}

export function parseCatalog(value: unknown): Catalog {
	if (
		!record(value) ||
		value.version !== 7 ||
		typeof value.enabled !== "boolean" ||
		!Number.isInteger(value.timeoutMs) ||
		Number(value.timeoutMs) < 100 ||
		Number(value.timeoutMs) > 10000 ||
		!Number.isInteger(value.maxInputBytes) ||
		Number(value.maxInputBytes) < 1000 ||
		Number(value.maxInputBytes) > 64000 ||
		!unit(value.minConfidence) ||
		!text(value.jevModel) ||
		!record(value.jevInstructions) ||
		!text(value.jevInstructions.route) ||
		!text(value.jevInstructions.difficulty) ||
		!record(value.planningReadiness) ||
		!strings(value.planningReadiness.agents) ||
		!unique(value.planningReadiness.agents) ||
		!text(value.planningReadiness.instructions) ||
		!record(value.planningReadiness.routes) ||
		!text(value.planningReadiness.routes["autonomous-plan"]) ||
		!text(value.planningReadiness.routes["discuss-with-user"]) ||
		!record(value.difficulty) ||
		!DIFFICULTY_NAMES.every(name => text(value.difficulty[name])) ||
		!Array.isArray(value.nuances) ||
		!value.nuances.every(text) ||
		!record(value.models) ||
		!modelMap(value.models["*"], true) ||
		!record(value.reviewOnly) ||
		!agentNames(value.reviewOnly.models) ||
		!agentNames(value.reviewOnly.containing) ||
		!agentNames(value.reviewOnly.pools) ||
		!poolLimits(value.poolLimits) ||
		!record(value.pools) ||
		!record(value.taskTypes) ||
		!record(value.agents) ||
		!agentNames(value.agents.covered) ||
		!agentNames(value.agents.pinned) ||
		!unique(value.agents.covered) ||
		!unique(value.agents.pinned) ||
		!record(value.planMetadata) ||
		!text(value.planMetadata.frontMatterKey) ||
		!text(value.planMetadata.authorsField) ||
		!text(value.planMetadata.reviewsField) ||
		!positiveInteger(value.planMetadata.scanLines, 1000) ||
		!Array.isArray(value.blockedDirectiveTargets) ||
		!value.blockedDirectiveTargets.every(text) ||
		!record(value.directiveTargets) ||
		!Object.values(value.directiveTargets).every(text)
	) {
		throw new Error("Invalid auto-agents catalog settings");
	}

	const models: Record<string, ModelMap> = {};
	for (const [key, entry] of Object.entries(value.models)) {
		if (!text(key) || !modelMap(entry, key === "*")) throw new Error("Invalid auto-agents model map");
		models[key] = entry;
	}

	const pools: Record<string, PoolSpec> = {};
	for (const [name, entry] of Object.entries(value.pools)) {
		if (!text(name) || !poolSpec(entry)) throw new Error("Invalid auto-agents pool");
		pools[name] = entry;
	}

	const reviewOnly: Catalog["reviewOnly"] = {
		models: value.reviewOnly.models,
		containing: value.reviewOnly.containing,
		pools: value.reviewOnly.pools,
	};
	for (const name of reviewOnly.pools) {
		if (!(name in pools)) throw new Error(`Auto-agents reviewOnly names unknown pool "${name}"`);
	}

	const taskTypes: Record<string, TaskTypeSpec> = {};
	for (const [name, entry] of Object.entries(value.taskTypes)) {
		if (!text(name) || !taskTypeSpec(entry)) throw new Error(`Invalid auto-agents task type "${name}"`);
		if (entry.pool !== undefined && !(entry.pool in pools))
			throw new Error(`Auto-agents task type "${name}" names unknown pool "${entry.pool}"`);
		if (entry.pool !== undefined && entry.model !== undefined)
			throw new Error(`Auto-agents task type "${name}" cannot name both a pool and a model`);
		taskTypes[name] = entry;
	}

	const directives: Record<string, string> = {};
	for (const [name, target] of Object.entries(value.directiveTargets)) {
		if (!text(name) || !text(target)) throw new Error("Invalid auto-agents directive target");
		directives[name] = target;
	}

	assertModelSafeMap(value as Record<string, unknown>, pools, taskTypes, reviewOnly, value.blockedDirectiveTargets);

	return {
		version: 7,
		enabled: value.enabled,
		timeoutMs: Number(value.timeoutMs),
		maxInputBytes: Number(value.maxInputBytes),
		minConfidence: value.minConfidence,
		jevModel: value.jevModel,
		jevInstructions: {
			route: value.jevInstructions.route,
			difficulty: value.jevInstructions.difficulty,
		},
		planningReadiness: {
			agents: value.planningReadiness.agents,
			instructions: value.planningReadiness.instructions,
			routes: {
				"autonomous-plan": value.planningReadiness.routes["autonomous-plan"],
				"discuss-with-user": value.planningReadiness.routes["discuss-with-user"],
			},
		},
		difficulty: {
			exact: value.difficulty.exact,
			ordinary: value.difficulty.ordinary,
			hard: value.difficulty.hard,
			critical: value.difficulty.critical,
		},
		nuances: value.nuances,
		models,
		reviewOnly,
		poolLimits: value.poolLimits,
		pools,
		taskTypes,
		agents: { covered: value.agents.covered, pinned: value.agents.pinned },
		planMetadata: {
			frontMatterKey: value.planMetadata.frontMatterKey,
			authorsField: value.planMetadata.authorsField,
			reviewsField: value.planMetadata.reviewsField,
			scanLines: Number(value.planMetadata.scanLines),
		},
		blockedDirectiveTargets: value.blockedDirectiveTargets,
		directiveTargets: directives,
	};
}

/** True when a task type's effort depends on difficulty, so Jev must rate it. */
export function taskTypeEffortVaries(catalog: Catalog, name: string): boolean {
	const taskType = catalog.taskTypes[name];
	if (!taskType) return false;
	if (taskType.model !== undefined) return true;
	if (taskType.pool === undefined) return true;
	const pool = catalog.pools[taskType.pool];
	if (!pool) return false;
	return pool.members.some(member => member.effort === undefined || member.difficulties !== undefined);
}

/** Effort for a resolved model id at a difficulty, from its catalog map or the `*` fallback. */
export function modelDifficultyEffort(catalog: Catalog, modelId: string, difficulty: Difficulty): Effort {
	const map = catalog.models[modelId] ?? catalog.models["*"];
	return map?.[difficulty] ?? map?.ordinary ?? "medium";
}

/** Clamp an effort into a task-type range, preserving order low < medium < high < xhigh < max. */
export function clampEffort(wanted: Effort, range?: EffortRange): Effort {
	if (!range) return wanted;
	const [min, max] = range;
	const index = EFFORTS.indexOf(wanted);
	return EFFORTS[Math.min(Math.max(index, EFFORTS.indexOf(min)), EFFORTS.indexOf(max))];
}

/** Cap an effort at the model's catalog `maxEffort`; models without one are unconstrained. */
export function capEffort(catalog: Catalog, modelId: string, effort: Effort): Effort {
	const maxEffort = catalog.models[modelId]?.maxEffort;
	if (maxEffort !== undefined && EFFORTS.indexOf(effort) > EFFORTS.indexOf(maxEffort)) return maxEffort;
	return effort;
}

/**
 * Nearest effort the model supports: the wanted effort, else the closest lower one, else the closest higher one.
 * Returns undefined when the model supports none of the routable efforts.
 */
export function fitEffort(wanted: Effort, supported: readonly string[]): Effort | undefined {
	if (supported.includes(wanted)) return wanted;
	const index = EFFORTS.indexOf(wanted);
	for (let lower = index - 1; lower >= 0; lower--) if (supported.includes(EFFORTS[lower])) return EFFORTS[lower];
	for (let higher = index + 1; higher < EFFORTS.length; higher++)
		if (supported.includes(EFFORTS[higher])) return EFFORTS[higher];
	return undefined;
}

/**
 * Resolve a model's effort: its map at the rated difficulty, clamped to the task-type range, capped
 * by model invariants, then fitted to the efforts the model supports.
 */
export function effortForModel(
	catalog: Catalog,
	modelId: string,
	difficulty: Difficulty,
	range?: EffortRange,
	supported?: readonly string[],
): Effort | undefined {
	const wanted = capEffort(catalog, modelId, clampEffort(modelDifficultyEffort(catalog, modelId, difficulty), range));
	const efforts = supported ?? catalog.models[modelId]?.supports ?? EFFORTS;
	return fitEffort(wanted, efforts);
}

const DIRECTIVE_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?directive:[ \t]*use[ \t]+(\S+)(?:[ \t]+(low|medium|high|xhigh|max))?[ \t]*$/im;

/** Parse a `Directive: use <target> [effort]` line from the brief's task text. */
export function parseDirective(text: string): Directive | undefined {
	const match = DIRECTIVE_LINE.exec(text);
	if (!match) return undefined;
	const target = match[1];
	if (!text.trim()) return undefined;
	return {
		target,
		...(match[2] ? { effort: match[2] as Effort } : {}),
		span: match[0].trim(),
	};
}

/** A literal `provider/model` reference: one slash, no whitespace, no leading `@`. */
export function isLiteralModel(spec: string): boolean {
	if (spec.startsWith("@") || /\s/.test(spec)) return false;
	const slash = spec.indexOf("/");
	return slash > 0 && slash < spec.length - 1;
}

/**
 * Read plan front matter to learn which models authored and reviewed the plan. Returns undefined
 * when the document has no readable `plan` front matter.
 */
export function planProvenance(content: string, meta: PlanMetadata): PlanProvenance | undefined {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return undefined;
	let end = -1;
	const limit = Math.min(lines.length, meta.scanLines + 1);
	for (let index = 1; index < limit; index++) {
		if (lines[index].trim() === "---") {
			end = index;
			break;
		}
	}
	if (end < 0) return undefined;
	const body = lines.slice(1, end);
	if (!body.some(line => new RegExp(`^[ \\t]*${meta.frontMatterKey}\\s*:`).test(line))) return undefined;
	const collect = (key: string): string[] => {
		const models: string[] = [];
		let active = false;
		let indent = -1;
		for (const line of body) {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;
			const currentIndent = line.length - line.trimStart().length;
			if (!active) {
				if (new RegExp(`^${key}\\s*:`).test(trimmed)) {
					active = true;
					indent = currentIndent;
				}
				continue;
			}
			if (currentIndent <= indent) {
				active = false;
				if (new RegExp(`^${key}\\s*:`).test(trimmed)) {
					active = true;
					indent = currentIndent;
				}
				continue;
			}
			const match = /^\s*(?:-\s*)?model\s*:\s*(\S+)/.exec(line);
			if (match) {
				const raw = match[1].trim();
				models.push(raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'")) ? raw.slice(1, -1) : raw);
			}
		}
		return models;
	};
	return { authors: collect(meta.authorsField), reviews: collect(meta.reviewsField) };
}

/**
 * Order plan-review pool members by author exclusion: drop authors, then prefer models absent from
 * `reviews`. Reuses the first non-author when every non-author has already reviewed, and the first
 * member when every member authored the plan.
 */
export function preferPlanReviewMembers(
	members: readonly PoolMember[],
	provenance: PlanProvenance | undefined,
): { members: PoolMember[]; excluded: string[]; unknown: boolean } {
	if (!provenance) return { members: [...members], excluded: [], unknown: true };
	const key = (member: PoolMember) => `${member.model.provider}/${member.model.id}`;
	const authors = new Set(provenance.authors);
	const nonAuthors = members.filter(member => !authors.has(key(member)));
	const excluded = members.filter(member => authors.has(key(member))).map(key);
	const pool = nonAuthors.length > 0 ? nonAuthors : [...members];
	const reviewed = new Set(provenance.reviews);
	const unreviewed = pool.filter(member => !reviewed.has(key(member)));
	const alreadyReviewed = pool.filter(member => reviewed.has(key(member)));
	return { members: [...unreviewed, ...alreadyReviewed], excluded, unknown: false };
}

export type WindowSample = {
	kind: WindowKind;
	usedFraction: number;
	durationMs: number;
	resetsAt?: number;
	exhausted: boolean;
};
/** A pool member after its catalog model reference has been resolved to a concrete model. */
export type PoolMember = {
	id: string;
	model: ModelRef;
	effort?: Effort;
	difficulties?: Difficulty[];
	maxShortUsed?: number;
	minWeeklyHeadroom?: number;
	minMonthlyHeadroom?: number;
	/** Counter used by runtime burst reservations. */
	counter?: string;
	/** Which window receives a burst penalty. */
	penaltyKind?: WindowKind;
};
export type PoolUsage = {
	reports: readonly UsageReport[];
	credentialCounts?: Readonly<Record<string, number>>;
};
export type PoolUsageInput = readonly UsageReport[] | PoolUsage;
export type PoolVerdict = {
	status: "eligible" | "crowded" | "demoted" | "below-pace" | "stale" | "partial-usage" | "no-usage" | "skipped";
	used?: Partial<Record<WindowKind, number>>;
	headroom?: Partial<Record<WindowKind, number>>;
	penalty?: number;
};
export type PoolRank = {
	order: string[];
	skipped: string[];
	demoted: string[];
	verdicts: Record<string, PoolVerdict>;
};

function inferredWindowKind(limit: UsageLimit): WindowKind {
	const descriptor = `${limit.id} ${limit.label} ${limit.window?.id ?? ""} ${limit.window?.label ?? ""}`.toLowerCase();
	if (descriptor.includes("month")) return "monthly";
	if (descriptor.includes("week") || descriptor.includes("7d")) return "weekly";
	return "short";
}

/**
 * Convert provider-specific limits into the three pacing windows. Unknown or
 * incomplete durations remain absent so rankPool can treat them as no usage.
 */
export function windowSamples(report: UsageReport, modelId?: string): WindowSample[] {
	let limits: readonly UsageLimit[] = report.limits;
	if (report.provider === "google-antigravity") {
		limits = scopeAntigravityLimitsForModel(report, modelId ? { modelId } : undefined);
	} else if (report.provider === "xai-oauth") {
		limits = report.limits.filter(limit => limit.id.startsWith("xai-oauth:credits:"));
	} else if (report.provider === "anthropic") {
		limits = report.limits.filter(limit => limit.scope.shared === true);
	}
	return limits.map(limit => {
		const durationMs = limit.window?.durationMs;
		const hasDuration = Number.isFinite(durationMs) && durationMs > 0;
		const kind: WindowKind = hasDuration
			? durationMs <= 24 * 60 * 60 * 1000
				? "short"
				: durationMs <= 8 * 24 * 60 * 60 * 1000
					? "weekly"
					: "monthly"
			: inferredWindowKind(limit);
		const usedFraction = resolveUsedFraction(limit);
		return {
			kind,
			usedFraction: usedFraction ?? Number.NaN,
			durationMs: hasDuration ? durationMs : Number.NaN,
			resetsAt: limit.window?.resetsAt,
			exhausted: limit.status === "exhausted",
		};
	});
}

function usageParts(usage: PoolUsageInput): {
	reports: readonly UsageReport[];
	credentialCounts: Readonly<Record<string, number>>;
} {
	if (Array.isArray(usage)) return { reports: usage, credentialCounts: {} };
	return { reports: usage.reports, credentialCounts: usage.credentialCounts ?? {} };
}

function penaltyValue(penalties: ReadonlyMap<string, number> | Readonly<Record<string, number>>, member: PoolMember): number {
	const keys = [member.counter, member.id, `${member.model.provider}/${member.model.id}`, member.model.provider];
	for (const key of keys) {
		if (key === undefined) continue;
		const value = penalties instanceof Map ? penalties.get(key) : penalties[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
	return 0;
}

function memberIsDemoted(demoted: ReadonlySet<string> | readonly string[], member: PoolMember): boolean {
	const keys = [member.id, `${member.model.provider}/${member.model.id}`];
	return demoted instanceof Set ? keys.some(key => demoted.has(key)) : keys.some(key => demoted.includes(key));
}
function sampleIsValid(sample: WindowSample, nowMs: number, clockSkewMs: number): boolean {
	const resetsAt = sample.resetsAt;
	return (
		Number.isFinite(sample.usedFraction) &&
		sample.usedFraction >= 0 &&
		typeof resetsAt === "number" &&
		Number.isFinite(resetsAt) &&
		resetsAt >= nowMs - clockSkewMs &&
		Number.isFinite(sample.durationMs) &&
		sample.durationMs > 0
	);
}

/**
 * Rank an already-resolved pool without I/O or mutable state.
 * Reports are evaluated per account; the worst valid window wins.
 */
export function rankPool(
	members: readonly PoolMember[],
	usage: PoolUsageInput,
	penalties: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
	demoted: ReadonlySet<string> | readonly string[],
	limits: PoolLimits,
	nowMs: number,
): PoolRank {
	const { reports, credentialCounts } = usageParts(usage);
	const order: string[] = [];
	const skipped: string[] = [];
	const telemetryDemoted: string[] = [];
	const crowded: string[] = [];
	const verdicts: Record<string, PoolVerdict> = {};
	for (const member of members) {
		const memberReports = reports.filter(report => report.provider === member.model.provider);
		const basePenalty = penaltyValue(penalties, member);
		const verdict: PoolVerdict = { status: "no-usage", penalty: basePenalty };
		verdicts[member.id] = verdict;
		if (memberReports.some(report => !Number.isFinite(report.fetchedAt) || nowMs - report.fetchedAt > limits.maxReportAgeMs)) {
			verdict.status = "stale";
			continue;
		}
		const credentialCount = credentialCounts[member.model.provider];
		if (credentialCount !== undefined && credentialCount > memberReports.length) {
			verdict.status = "partial-usage";
			continue;
		}
		// Monthly is optional: it gates only when the provider reports it.
		const requiredKinds = new Set<WindowKind>();
		if (member.maxShortUsed !== undefined) requiredKinds.add("short");
		if (member.minWeeklyHeadroom !== undefined) requiredKinds.add("weekly");
		const pacedKinds = new Set<WindowKind>(requiredKinds);
		if (member.minMonthlyHeadroom !== undefined) pacedKinds.add("monthly");
		const targetPenaltyKind =
			member.penaltyKind ??
			limits.burstPenaltyWindow[member.model.provider] ??
			limits.burstPenaltyWindow["*"];
		const used: Partial<Record<WindowKind, number>> = {};
		const headroom: Partial<Record<WindowKind, number>> = {};
		let invalidRequired = false;
		let shouldSkip = false;
		let hasAnySample = false;
		let weeklySeen = false;
		let weeklyAllFinal = true;
		for (const report of memberReports) {
			const samples = windowSamples(report, member.model.id);
			const validKinds = new Set<WindowKind>();
			const invalidKinds = new Set<WindowKind>();
			const reportedKinds = new Set<WindowKind>();
			for (const sample of samples) {
				if (!pacedKinds.has(sample.kind)) continue;
				hasAnySample = true;
				reportedKinds.add(sample.kind);
				if (!sampleIsValid(sample, nowMs, limits.clockSkewMs)) {
					invalidKinds.add(sample.kind);
					continue;
				}
				validKinds.add(sample.kind);
				const finalWeekly =
					sample.kind === "weekly" && (sample.resetsAt as number) - nowMs <= limits.finalWindowMs;
				if (sample.kind === "weekly") {
					weeklySeen = true;
					if (!finalWeekly) weeklyAllFinal = false;
				}
				const penalized = sample.kind === targetPenaltyKind || finalWeekly;
				const adjustedUsed = sample.usedFraction + (penalized ? basePenalty : 0);
				if (sample.exhausted || adjustedUsed >= limits.skipAt) shouldSkip = true;
				used[sample.kind] = Math.max(used[sample.kind] ?? Number.NEGATIVE_INFINITY, adjustedUsed);
				const elapsed = Math.min(
					1,
					Math.max(0, 1 - ((sample.resetsAt as number) - nowMs) / sample.durationMs),
				);
				const sampleHeadroom = elapsed - adjustedUsed;
				headroom[sample.kind] = Math.min(headroom[sample.kind] ?? Number.POSITIVE_INFINITY, sampleHeadroom);
			}
			if (invalidKinds.size > 0) invalidRequired = true;
			for (const kind of new Set([...requiredKinds, ...reportedKinds])) {
				if (!validKinds.has(kind)) invalidRequired = true;
			}
		}
		if (shouldSkip) {
			verdict.status = "skipped";
			verdict.used = used;
			verdict.headroom = headroom;
			skipped.push(member.id);
			continue;
		}
		if (pacedKinds.size === 0) {
			// No quota gate is configured, so nothing can skip or crowd this member; only demotion applies.
			verdict.used = used;
			verdict.headroom = headroom;
			if (memberIsDemoted(demoted, member)) {
				verdict.status = "demoted";
				telemetryDemoted.push(member.id);
			} else {
				verdict.status = "eligible";
				order.push(member.id);
			}
			continue;
		}
		if (!memberReports.length || !hasAnySample || invalidRequired) {
			verdict.status = "no-usage";
			continue;
		}
		verdict.used = used;
		verdict.headroom = headroom;
		const finalStretch = weeklySeen && weeklyAllFinal;
		const shortCap =
			member.maxShortUsed === undefined
				? undefined
				: finalStretch
					? Math.max(member.maxShortUsed, limits.demoteAt)
					: member.maxShortUsed;
		const shortOkay = shortCap === undefined || (used.short !== undefined && used.short < shortCap);
		const headroomTolerance = 1e-9;
		const weeklyOkay =
			member.minWeeklyHeadroom === undefined ||
			finalStretch ||
			(headroom.weekly !== undefined && headroom.weekly + headroomTolerance >= member.minWeeklyHeadroom);
		const monthlyOkay =
			member.minMonthlyHeadroom === undefined ||
			(headroom.monthly === undefined || headroom.monthly + headroomTolerance >= member.minMonthlyHeadroom);
		if (!shortOkay || !weeklyOkay || !monthlyOkay) {
			verdict.status = "below-pace";
			continue;
		}
		const isCrowded = Object.entries(used).some(
			([kind, value]) => value !== undefined && value >= limits.demoteAt && !(finalStretch && kind === "weekly"),
		);
		if (memberIsDemoted(demoted, member)) {
			verdict.status = "demoted";
			telemetryDemoted.push(member.id);
		} else if (isCrowded) {
			verdict.status = "crowded";
			crowded.push(member.id);
		} else {
			verdict.status = "eligible";
			order.push(member.id);
		}
	}
	order.push(...crowded);
	return { order, skipped, demoted: telemetryDemoted, verdicts };
}

function choiceAnswer(answer: unknown, ids: readonly string[]): { choice: string; confidence: number } | undefined {
	if (
		!record(answer) ||
		answer.type !== "choice" ||
		!text(answer.choice) ||
		!ids.includes(answer.choice) ||
		!unit(answer.confidence) ||
		!record(answer.probabilities) ||
		Object.keys(answer.probabilities).length !== ids.length
	)
		return undefined;
	let total = 0;
	let maximum = 0;
	for (const id of ids) {
		const probability = answer.probabilities[id];
		if (!unit(probability)) return undefined;
		total += probability;
		maximum = Math.max(maximum, probability);
	}
	if (Math.abs(total - 1) > 0.01 || answer.probabilities[answer.choice] !== maximum) return undefined;
	return { choice: answer.choice, confidence: answer.confidence };
}

function scoreAnswer(answer: unknown): { level: number; confidence: number } | undefined {
	if (
		!record(answer) ||
		answer.type !== "score" ||
		!unit(answer.confidence) ||
		typeof answer.score !== "number" ||
		!Number.isFinite(answer.score) ||
		answer.score < 0 ||
		answer.score > DIFFICULTY_LEVELS - 1
	)
		return undefined;
	return { level: Math.round(answer.score), confidence: answer.confidence };
}

/** One bounded Jev call. Bounds even an evaluator that ignores cancellation. */
async function ask(
	request: ChoiceRequest,
	catalog: Catalog,
	evaluate: Evaluate,
	signal: AbortSignal | undefined,
): Promise<{ answers: Record<string, unknown>; usage?: UsageSummary }> {
	if (new TextEncoder().encode(JSON.stringify({ ...request, model: catalog.jevModel })).length > catalog.maxInputBytes)
		throw new InputBudgetError();
	const timeout = AbortSignal.timeout(catalog.timeoutMs);
	const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const { promise: abort, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(bounded.reason);
	bounded.addEventListener("abort", onAbort, { once: true });
	if (bounded.aborted) onAbort();
	try {
		const response = await Promise.race([evaluate(request, bounded), abort]);
		if (!record(response) || !record(response.answers)) throw new InvalidResponseError();
		const usage = summarizeUsage(response.usage);
		return { answers: response.answers, ...(usage ? { usage } : {}) };
	} catch (error) {
		if (timeout.aborted && !signal?.aborted) throw new RoutingTimeoutError();
		throw error;
	} finally {
		bounded.removeEventListener("abort", onAbort);
	}
}

/**
 * Ask Jev to classify one routed spawn: choose a task type when several compete, then rate
 * difficulty. Caller cancellation rethrows; every other failure returns a baseline decision.
 */
export async function choose(
	state: string,
	slots: readonly Slot[],
	rateDifficulty: boolean,
	catalog: Catalog,
	evaluate: Evaluate,
	signal?: AbortSignal,
): Promise<Decision> {
	signal?.throwIfAborted();
	const routeSlots = slots.length > 1;
	if (!routeSlots && !rateDifficulty) return { source: "baseline", reason: "nothing-to-classify" };
	const questions: ChoiceRequest["questions"] = {};
	if (routeSlots) {
		questions.route = {
			type: "choice",
			instructions: catalog.jevInstructions.route,
			criteria: Object.fromEntries(slots.map(slot => [slot.id, slot.description])),
		};
	}
	if (rateDifficulty) {
		questions.difficulty = {
			type: "score",
			instructions: catalog.jevInstructions.difficulty,
			criteria: DIFFICULTY_NAMES.map(name => `${name}: ${catalog.difficulty[name]}`),
		};
	}
	const request: ChoiceRequest = { state, questions };
	try {
		const { answers, usage } = await ask(request, catalog, evaluate, signal);
		const withUsage = usage ? { usage } : {};
		let choice: string | undefined;
		let confidence: number | undefined;
		if (routeSlots) {
			const route = choiceAnswer(
				answers.route,
				slots.map(slot => slot.id),
			);
			if (!route) throw new InvalidResponseError();
			if (route.confidence < catalog.minConfidence) {
				return {
					source: "baseline",
					leading: route.choice,
					confidence: route.confidence,
					reason: "uncertain-choice",
					...withUsage,
				};
			}
			choice = route.choice;
			confidence = route.confidence;
		}
		const rated = rateDifficulty ? scoreAnswer(answers.difficulty) : undefined;
		const difficulty = rated && rated.confidence >= catalog.minConfidence ? DIFFICULTY_NAMES[rated.level] : undefined;
		const uncertainDifficulty = rateDifficulty && difficulty === undefined;
		if (uncertainDifficulty) {
			if (!rated) throw new InvalidResponseError();
			// A confident task-type choice survives an uncertain rating; the caller uses ordinary difficulty.
			if (choice === undefined)
				return { source: "baseline", confidence: rated.confidence, reason: "uncertain-difficulty", ...withUsage };
		}
		return {
			source: "jev",
			...(choice !== undefined ? { choice } : {}),
			...(difficulty !== undefined ? { difficulty } : {}),
			...(confidence !== undefined ? { confidence } : {}),
			reason: uncertainDifficulty ? "uncertain-difficulty" : "classified",
			...withUsage,
		};
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof InputBudgetError) return { source: "baseline", reason: "input-budget-exceeded" };
		return { source: "baseline", reason: safeFailureCategory(error) };
	}
}

export async function evaluatePlanningReadiness(
	task: string,
	catalog: Catalog,
	evaluate: Evaluate,
	signal?: AbortSignal,
): Promise<PlanningReadiness> {
	const fallback = (reason: string, confidence = 0, usage?: UsageSummary): PlanningReadiness => ({
		route: "discuss-with-user",
		confidence,
		reason,
		...(usage ? { usage } : {}),
	});
	if (signal?.aborted) return fallback("readiness-aborted");
	const routes: PlanningRoute[] = ["autonomous-plan", "discuss-with-user"];
	try {
		const { answers, usage } = await ask(
			{
				state: task,
				questions: {
					route: {
						type: "choice",
						instructions: catalog.planningReadiness.instructions,
						criteria: catalog.planningReadiness.routes,
					},
				},
			},
			catalog,
			evaluate,
			signal,
		);
		const answer = choiceAnswer(answers.route, routes);
		if (!answer) throw new InvalidResponseError();
		if (answer.confidence < catalog.minConfidence) return fallback("readiness-low-confidence", answer.confidence, usage);
		const route = answer.choice as PlanningRoute;
		return {
			route,
			confidence: answer.confidence,
			reason:
				route === "autonomous-plan"
					? "requirements, target files, acceptance criteria, and technical constraints are concrete and settled"
					: "requirements are open-ended, under-specified, or involve unresolved product or architectural trade-offs",
			...(usage ? { usage } : {}),
		};
	} catch (error) {
		if (signal?.aborted) return fallback("readiness-aborted");
		if (error instanceof InputBudgetError) return fallback("readiness-input-budget-exceeded");
		return fallback(`readiness-${safeFailureCategory(error)}`);
	}
}
