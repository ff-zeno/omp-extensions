// Subagent-only rules, guidance lines and leaf tool sets, attached in the child's `before_agent_start`.
// Data lives in guidance.json; IAA_GUIDANCE_OVERRIDES switches entries per run for the eval.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const GUIDANCE_DECISION_ENTRY = "intelligent-auto-agents-decision";
const BLOCK_OPEN = "<subagent-rules>";
const LINES_OPEN = "<worker-guidance>";
const LINES_CLOSE = "</worker-guidance>";
// Same header grammar session-persona reads, so a `# Mode: orchestrate` child resolves alike in both plugins.
const MODE_HEADER = /(?:^|\n)\s*#?\s*(?:mode|persona):\s*(normal|orchestrate|brute)\b/i;
const PERSONA_REGISTRY = Symbol.for("omp.session-persona.v1");
const SPAWN_CHAIN_TTL_MS = 10 * 60 * 1000;

type Layer = "all" | "family" | "model" | "role";
const LAYER_ORDER: readonly Layer[] = ["all", "family", "model", "role"];

/** A family or model scope may add `roles`; then the model and the role must both match. */
export type LineScope =
	| { layer: "all" }
	| { layer: "family"; family: string; roles?: string[] }
	| { layer: "model"; models: string[]; roles?: string[] }
	| { layer: "role"; roles: string[] };

export type GuidanceLine = {
	id: string;
	enabled: boolean;
	scope: LineScope;
	hashAnchoredOnly: boolean;
	text: string;
	evidence: string;
};

export type BlockRow = { id?: string; text: string };

export type ToolSet = { id: string; enabled: boolean; roles: string[]; remove: string[]; evidence: string };

export type Guidance = {
	overridesEnv: string;
	block: { id: string; enabled: boolean; switches: Record<string, boolean>; rows: BlockRow[] };
	families: Record<string, string[]>;
	lines: GuidanceLine[];
	roles: Record<string, string>;
	toolSets: ToolSet[];
	/** Every way a child can start another agent, and the tools each needs. */
	spawnRoutes: { id: string; tools: string[] }[];
	/** Override IDs that name nothing in the data; reported, never fatal. */
	unknownOverrides: string[];
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function stringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(nonEmptyText);
}

function fail(message: string): never {
	throw new Error(`guidance.json: ${message}`);
}

function parseScope(id: string, value: unknown, families: Record<string, string[]>): LineScope {
	if (!record(value)) fail(`${id}.scope must be an object`);
	const kinds = ["all", "family", "models", "roles"].filter(key => key in value);
	const modelWithRoles = kinds.length === 2 && kinds[1] === "roles" && (kinds[0] === "family" || kinds[0] === "models");
	if (kinds.length !== 1 && !modelWithRoles)
		fail(`${id}.scope needs exactly one of all, family, models, roles, or family or models with roles`);
	if (modelWithRoles && !stringList(value.roles)) fail(`${id}.scope roles must be a list of role names`);
	const roles = modelWithRoles && stringList(value.roles) ? { roles: value.roles } : {};
	if (value.all === true) return { layer: "all" };
	if (nonEmptyText(value.family)) {
		if (!families[value.family]) fail(`${id}.scope names unknown family ${value.family}`);
		return { layer: "family", family: value.family, ...roles };
	}
	if (stringList(value.models)) return { layer: "model", models: value.models, ...roles };
	if (stringList(value.roles)) return { layer: "role", roles: value.roles };
	return fail(`${id}.scope is malformed`);
}

function parseOverrides(env: string | undefined): Record<string, boolean> {
	if (env === undefined || env.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(env);
	} catch (error) {
		fail(`override JSON does not parse: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!record(parsed)) fail("overrides must be a JSON object of ID to boolean");
	for (const [id, on] of Object.entries(parsed)) {
		if (typeof on !== "boolean") fail(`override ${id} must be true or false`);
	}
	return parsed as Record<string, boolean>;
}

/** Validate guidance data and apply the per-run overrides. Throws on any malformed entry. */
export function parseGuidance(raw: unknown, overridesJson: string | undefined): Guidance {
	if (!record(raw)) fail("root must be an object");
	if (!nonEmptyText(raw.overridesEnv)) fail("overridesEnv is required");
	const overrides = parseOverrides(overridesJson);
	const known = new Set<string>();
	const switched = (id: string, enabled: unknown): boolean => {
		if (typeof enabled !== "boolean") fail(`${id}.enabled must be a boolean`);
		if (known.has(id)) fail(`duplicate ID ${id}`);
		known.add(id);
		return overrides[id] ?? enabled;
	};
	const requireEvidence = (id: string, value: Record<string, unknown>): string => {
		if (!nonEmptyText(value.evidence)) fail(`${id} has no evidence`);
		return value.evidence;
	};

	if (!record(raw.families)) fail("families must be an object");
	const families: Record<string, string[]> = {};
	for (const [name, patterns] of Object.entries(raw.families)) {
		if (!stringList(patterns)) fail(`family ${name} needs model patterns`);
		families[name] = patterns.map(pattern => pattern.toLowerCase());
	}

	const block = raw.block;
	if (!record(block) || !nonEmptyText(block.id) || !Array.isArray(block.text) || !record(block.switches))
		fail("block needs id, switches and text");
	requireEvidence(block.id, block);
	const blockEnabled = switched(block.id, block.enabled);
	const switches: Record<string, boolean> = {};
	for (const [id, entry] of Object.entries(block.switches)) {
		if (!record(entry)) fail(`block switch ${id} must be an object`);
		requireEvidence(id, entry);
		switches[id] = switched(id, entry.enabled);
	}
	const rows: BlockRow[] = block.text.map((row, index) => {
		if (typeof row === "string") return { text: row };
		if (!record(row) || !nonEmptyText(row.id) || !nonEmptyText(row.text)) fail(`block row ${index} is malformed`);
		if (!(row.id in switches)) fail(`block row ${index} names unknown switch ${row.id}`);
		return { id: row.id, text: row.text };
	});
	if (rows[0]?.text !== BLOCK_OPEN) fail(`block must open with ${BLOCK_OPEN}`);

	if (!record(raw.lines)) fail("lines must be an object");
	const lines: GuidanceLine[] = Object.entries(raw.lines).map(([id, entry]) => {
		if (!record(entry) || !nonEmptyText(entry.text)) fail(`line ${id} needs text`);
		const evidence = requireEvidence(id, entry);
		const scope = parseScope(id, entry.scope, families);
		const editFormat = record(entry.scope) ? entry.scope.editFormat : undefined;
		if (editFormat !== undefined && editFormat !== "hash-anchored") fail(`${id}.scope.editFormat is unknown`);
		return {
			id,
			enabled: switched(id, entry.enabled),
			scope,
			hashAnchoredOnly: editFormat === "hash-anchored",
			text: entry.text,
			evidence,
		};
	});

	if (!record(raw.roles)) fail("roles must be an object");
	const roles: Record<string, string> = {};
	for (const [agent, role] of Object.entries(raw.roles)) {
		if (!nonEmptyText(role)) fail(`role for agent ${agent} must be text`);
		roles[agent.toLowerCase()] = role;
	}

	if (!record(raw.toolSets)) fail("toolSets must be an object");
	const toolSets: ToolSet[] = Object.entries(raw.toolSets).map(([id, entry]) => {
		if (!record(entry) || !stringList(entry.roles) || !stringList(entry.remove))
			fail(`tool set ${id} needs roles and remove`);
		return { id, enabled: switched(id, entry.enabled), roles: entry.roles, remove: entry.remove, evidence: requireEvidence(id, entry) };
	});

	if (!record(raw.spawnRoutes)) fail("spawnRoutes must be an object");
	const spawnRoutes = Object.entries(raw.spawnRoutes).map(([id, entry]) => {
		if (!record(entry) || !stringList(entry.tools)) fail(`spawn route ${id} needs tools`);
		if (!nonEmptyText(entry.closedBy) && !nonEmptyText(entry.knownOpen))
			fail(`spawn route ${id} needs closedBy or a knownOpen reason`);
		return { id, tools: entry.tools };
	});

	return {
		overridesEnv: raw.overridesEnv,
		block: { id: block.id, enabled: blockEnabled, switches, rows },
		families,
		lines,
		roles,
		toolSets,
		spawnRoutes,
		unknownOverrides: Object.keys(overrides).filter(id => !known.has(id)),
	};
}

export function matchesPattern(pattern: string, model: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(model);
}

/** `provider/id`, lowercased, with any `:effort` suffix dropped. */
export function modelKey(selector: string): string {
	const trimmed = selector.trim().toLowerCase();
	const slash = trimmed.indexOf("/");
	const colon = trimmed.indexOf(":", slash + 1);
	return colon < 0 ? trimmed : trimmed.slice(0, colon);
}

export type Role = { name: string; source: "agent" | "mode" } | undefined;

export type SelectionInput = {
	role: Role;
	/** Model the request goes to. */
	model: string | undefined;
	/**
	 * Every model the child can fall back to, including `model`.
	 * The hook does not rerun after a fallback, so lines keyed on a family or model must hold for all of them.
	 */
	chain: string[];
	hashAnchoredEdit: boolean;
};

export type Selection = {
	block: boolean;
	blockSwitches: string[];
	lines: string[];
	toolSet: ToolSet | undefined;
	/** False when the chain leaves a family or model scope, so only shared and role lines attach. */
	modelScopedAllowed: boolean;
};

/** Coarse model class: the first word of the model ID ("claude-haiku-5-5" -> "claude"). */
function modelClass(model: string): string {
	return (model.split("/").at(-1) ?? model).toLowerCase().split(/[-_.:]/)[0];
}

export function selectGuidance(guidance: Guidance, input: SelectionInput): Selection {
	const chain = input.chain.map(modelKey);
	const inScope = (patterns: readonly string[]): boolean =>
		chain.length > 0 && chain.every(model => patterns.some(pattern => matchesPattern(pattern.toLowerCase(), model)));
	const lineApplies = (line: GuidanceLine): boolean => {
		if (!line.enabled) return false;
		// The edit tool is detected once, for the first model. OMP picks the edit format by model class
		// (utils/edit-mode.ts resolveEditMode), so a fallback to another class can change it while the
		// line stays in the prompt. A known chain must therefore stay within one model class.
		if (line.hashAnchoredOnly && (!input.hashAnchoredEdit || new Set(chain.map(modelClass)).size > 1)) return false;
		const pairedRoles = line.scope.layer === "family" || line.scope.layer === "model" ? line.scope.roles : undefined;
		if (pairedRoles !== undefined && !(input.role !== undefined && pairedRoles.includes(input.role.name))) return false;
		switch (line.scope.layer) {
			case "all":
				return true;
			case "family":
				return inScope(guidance.families[line.scope.family]);
			case "model":
				return inScope(line.scope.models);
			case "role":
				return input.role !== undefined && line.scope.roles.includes(input.role.name);
		}
	};
	const lines = guidance.lines
		.filter(lineApplies)
		.sort((a, b) => LAYER_ORDER.indexOf(a.scope.layer) - LAYER_ORDER.indexOf(b.scope.layer))
		.map(line => line.id);
	const families = Object.values(guidance.families);
	const toolSet = input.role
		? guidance.toolSets.find(set => set.enabled && set.roles.includes(input.role?.name ?? ""))
		: undefined;
	return {
		block: guidance.block.enabled,
		blockSwitches: guidance.block.enabled
			? Object.entries(guidance.block.switches)
					.filter(([, on]) => on)
					.map(([id]) => id)
			: [],
		lines,
		toolSet,
		modelScopedAllowed: families.some(inScope),
	};
}

export function renderBlock(guidance: Guidance): string {
	return guidance.block.rows
		.filter(row => row.id === undefined || guidance.block.switches[row.id])
		.map(row => row.text)
		.join("\n");
}

function renderLines(guidance: Guidance, ids: readonly string[]): string {
	const byId = new Map(guidance.lines.map(line => [line.id, line.text]));
	return [LINES_OPEN, ...ids.map(id => `- ${byId.get(id)}`), LINES_CLOSE].join("\n");
}

/**
 * Rebuild the prompt from blocks this module did not add, then insert ours, so a repeated
 * preparation yields the same prompt. The rules go after `<project-context>`, before the agent body.
 */
export function composeSystemPrompt(base: readonly string[], block: string | undefined, lines: string | undefined): string[] {
	const kept = base.filter(entry => {
		const head = entry.trimStart();
		return !head.startsWith(BLOCK_OPEN) && !head.startsWith(LINES_OPEN);
	});
	if (block) {
		const contextIndex = kept.findIndex(entry => entry.includes("</project-context>"));
		kept.splice(contextIndex < 0 ? kept.length : contextIndex + 1, 0, block);
	}
	if (lines) kept.push(lines);
	return kept;
}

/** Tools left after a set's removals; never adds a name, so the result is a subset of what the agent declared. */
export function intersectTools(active: readonly string[], set: ToolSet | undefined): string[] {
	if (!set) return [...active];
	const removed = new Set(set.remove);
	return active.filter(name => !removed.has(name));
}

type SpawnChain = { models: string[]; at: number };
const spawnChains = new Map<string, SpawnChain>();

/**
 * Called by the parent's routing hook with the model list it hands OMP. OMP puts every later
 * entry in the child's retry chain (task/executor.ts installSubagentRetryFallbackChain).
 */
export function rememberSpawnChain(parentId: string, spawnKey: string, models: readonly string[], now = Date.now()): void {
	for (const [key, entry] of spawnChains) if (now - entry.at > SPAWN_CHAIN_TTL_MS) spawnChains.delete(key);
	spawnChains.set(`${parentId}:${spawnKey}`, { models: models.map(modelKey), at: now });
}

function takeSpawnChain(ctx: ExtensionContext): string[] | undefined {
	if (ctx.agent.parentId === undefined) return undefined;
	const key = `${ctx.agent.parentId}:${ctx.agent.id}`;
	const entry = spawnChains.get(key);
	spawnChains.delete(key);
	return entry?.models;
}

/**
 * session-persona settles a child's mode on first read and caches it, so this returns the same
 * answer whether its `before_agent_start` handler ran before or after ours.
 */
function personaMode(ctx: ExtensionContext): string | undefined {
	const registry = (globalThis as Record<symbol, unknown>)[PERSONA_REGISTRY];
	if (!record(registry) || typeof registry.resolveChildMode !== "function") return undefined;
	const mode: unknown = registry.resolveChildMode(ctx);
	return typeof mode === "string" ? mode : undefined;
}

export function resolveRole(guidance: Guidance, agentName: string, mode: string | undefined): Role {
	if (mode === "orchestrate") return { name: "orchestrator", source: "mode" };
	const name = guidance.roles[agentName.toLowerCase()];
	return name ? { name, source: "agent" } : undefined;
}

type ChildState = { role: Role; routedChain: string[] | undefined; recorded?: string };
const children = new Map<string, ChildState>();

export function resetGuidanceStateForTests(): void {
	spawnChains.clear();
	children.clear();
}


function hashAnchoredEdit(pi: ExtensionAPI, active: readonly string[]): boolean {
	if (!active.includes("edit")) return false;
	const edit = pi.getAllTools().find(tool => tool.name === "edit");
	return edit !== undefined && /\bhashline\b/i.test(edit.description);
}

export function registerSubagentGuidance(pi: ExtensionAPI, guidance: Guidance): void {
	if (guidance.unknownOverrides.length > 0)
		pi.logger.warn(`${guidance.overridesEnv} names unknown IDs: ${guidance.unknownOverrides.join(", ")}`);
	pi.on("before_agent_start", async (event, ctx) => {
		// Task subagents only: `/tan` clones report name `sub` and keep the main session's context.
		if (event.reason === "revive" || ctx.agent.kind !== "sub" || ctx.agent.name === "sub") return;
		const key = ctx.sessionManager.getSessionId();
		let state = children.get(key);
		if (!state) {
			// The header is read only when session-persona is not installed.
			const mode = personaMode(ctx) ?? MODE_HEADER.exec(event.prompt)?.[1]?.toLowerCase();
			state = {
				role: resolveRole(guidance, ctx.agent.name, mode),
				routedChain: takeSpawnChain(ctx),
			};
			children.set(key, state);
		}

		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		// No recorded list (the spawn hook did not fire, e.g. `routing: "off"`) means an unknown chain: shared lines only.
		const chain = state.routedChain
			? [...new Set([...(current ? [modelKey(current)] : []), ...state.routedChain])]
			: [];
		const active = pi.getActiveTools();
		const selection = selectGuidance(guidance, {
			role: state.role,
			model: current,
			chain,
			hashAnchoredEdit: hashAnchoredEdit(pi, active),
		});

		const nextTools = intersectTools(active, selection.toolSet);
		if (nextTools.length !== active.length) await pi.setActiveTools(nextTools);
		const removed = active.filter(name => !nextTools.includes(name));

		const entry = {
			source: "guidance",
			agent: ctx.agent.name,
			role: state.role?.name ?? null,
			roleSource: state.role?.source ?? null,
			keyedOn: current ?? null,
			chain,
			block: selection.block,
			blockSwitches: selection.blockSwitches,
			lines: selection.lines,
			toolSet: selection.toolSet ? { id: selection.toolSet.id, removed } : null,
			// Routes whose tools this child still has; OMP's spawn policy and depth limit may refuse them later.
			openSpawnRoutes: guidance.spawnRoutes
				.filter(route => route.tools.every(tool => nextTools.includes(tool)))
				.map(route => route.id),
		};
		const fingerprint = JSON.stringify({ ...entry, toolSet: selection.toolSet?.id ?? null });
		if (state.recorded !== fingerprint) {
			state.recorded = fingerprint;
			pi.appendEntry(GUIDANCE_DECISION_ENTRY, entry);
		}

		return {
			systemPrompt: composeSystemPrompt(
				event.systemPrompt,
				selection.block ? renderBlock(guidance) : undefined,
				selection.lines.length > 0 ? renderLines(guidance, selection.lines) : undefined,
			),
		};
	});
	pi.on("session_shutdown", (_event, ctx) => {
		children.delete(ctx.sessionManager.getSessionId());
	});
}
