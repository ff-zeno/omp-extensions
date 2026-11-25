import { beforeEach, describe, expect, test } from "bun:test";
import guidanceData from "./guidance.json";
import { parseGuidance, registerSubagentGuidance, rememberSpawnChain, resetGuidanceStateForTests } from "./guidance";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

const BASE_PROMPT = ["<system-conventions>constitution</system-conventions>", "<project-context>repo</project-context>", "agent body"];
const LEAF_TOOLS = ["read", "edit", "write", "grep", "bash", "eval", "task", "wait"];
const HASHLINE_EDIT = "Hashline patches existing files.";
const REPO_READ = "read the repository AGENTS.md sections";
// Production ships every switch on (operator, 2026-11-25). Tests that pass overrides start from
// every switch off so each case names exactly the entries it exercises.
const TREATMENT = { block: true, G1: true, R1: true, G8: true };
const ALL_OFF: Record<string, boolean> = Object.fromEntries(
	["block", "G1", "R1", ...Object.keys(guidanceData.lines), ...Object.keys(guidanceData.toolSets)].map(id => [id, false]),
);

function harness(overrides?: Record<string, boolean>, tools = LEAF_TOOLS, editDescription = HASHLINE_EDIT, isolate = true) {
	const handlers = new Map<string, Handler[]>();
	const entries: Record<string, unknown>[] = [];
	const warnings: string[] = [];
	let active = [...tools];
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getActiveTools: () => [...active],
		setActiveTools: async (names: string[]) => {
			active = [...names];
		},
		getAllTools: () => tools.map(name => ({ name, description: name === "edit" ? editDescription : name })),
		appendEntry: (_type: string, data: Record<string, unknown>) => entries.push(data),
		logger: { warn: (message: string) => warnings.push(message) },
	};
	const layered = overrides && isolate ? { ...ALL_OFF, ...overrides } : overrides;
	const guidance = parseGuidance(guidanceData, layered ? JSON.stringify(layered) : undefined);
	registerSubagentGuidance(pi as never, guidance);
	const start = async (
		agent: { kind: "main" | "sub"; name: string; id?: string; parentId?: string },
		model = { provider: "anthropic", id: "claude-haiku-5-5" },
		prompt = "Do the assigned work.",
	) => {
		const ctx = {
			agent: { id: agent.id ?? "0-Worker", depth: agent.kind === "sub" ? 1 : 0, parentId: agent.parentId ?? "Main", ...agent },
			model,
			sessionManager: { getSessionId: () => `session-${agent.id ?? "0-Worker"}` },
		};
		let systemPrompt = [...BASE_PROMPT];
		for (const handler of handlers.get("before_agent_start") ?? []) {
			const result = (await handler({ type: "before_agent_start", reason: "prompt", prompt, systemPrompt }, ctx)) as
				| { systemPrompt?: string[] }
				| undefined;
			if (result?.systemPrompt) systemPrompt = result.systemPrompt;
		}
		return systemPrompt;
	};
	return { start, entries, warnings, tools: () => active };
}

const PERSONA_REGISTRY = Symbol.for("omp.session-persona.v1");
const globals = globalThis as Record<symbol, unknown>;

beforeEach(() => {
	resetGuidanceStateForTests();
	delete globals[PERSONA_REGISTRY];
});

describe("subagent guidance", () => {
	test("a main session gets no block, no lines and keeps its tools", async () => {
		const h = harness({ ...TREATMENT, G13: true });
		const prompt = await h.start({ kind: "main", name: "main", id: "Main" });
		expect(prompt).toEqual(BASE_PROMPT);
		expect(h.tools()).toEqual(LEAF_TOOLS);
		expect(h.entries).toEqual([]);
	});

	test("a leaf gets the block after project context, its lines, and no spawn tools", async () => {
		const h = harness({ ...TREATMENT, G13: true });
		const prompt = await h.start({ kind: "sub", name: "task" });
		expect(prompt[2].startsWith("<subagent-rules>")).toBe(true);
		expect(prompt[2]).toContain("Your assigned checkout is the source of project state.");
		expect(prompt[2]).toContain(REPO_READ);
		expect(prompt[3]).toBe("agent body");
		expect(prompt.at(-1)).toContain("issue them in one turn");
		expect(h.tools()).toEqual(["read", "edit", "write", "grep", "bash", "eval"]);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]).toMatchObject({
			source: "guidance",
			role: "implementer",
			keyedOn: "anthropic/claude-haiku-5-5",
			block: true,
			lines: ["G13"],
			toolSet: { id: "G8", removed: ["task", "wait"] },
			openSpawnRoutes: ["eval.agent", "eval.workpool"],
		});
	});

	test("with no override variable a leaf child gets the block, its lines and no spawn tools", async () => {
		const h = harness();
		const prompt = await h.start({ kind: "sub", name: "task" });
		expect(prompt[2].startsWith("<subagent-rules>")).toBe(true);
		expect(prompt[2]).toContain(REPO_READ);
		expect(h.tools()).toEqual(["read", "edit", "write", "grep", "bash", "eval"]);
		expect(h.entries[0]).toMatchObject({
			block: true,
			blockSwitches: ["G1", "R1"],
			toolSet: { id: "G8", removed: ["task", "wait"] },
			openSpawnRoutes: ["eval.agent", "eval.workpool"],
		});
		expect(h.entries[0]).toMatchObject({ lines: expect.arrayContaining(["G18"]) });
		expect(h.entries[0]).not.toMatchObject({ lines: expect.arrayContaining(["G13"]) });
		expect(h.entries[0]).not.toMatchObject({ lines: expect.arrayContaining(["G17"]) });
	});

	test("a planner keeps task and an orchestrate-mode task child keeps task", async () => {
		const planner = harness(TREATMENT);
		await planner.start({ kind: "sub", name: "plan" });
		expect(planner.tools()).toContain("task");
		expect(planner.entries[0]).toMatchObject({ role: "planner", toolSet: null });

		const orchestrated = harness(TREATMENT);
		await orchestrated.start({ kind: "sub", name: "task", id: "3-Orchestrator" }, undefined, "# Mode: orchestrate\nRun the plan.");
		expect(orchestrated.tools()).toContain("task");
		expect(orchestrated.entries[0]).toMatchObject({ role: "orchestrator", roleSource: "mode" });
	});

	test("a task child that session-persona resolved to orchestrate keeps task without a header", async () => {
		globals[PERSONA_REGISTRY] = { resolveChildMode: () => "orchestrate" };
		const h = harness(TREATMENT);
		await h.start({ kind: "sub", name: "task", id: "6-ModeField" }, undefined, "Run the plan.");
		expect(h.tools()).toContain("task");
		expect(h.entries[0]).toMatchObject({ role: "orchestrator", roleSource: "mode" });
	});

	test("a set never adds a tool the agent did not declare", async () => {
		const h = harness(TREATMENT, ["read", "grep", "bash"]);
		await h.start({ kind: "sub", name: "git" });
		expect(h.tools()).toEqual(["read", "grep", "bash"]);
		expect(h.entries[0]).toMatchObject({ openSpawnRoutes: [] });
	});

	test("a cross-family fallback chain gets shared lines only", async () => {
		const sameFamily = harness({ ...TREATMENT, G13: true, G29: true });
		rememberSpawnChain("Main", "1-Same", ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5:high"]);
		const kept = await sameFamily.start({ kind: "sub", name: "task", id: "1-Same" });
		expect(kept.at(-1)).toContain("If a tool rejects your call");
		expect(sameFamily.entries[0]).toMatchObject({ lines: ["G13", "G29"] });

		const crossing = harness({ ...TREATMENT, G13: true, G29: true });
		rememberSpawnChain("Main", "2-Cross", ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6.1-terra:low"]);
		const shared = await crossing.start({ kind: "sub", name: "task", id: "2-Cross" });
		expect(shared.at(-1)).not.toContain("If a tool rejects your call");
		expect(crossing.entries[0]).toMatchObject({
			lines: ["G13"],
			chain: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6.1-terra"],
		});
	});

	test("a child whose chain was never recorded gets shared lines only", async () => {
		const h = harness({ G13: true, G29: true });
		await h.start({ kind: "sub", name: "task", id: "4-Unrecorded" });
		expect(h.entries[0]).toMatchObject({ lines: ["G13"], chain: [] });
	});

	test("overrides switch a block line and an efficiency line", async () => {
		const h = harness({ ...TREATMENT, R1: false, G30: true });
		rememberSpawnChain("Main", "5-Grok", ["xai-oauth/grok-4.6"]);
		const prompt = await h.start({ kind: "sub", name: "task", id: "5-Grok" }, { provider: "xai-oauth", id: "grok-4.6" });
		const block = prompt.find(entry => entry.startsWith("<subagent-rules>"));
		expect(block).not.toContain(REPO_READ);
		expect(prompt.at(-1)).toContain("A read range is `start-end`");
		expect(h.entries[0]).toMatchObject({ blockSwitches: ["G1"], lines: ["G30"] });
	});

	test("turning off the block and the leaf set leaves the child untouched", async () => {
		const h = harness({ block: false, G8: false }, LEAF_TOOLS, HASHLINE_EDIT, false);
		const prompt = await h.start({ kind: "sub", name: "task" });
		expect(prompt[2]).toBe("agent body");
		expect(prompt.some(entry => entry.startsWith("<subagent-rules>"))).toBe(false);
		expect(h.tools()).toEqual(LEAF_TOOLS);
		expect(h.entries[0]).toMatchObject({ block: false, toolSet: null });
	});

	test("an override to false switches one line off against the shipped defaults", async () => {
		const on = harness();
		await on.start({ kind: "sub", name: "task" });
		expect(on.entries[0]).toMatchObject({ lines: expect.arrayContaining(["G18"]) });
		resetGuidanceStateForTests();
		const off = harness({ G18: false }, LEAF_TOOLS, HASHLINE_EDIT, false);
		await off.start({ kind: "sub", name: "task" });
		expect(off.entries[0]).not.toMatchObject({ lines: expect.arrayContaining(["G18"]) });
		expect(off.entries[0]).toMatchObject({ block: true, toolSet: { id: "G8" } });
	});

	test("an override to true switches a shipped-off line on", async () => {
		const h = harness({ G13: true }, LEAF_TOOLS, HASHLINE_EDIT, false);
		const prompt = await h.start({ kind: "sub", name: "task" });
		expect(prompt.at(-1)).toContain("issue them in one turn");
		expect(h.entries[0]).toMatchObject({ lines: expect.arrayContaining(["G13"]) });
	});

	test("G18 attaches only with the hash-anchored edit tool", async () => {
		const hashline = harness({ G18: true });
		await hashline.start({ kind: "sub", name: "task" });
		expect(hashline.entries[0]).toMatchObject({ lines: ["G18"] });

		const replace = harness({ G18: true }, LEAF_TOOLS, "Replace old_string with new_string.");
		await replace.start({ kind: "sub", name: "task" });
		expect(replace.entries[0]).toMatchObject({ lines: [] });
	});

	test("G18 does not attach when the child can fall back to another model", async () => {
		const h = harness({ G18: true });
		rememberSpawnChain("Main", "3-Fallback", ["anthropic/claude-haiku-5-5", "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017:low"]);
		await h.start({ kind: "sub", name: "task", id: "3-Fallback" });
		expect(h.entries[0]).toMatchObject({ lines: [] });
	});

	test("G18 still attaches for a routed chain that stays in one model class", async () => {
		const h = harness({ G18: true });
		rememberSpawnChain("Main", "4-Same", ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5:high"]);
		await h.start({ kind: "sub", name: "task", id: "4-Same" });
		expect(h.entries[0]).toMatchObject({ lines: ["G18"] });
	});

	test("G32 ships on for DeepSeek and does not attach to another model", async () => {
		const deepseek = harness();
		rememberSpawnChain("Main", "7-DeepSeek", ["deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017:low"]);
		const prompt = await deepseek.start({ kind: "sub", name: "task", id: "7-DeepSeek" }, { provider: "deepinfra", id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" });
		expect(prompt.at(-1)).toContain("sends all of its independent calls together, in that one reply");
		expect(deepseek.entries[0]).toMatchObject({ lines: expect.arrayContaining(["G32"]) });

		resetGuidanceStateForTests();
		const haiku = harness();
		rememberSpawnChain("Main", "8-Haiku", ["anthropic/claude-haiku-5-5"]);
		await haiku.start({ kind: "sub", name: "task", id: "8-Haiku" });
		expect(haiku.entries[0]).not.toMatchObject({ lines: expect.arrayContaining(["G32"]) });
	});

	test("G33 attaches to a Terra leaf child only", async () => {
		const terra = { provider: "openai-codex", id: "gpt-6.1-terra" };
		const leaf = harness();
		rememberSpawnChain("Main", "9-Terra", ["openai-codex/gpt-6.1-terra:medium"]);
		const prompt = await leaf.start({ kind: "sub", name: "task", id: "9-Terra" }, terra);
		expect(prompt.at(-1)).toContain("You may not delegate any part of it");
		expect(leaf.entries[0]).toMatchObject({ lines: expect.arrayContaining(["G33"]) });

		for (const [name, id, prompt] of [["orchestrator", "10-TerraOrch", "Run the plan."], ["plan", "11-TerraPlan", "Plan it."]]) {
			resetGuidanceStateForTests();
			const lead = harness();
			rememberSpawnChain("Main", id, ["openai-codex/gpt-6.1-terra:medium"]);
			await lead.start({ kind: "sub", name, id }, terra, prompt);
			expect(lead.entries[0]).not.toMatchObject({ lines: expect.arrayContaining(["G33"]) });
		}

		resetGuidanceStateForTests();
		const haiku = harness();
		rememberSpawnChain("Main", "12-Haiku", ["anthropic/claude-haiku-5-5"]);
		await haiku.start({ kind: "sub", name: "task", id: "12-Haiku" });
		expect(haiku.entries[0]).not.toMatchObject({ lines: expect.arrayContaining(["G33"]) });
	});

	test("a scope with an unknown key or roles beside all is rejected", () => {
		const withScope = (scope: unknown) => ({ ...guidanceData, lines: { ...guidanceData.lines, G33: { ...guidanceData.lines.G33, scope } } });
		expect(() => parseGuidance(withScope({ provider: "x" }), undefined)).toThrow("G33.scope");
		expect(() => parseGuidance(withScope({ all: true, roles: ["implementer"] }), undefined)).toThrow("G33.scope");
		expect(() => parseGuidance(withScope({ models: ["*x*"], roles: "implementer" }), undefined)).toThrow("G33.scope");
	});

	test("preparing twice gives the same prompt, the same tools and one record", async () => {
		const h = harness({ ...TREATMENT, G13: true });
		const first = await h.start({ kind: "sub", name: "task" });
		const toolsAfterFirst = h.tools();
		const second = await h.start({ kind: "sub", name: "task" });
		expect(second).toEqual(first);
		expect(second.filter(entry => entry.startsWith("<subagent-rules>"))).toHaveLength(1);
		expect(h.tools()).toEqual(toolsAfterFirst);
		expect(h.entries).toHaveLength(1);
	});

	test("malformed overrides fail at load and unknown IDs warn", () => {
		expect(() => parseGuidance(guidanceData, "{not json")).toThrow("does not parse");
		expect(() => parseGuidance(guidanceData, JSON.stringify({ G13: "yes" }))).toThrow("G13");
		const h = harness({ G99: true });
		expect(h.warnings[0]).toContain("G99");
	});
});
