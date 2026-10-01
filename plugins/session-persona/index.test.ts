import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import sessionPersona from "./index.ts";

type SessionMode = "normal" | "brute" | "orchestrate";
interface PendingMode {
	parentAgentId: string;
	workerName: string;
	mode: SessionMode;
	createdAt: number;
}
interface ModeRegistry {
	mode: Map<string, SessionMode>;
	pendingMode: Map<string, PendingMode[]>;
	getMode(sessionId: string): SessionMode;
	setMode(sessionId: string, mode: SessionMode): void;
	paint(sessionId: string, tick: number): string;
}
interface TestEvent {
	toolName?: string;
	toolCallId?: string;
	input?: unknown;
	systemPrompt?: string[];
}
type HookResult = { systemPrompt?: string[] } | undefined;
type Hook = (event: TestEvent, ctx?: ExtensionContext) => HookResult;


function registerExtension(): Map<string, Hook> {
	const hooks = new Map<string, Hook>();
	sessionPersona({
		registerShortcut(_name: string, options: { handler: (ctx: ExtensionContext) => void }) {
			hooks.set("cycle", (_event, ctx) => {
				if (ctx) options.handler(ctx);
			});
		},
		registerCommand() {},
		on(name: string, handler: unknown) {
			hooks.set(name, handler as unknown as Hook);
		},
	} as unknown as ExtensionAPI);
	const modes = registry();
	modes.mode.clear();
	modes.pendingMode.clear();
	return hooks;
}

function context(
	id: string,
	name: string,
	options: {
		agent?: ExtensionContext["agent"];
		parentSession?: string;
		systemPrompt?: string[];
		sessionFile?: string;
		notify?: (message: string) => void;
	} = {},
): ExtensionContext {
	return {
		agent: options.agent ?? { kind: "main", id, name: "main", depth: 0 },
		sessionManager: {
			getSessionId: () => id,
			getSessionName: () => name,
			getSessionFile: () => options.sessionFile ?? `/sessions/${id}.jsonl`,
			getHeader: () => options.parentSession ? { parentSession: options.parentSession } : {},
		},
		getSystemPrompt: () => options.systemPrompt ?? [],
		hasUI: Boolean(options.notify),
		ui: { notify: (message: string) => options.notify?.(message) },
	} as unknown as ExtensionContext;
}

const registry = () => (globalThis as unknown as Record<symbol, unknown>)[
	Symbol.for("omp.session-persona.v1")
] as ModeRegistry;
const subagentPrompt = "You are operating on a piece of work assigned to you by the main agent";

function normalPrompt(): string {
	return "<system-conventions>\nBase normal persona.\n</personality>";
}

function dispatch(
	hooks: Map<string, Hook>,
	ctx: ExtensionContext,
	input: Record<string, unknown>,
	toolCallId = "tool-call-12345678",
): void {
	hooks.get("tool_call")?.({ toolName: "task", toolCallId, input }, ctx);
}

describe("session persona modes", () => {
	test("registers per-session mode accessors and paints the selected mode", () => {
		registerExtension();
		const modes = registry();
		expect(modes.getMode("mode-test-brute")).toBe("normal");
		modes.setMode("mode-test-brute", "brute");
		modes.setMode("mode-test-orchestrate", "orchestrate");
		expect(modes.getMode("mode-test-brute")).toBe("brute");
		expect(modes.getMode("mode-test-orchestrate")).toBe("orchestrate");
		expect(modes.paint("mode-test-brute", 0)).toBe(
			"\x1b[38;5;196m🚀\x1b[0m\x1b[38;5;202m \x1b[0m\x1b[38;5;208mb\x1b[0m\x1b[38;5;214mr\x1b[0m\x1b[38;5;166mu\x1b[0m\x1b[38;5;160mt\x1b[0m\x1b[38;5;203me\x1b[0m",
		);
		modes.setMode("mode-test-brute", "normal");
		expect(modes.paint("mode-test-brute", 0)).toBe(
			"\x1b[38;5;245m🔘 normal\x1b[0m",
		);
		modes.setMode("mode-test-orchestrate", "orchestrate");
		const paintedOrchestrate = modes.paint("mode-test-orchestrate", 0).replace(/\x1b\[[0-9;]*m/g, "");
		expect(paintedOrchestrate).toBe("🧠 orchestrate");
		expect(modes.getMode("mode-test-brute")).toBe("normal");
	});
	test("notifies with the selected persona label", () => {
		const hooks = registerExtension();
		const notifications: string[] = [];
		const ctx = context("notify-mode", "main", { notify: (message) => notifications.push(message) });

		hooks.get("cycle")?.({}, ctx);
		hooks.get("cycle")?.({}, ctx);
		hooks.get("cycle")?.({}, ctx);

		expect(notifications).toEqual([
			"Persona: 🧠 Orchestrate",
			"Persona: 🚀 Brute",
			"Persona: 🔘 Normal",
		]);
	});

	test("clears the persona override when returning from orchestrate to normal", () => {
		const hooks = registerExtension();
		const id = "round-trip-session";
		const ctx = context(id, "main", { systemPrompt: [normalPrompt()] });
		registry().setMode(id, "orchestrate");
		const orchestrated = hooks.get("before_agent_start")?.({ systemPrompt: [normalPrompt()] }, ctx);
		expect(orchestrated?.systemPrompt?.join("\n")).toContain("Dispatcher for this Oh My Pi session.");

		registry().setMode(id, "normal");
		const restored = hooks.get("before_agent_start")?.(
			{ systemPrompt: orchestrated?.systemPrompt ?? [normalPrompt()] },
			ctx,
		);
		expect(restored).toBeUndefined();
		expect(registry().getMode(id)).toBe("normal");
	});

	test("extracts persona from orchestrator job, text directives, and name tags", () => {
		const hooks = registerExtension();
		const parent = context("persona-parent", "main");
		const prompt = [subagentPrompt, `<wrapper-prefix>\n${normalPrompt()}\n<wrapper-suffix>`, "append block remains unchanged"];
		dispatch(hooks, parent, {
			tasks: [
				{ name: "persona-brute-agent-ignored", agent: "brute", task: "Fix this bug" },
				{ name: "persona-orchestrate-worker", agent: "orchestrator", task: "Coordinate this work" },
				{ name: "persona-context-worker", task: "# Mode: orchestrate\nCoordinate this work" },
				{ name: "persona-context-brute-worker", task: "# Mode: brute\nFix this bug" },
				{ name: "persona-any-agent-brute", agent: "plan", context: "  Persona: BRUTE\nExecute this work" },
				{ name: "persona-any-agent-orchestrate", agent: "task", task: "  mode: Orchestrate\nCoordinate this work" },
				{ name: "persona-name-tag-orchestrate [orch]", agent: "reviewer", task: "Coordinate this work" },
				{ name: "persona-name-tag-brute [brute]", agent: "plan", task: "Execute this work" },
			],
		});

		for (const [name, mode, fingerprint] of [
			["persona-brute-agent-ignored", "normal", undefined],
			[
				"persona-orchestrate-worker",
				"orchestrate",
				"Dispatcher for this Oh My Pi session. Specialists do the work. You do not.",
			],
			[
				"persona-context-worker",
				"orchestrate",
				"Dispatcher for this Oh My Pi session. Specialists do the work. You do not.",
			],
			["persona-context-brute-worker", "brute", "Execute the user's asked action in this Oh My Pi session."],
			["persona-any-agent-brute", "brute", "Execute the user's asked action in this Oh My Pi session."],
			[
				"persona-any-agent-orchestrate",
				"orchestrate",
				"Dispatcher for this Oh My Pi session. Specialists do the work. You do not.",
			],
			[
				"persona-name-tag-orchestrate [orch]",
				"orchestrate",
				"Dispatcher for this Oh My Pi session. Specialists do the work. You do not.",
			],
			["persona-name-tag-brute [brute]", "brute", "Execute the user's asked action in this Oh My Pi session."],
		] as const) {
			const childId = `${name}-session`;
			const result = hooks.get("before_agent_start")?.(
				{ systemPrompt: prompt },
				context(childId, name, {
					agent: { kind: "sub", id: childId, name: "task", depth: 1, parentId: "persona-parent" },
				}),
			);
			expect(registry().getMode(childId)).toBe(mode);
			const output = result?.systemPrompt;
			if (fingerprint === undefined) {
				expect(output).toBeUndefined();
				continue;
			}
			expect(output?.join("\n").match(/<system-conventions>/g)?.length).toBe(1);
			expect(output?.at(-1)).toBe("append block remains unchanged");
			expect(output?.[1]).toContain("<wrapper-prefix>");
			expect(output?.[1]).toContain("<wrapper-suffix>");
		}
	});


	test("honors task.mode when supplied by a future task schema", () => {
		const hooks = registerExtension();
		const parent = context("mode-forward-parent", "main");
		dispatch(hooks, parent, { tasks: [{ name: "mode-forward-worker", mode: "brute" }] });
		const child = context("mode-forward-child", "mode-forward-worker", {
			agent: { kind: "sub", id: "mode-forward-child-agent", name: "task", depth: 1, parentId: "mode-forward-parent" },
		});
		const result = hooks.get("before_agent_start")?.({ systemPrompt: [subagentPrompt, normalPrompt()] }, child);
		expect(registry().getMode("mode-forward-child")).toBe("brute");
		expect(result?.systemPrompt?.join("\n")).toContain("Execute the user's asked action");
	});

	test("resolves pending persona using the session filename when the session name is empty", () => {
		const hooks = registerExtension();
		const parent = context("session-file-parent", "main");
		dispatch(hooks, parent, { tasks: [{ name: "session-file-worker", task: "# Mode: brute\nFix this" }] });

		const child = context("session-file-child", "", {
			agent: { kind: "sub", id: "session-file-child-agent", name: "task", depth: 1, parentId: "session-file-parent" },
			sessionFile: "/sessions/session-file-worker.jsonl",
		});
		const result = hooks.get("before_agent_start")?.(
			{ systemPrompt: [subagentPrompt, normalPrompt()] },
			child,
		);

		expect(registry().getMode("session-file-child")).toBe("brute");
		expect(result?.systemPrompt?.join("\n")).toContain("Execute the user's asked action");
	});


	test("matches pending modes to the parent and leaves ambiguous children unattached", () => {
		const hooks = registerExtension();
		const firstParent = context("scope-parent-a", "main", { sessionFile: "/sessions/a.jsonl" });
		const secondParent = context("scope-parent-b", "main", { sessionFile: "/sessions/b.jsonl" });
		dispatch(hooks, firstParent, { tasks: [{ name: "shared-worker", task: "# Mode: brute\nFix this" }] }, "scope-call-a");
		dispatch(hooks, secondParent, { tasks: [{ name: "shared-worker", agent: "orchestrator" }] }, "scope-call-b");

		const childPrompt = [subagentPrompt, normalPrompt()];
		const scopedChild = context("scoped-child", "shared-worker", {
			agent: { kind: "sub", id: "scoped-child-agent", name: "task", depth: 1, parentId: "scope-parent-a" },
			systemPrompt: [subagentPrompt],
		});
		const result = hooks.get("before_agent_start")?.({ systemPrompt: childPrompt }, scopedChild);
		expect(registry().getMode("scoped-child")).toBe("brute");
		expect(result?.systemPrompt?.join("\n")).toContain("Execute the user's asked action");
		expect(registry().pendingMode.has("scope-parent-b:shared-worker")).toBe(true);

		dispatch(hooks, firstParent, { tasks: [{ name: "ambiguous-worker", task: "# Mode: brute\nFix this" }] }, "scope-ambiguous-a");
		dispatch(hooks, secondParent, { tasks: [{ name: "ambiguous-worker", agent: "orchestrator" }] }, "scope-ambiguous-b");
		const ambiguous = context("ambiguous-child", "ambiguous-worker", {
			agent: { kind: "sub", id: "ambiguous-agent", name: "task", depth: 1 },
			systemPrompt: [subagentPrompt],
		});
		expect(hooks.get("before_agent_start")?.({ systemPrompt: childPrompt }, ambiguous)).toBeUndefined();
		expect(registry().getMode("ambiguous-child")).toBe("normal");
		expect(registry().pendingMode.has("scope-parent-a:ambiguous-worker")).toBe(true);
		expect(registry().pendingMode.has("scope-parent-b:ambiguous-worker")).toBe(true);
	});
	test("matches dot-notation workers by short or full task name", () => {
		const hooks = registerExtension();
		const parent = context("dot-parent-id", "CoreOrch");
		dispatch(hooks, parent, {
			tasks: [
				{ name: "DocSpecialist", agent: "plan", mode: "brute" },
				{ name: "CoreOrch.DocSpecialist", agent: "plan", mode: "orchestrate" },
			],
		});
		for (const [id, mode] of [["dot-child-short", "brute"], ["dot-child-full", "orchestrate"]] as const) {
			const child = context(id, "CoreOrch.DocSpecialist", {
				agent: { kind: "sub", id, name: "task", depth: 1, parentId: "dot-parent-id" },
			});
			const result = hooks.get("before_agent_start")?.(
				{ systemPrompt: [subagentPrompt, "no constitution markers"] },
				child,
			);
			expect(registry().getMode(id)).toBe(mode);
			expect(result?.systemPrompt?.join("\n")).toContain(
				mode === "brute" ? "Execute the user's asked action" : "Dispatcher for this Oh My Pi session.",
			);
		}
	});

	test("clamps orchestrator dispatch using agent kind and depth", () => {
		const hooks = registerExtension();
		for (const [id, mode, depth, allowed] of [
			["normal-child", "normal", 1, false],
			["brute-child", "brute", 0, false],
			["deep-orchestrator", "orchestrate", 2, false],
			["authorized-orchestrator", "orchestrate", 1, true],
			["depth-zero-orchestrator", "orchestrate", 0, true],
		] as const) {
			registry().setMode(id, mode);
			const parent = context(id, id, {
				agent: { kind: "sub", id: `agent-${id}`, name: "task", depth, parentId: "root-agent" },
			});
			const input = { tasks: [{ name: `${id}-spawn`, agent: "orchestrator" }] };
			dispatch(hooks, parent, input, `${id}-call-1234`);
			expect(input.tasks[0]?.agent).toBe(allowed ? "orchestrator" : "task");
			expect(registry().pendingMode.get(`agent-${id}:${id}-spawn`)?.[0]?.mode)
				.toBe(allowed ? "orchestrate" : "normal");
		}
	});

	test("uses agent kind and parent registry id instead of session metadata", () => {
		const hooks = registerExtension();
		const parent = context("main-session", "main", {
			parentSession: "/sessions/a-parent-session.jsonl",
			systemPrompt: [subagentPrompt],
			agent: { kind: "main", id: "registry-main", name: "main", depth: 0 },
		});
		const input = { tasks: [{ name: "identity-worker", agent: "orchestrator" }] };
		dispatch(hooks, parent, input);
		expect(input.tasks[0]?.agent).toBe("orchestrator");
		expect(registry().pendingMode.has("registry-main:identity-worker")).toBe(true);

		const child = context("child-session", "identity-worker", {
			agent: { kind: "sub", id: "registry-child", name: "task", depth: 0, parentId: "registry-main" },
		});
		const result = hooks.get("before_agent_start")?.({ systemPrompt: [normalPrompt()] }, child);
		expect(registry().getMode("child-session")).toBe("orchestrate");
		expect(result?.systemPrompt?.join("\n")).toContain("Dispatcher for this Oh My Pi session.");
		expect(registry().pendingMode.has("registry-main:identity-worker")).toBe(false);
	});
	test("expires pending modes after 60 seconds and clears a parent's entries on shutdown", () => {
		const hooks = registerExtension();
		const originalNow = Date.now;
		try {
			Date.now = () => 100_000;
			const parent = context("ttl-parent", "main");
			dispatch(hooks, parent, { tasks: [{ name: "ttl-worker", task: "# Mode: brute\nFix this" }] });
			expect(registry().pendingMode.has("ttl-parent:ttl-worker")).toBe(true);
			Date.now = () => 160_001;
			const child = context("ttl-child", "ttl-worker", {
				agent: { kind: "sub", id: "ttl-child-agent", name: "task", depth: 1, parentId: "ttl-parent" },
			});
			expect(hooks.get("before_agent_start")?.({ systemPrompt: [subagentPrompt, normalPrompt()] }, child)).toBeUndefined();
			expect(registry().pendingMode.size).toBe(0);
		} finally {
			Date.now = originalNow;
		}

		const parent = context("shutdown-parent", "main");
		dispatch(hooks, parent, { tasks: [{ name: "shutdown-worker", task: "# Mode: brute\nFix this" }] });
		hooks.get("session_shutdown")?.({}, parent);
		expect(registry().pendingMode.has("shutdown-parent:shutdown-worker")).toBe(false);
	});

	test("generates stable names for nameless task spawns", () => {
		const hooks = registerExtension();
		const parent = context("nameless-parent", "main");
		const task: { task: string; name?: string } = { task: "# Mode: brute\nFix this" };
		dispatch(hooks, parent, { tasks: [task] }, "task-call-87654321");
		expect(task.name).toBe("task-87654321-1");
		expect(registry().pendingMode.has("nameless-parent:task-87654321-1")).toBe(true);
	});


	test("injects the requested constitution when the prompt has no markers", () => {
		const hooks = registerExtension();
		const parent = context("fallback-parent", "main");
		dispatch(hooks, parent, { tasks: [{ name: "fallback-worker", task: "# Mode: brute\nFix this" }] });
		const child = context("fallback-child", "fallback-worker", {
			agent: { kind: "sub", id: "fallback-child-agent", name: "task", depth: 1, parentId: "fallback-parent" },
		});
		const result = hooks.get("before_agent_start")?.(
			{ systemPrompt: [subagentPrompt, "no constitution markers"] },
			child,
		);
		expect(registry().getMode("fallback-child")).toBe("brute");
		expect(result?.systemPrompt?.join("\n")).toContain("<system-conventions>");
		expect(result?.systemPrompt?.join("\n")).toContain("</personality>");
		expect(result?.systemPrompt?.join("\n")).toContain("Execute the user's asked action");
		expect(result?.systemPrompt?.at(-1)).toBe("no constitution markers");
	});

	test("checks fingerprints only inside constitution markers", () => {
		const hooks = registerExtension();
		const parent = context("fingerprint-parent", "main");
		dispatch(hooks, parent, { tasks: [{ name: "fingerprint-worker", task: "# Mode: brute\nFix this" }] });
		const child = context("fingerprint-child", "fingerprint-worker", {
			agent: { kind: "sub", id: "fingerprint-child-agent", name: "task", depth: 1, parentId: "fingerprint-parent" },
		});
		const fingerprint = "Execute the user's asked action in this Oh My Pi session.";
		const wrapped = `${fingerprint}\n<wrapper>\n${normalPrompt()}\n</wrapper>`;
		const result = hooks.get("before_agent_start")?.({ systemPrompt: [subagentPrompt, wrapped] }, child);
		expect(registry().getMode("fingerprint-child")).toBe("brute");
		expect(result?.systemPrompt?.join("\n")).toContain("<wrapper>");
		expect(result?.systemPrompt?.join("\n")).toContain(fingerprint);
		expect(result?.systemPrompt?.join("\n")).toContain("# Subagent brute workers");
	});

	test("leaves unassigned subagents in normal mode", () => {
		const hooks = registerExtension();
		const parent = context("normal-parent", "main");
		dispatch(hooks, parent, { tasks: [{ name: "normal-worker" }] });
		const child = context("normal-child-session", "normal-worker", {
			agent: { kind: "sub", id: "normal-child-agent", name: "task", depth: 1, parentId: "normal-parent" },
		});
		const result = hooks.get("before_agent_start")?.(
			{ systemPrompt: [subagentPrompt, normalPrompt()] },
			child,
		);
		expect(result).toBeUndefined();
		expect(registry().getMode("normal-child-session")).toBe("normal");
	});
});
