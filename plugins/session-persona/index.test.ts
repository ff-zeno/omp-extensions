import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
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


interface Shortcut {
	description?: string;
	handler: (ctx: ExtensionContext) => void;
}
interface Command {
	description?: string;
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}
interface Registration {
	hooks: Map<string, Hook>;
	shortcuts: Map<string, Shortcut>;
	commands: Map<string, Command>;
}

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const scratchRoot = mkdtempSync(join(tmpdir(), "session-persona-test-"));
let scratchCount = 0;

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
}

// Every load reads keybindings from a scratch agent dir, never the user's real one.
function scratchAgentDir(keybindings?: string): string {
	const dir = join(scratchRoot, `agent-${scratchCount++}`);
	mkdirSync(dir, { recursive: true });
	if (keybindings !== undefined) writeFileSync(join(dir, "keybindings.yml"), keybindings);
	return dir;
}

beforeEach(() => {
	for (const key of ["PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE"] as const) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = scratchAgentDir();
});
afterEach(restoreEnv);
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

function load(): Registration {
	const registration: Registration = { hooks: new Map(), shortcuts: new Map(), commands: new Map() };
	sessionPersona({
		registerShortcut(key: string, options: Shortcut) {
			registration.shortcuts.set(key, options);
		},
		registerCommand(name: string, options: Command) {
			registration.commands.set(name, options);
		},
		on(name: string, handler: unknown) {
			registration.hooks.set(name, handler as unknown as Hook);
		},
	} as unknown as ExtensionAPI);
	const modes = registry();
	modes.mode.clear();
	modes.pendingMode.clear();
	return registration;
}

function loadWithKeybindings(keybindings: string): Registration {
	process.env.PI_CODING_AGENT_DIR = scratchAgentDir(keybindings);
	return load();
}

function registerExtension(): Map<string, Hook> {
	const { hooks, shortcuts } = load();
	const [shortcut] = shortcuts.values();
	hooks.set("cycle", (_event, ctx) => {
		if (ctx) shortcut.handler(ctx);
	});
	return hooks;
}

function startupNotices(registration: Registration): string[] {
	const notices: string[] = [];
	registration.hooks.get("session_start")?.({}, context("startup", "main", { notify: (message) => notices.push(message) }));
	return notices;
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

describe("persona commands", () => {
	function run(registration: Registration, line: string, ctx: ExtensionContext): Promise<void> {
		const [name, ...rest] = line.slice(1).split(" ");
		const command = registration.commands.get(name);
		if (!command) throw new Error(`/${name} is not registered`);
		return command.handler(rest.join(" "), ctx);
	}

	test("registers /persona and one command per persona", () => {
		expect([...load().commands.keys()].sort()).toEqual(["brute", "normal", "orchestrate", "persona"]);
	});

	test("/persona with no argument cycles normal → orchestrate → brute → normal", async () => {
		const registration = load();
		const notifications: string[] = [];
		const ctx = context("persona-cycle", "main", { notify: (message) => notifications.push(message) });
		const seen: string[] = [];
		for (let i = 0; i < 3; i++) {
			await run(registration, "/persona", ctx);
			seen.push(registry().getMode("persona-cycle"));
		}
		expect(seen).toEqual(["orchestrate", "brute", "normal"]);
		expect(notifications).toEqual(["Persona: 🧠 Orchestrate", "Persona: 🚀 Brute", "Persona: 🔘 Normal"]);
	});

	test("/persona <name> sets that persona regardless of the current one", async () => {
		const registration = load();
		const notifications: string[] = [];
		const ctx = context("persona-set", "main", { notify: (message) => notifications.push(message) });
		await run(registration, "/persona brute", ctx);
		expect(registry().getMode("persona-set")).toBe("brute");
		await run(registration, "/persona  Orchestrate ", ctx);
		expect(registry().getMode("persona-set")).toBe("orchestrate");
		await run(registration, "/persona orchestrate", ctx);
		expect(registry().getMode("persona-set")).toBe("orchestrate");
		expect(notifications).toEqual(["Persona: 🚀 Brute", "Persona: 🧠 Orchestrate", "Persona: 🧠 Orchestrate"]);
	});

	test("/persona with an unknown name lists valid personas and keeps the current one", async () => {
		const registration = load();
		const notifications: string[] = [];
		const ctx = context("persona-invalid", "main", { notify: (message) => notifications.push(message) });
		await run(registration, "/persona brute", ctx);
		await run(registration, "/persona orch", ctx);
		expect(registry().getMode("persona-invalid")).toBe("brute");
		expect(notifications.at(-1)).toBe('Unknown persona "orch". Valid personas: normal, orchestrate, brute.');
	});

	test("/normal, /orchestrate, and /brute set their persona directly", async () => {
		const registration = load();
		const notifications: string[] = [];
		const ctx = context("persona-direct", "main", { notify: (message) => notifications.push(message) });
		const seen: string[] = [];
		for (const line of ["/brute", "/orchestrate", "/normal", "/normal"]) {
			await run(registration, line, ctx);
			seen.push(registry().getMode("persona-direct"));
		}
		expect(seen).toEqual(["brute", "orchestrate", "normal", "normal"]);
		expect(notifications).toEqual([
			"Persona: 🚀 Brute",
			"Persona: 🧠 Orchestrate",
			"Persona: 🔘 Normal",
			"Persona: 🔘 Normal",
		]);
	});

	test("/persona completes persona names from the typed prefix", () => {
		const complete = load().commands.get("persona")?.getArgumentCompletions;
		expect(complete?.("")?.map((item) => item.value)).toEqual(["normal", "orchestrate", "brute"]);
		expect(complete?.("B")?.map((item) => item.value)).toEqual(["brute"]);
		expect(complete?.("x")).toBeNull();
	});
});

describe("persona hotkey", () => {
	test("binds Ctrl+Alt+P by default and names it in the descriptions", () => {
		const registration = load();
		expect([...registration.shortcuts.keys()]).toEqual(["ctrl+alt+p"]);
		expect(registration.shortcuts.get("ctrl+alt+p")?.description).toContain("(Ctrl+Alt+P)");
		expect(registration.commands.get("persona")?.description).toContain("(Ctrl+Alt+P)");
		expect(startupNotices(registration)).toEqual([]);
	});

	test("the hotkey cycles the persona", () => {
		const registration = load();
		const ctx = context("hotkey-cycle", "main");
		const handler = registration.shortcuts.get("ctrl+alt+p")?.handler;
		handler?.(ctx);
		expect(registry().getMode("hotkey-cycle")).toBe("orchestrate");
		handler?.(ctx);
		expect(registry().getMode("hotkey-cycle")).toBe("brute");
	});

	test("a list remap replaces the default with canonical chords", () => {
		const registration = loadWithKeybindings('sessionPersona.cycle: ["Alt+Ctrl+X", f8, ctrl+alt+x]\n');
		expect([...registration.shortcuts.keys()]).toEqual(["ctrl+alt+x", "f8"]);
		expect(registration.shortcuts.get("f8")?.description).toContain("(F8)");
		expect(registration.commands.get("persona")?.description).toContain("(Ctrl+Alt+X, F8)");
		expect(startupNotices(registration)).toEqual([]);
	});

	test("a single chord string remaps the hotkey", () => {
		const registration = loadWithKeybindings("app.model.select: alt+m\nsessionPersona.cycle: super+shift+k\n");
		expect([...registration.shortcuts.keys()]).toEqual(["shift+super+k"]);
	});

	test("an empty list disables the hotkey without a notice", () => {
		const registration = loadWithKeybindings("sessionPersona.cycle: []\n");
		expect(registration.shortcuts.size).toBe(0);
		expect(registration.commands.get("persona")?.description).not.toContain("(");
		expect(startupNotices(registration)).toEqual([]);
	});

	test("invalid chords are rejected with a notice and valid ones still bind", () => {
		const registration = loadWithKeybindings(
			'sessionPersona.cycle: [ctrl+alt+y, hyper+x, p, shift+q, ctrl+p, "ctrl+", 5]\n',
		);
		expect([...registration.shortcuts.keys()]).toEqual(["ctrl+alt+y"]);
		const notices = startupNotices(registration);
		expect(notices).toHaveLength(6);
		for (const [index, chord] of ['"hyper+x"', '"p"', '"shift+q"', '"ctrl+p"', '"ctrl+"', "5"].entries()) {
			expect(notices[index]).toContain(`ignoring ${chord} for sessionPersona.cycle`);
		}
		expect(notices[3]).toContain("reserved by OMP");
		expect(startupNotices(registration)).toEqual([]);
	});

	test("a list of only invalid chords binds nothing and says /persona still works", () => {
		const registration = loadWithKeybindings("sessionPersona.cycle: [meta+x]\n");
		expect(registration.shortcuts.size).toBe(0);
		expect(startupNotices(registration).at(-1)).toContain("/persona still works");
	});

	test("a value that is neither a chord nor a list keeps the default with a notice", () => {
		const registration = loadWithKeybindings("sessionPersona.cycle:\n  key: ctrl+alt+x\n");
		expect([...registration.shortcuts.keys()]).toEqual(["ctrl+alt+p"]);
		expect(startupNotices(registration)[0]).toContain("must be a chord or a list of chords");
	});

	test("an unparsable keybindings file keeps the default with a notice", () => {
		const registration = loadWithKeybindings("sessionPersona.cycle: [ctrl+alt+x\n");
		expect([...registration.shortcuts.keys()]).toEqual(["ctrl+alt+p"]);
		expect(startupNotices(registration)[0]).toContain("cannot read");
	});

	test("a named profile inherits the default profile entry and can override it", () => {
		// PI_CONFIG_DIR is home-relative in OMP; point it at a scratch config root.
		const configRoot = join(scratchRoot, `config-${scratchCount++}`);
		const defaultAgent = join(configRoot, "agent");
		const profileAgent = join(configRoot, "profiles", "work", "agent");
		mkdirSync(defaultAgent, { recursive: true });
		mkdirSync(profileAgent, { recursive: true });
		writeFileSync(join(defaultAgent, "keybindings.yml"), "sessionPersona.cycle: ctrl+alt+x\n");
		writeFileSync(join(profileAgent, "keybindings.yml"), "app.model.select: alt+m\n");
		process.env.PI_CONFIG_DIR = relative(homedir(), configRoot);
		process.env.OMP_PROFILE = "work";
		expect([...load().shortcuts.keys()]).toEqual(["ctrl+alt+x"]);
		writeFileSync(join(profileAgent, "keybindings.yml"), "sessionPersona.cycle: ctrl+alt+y\n");
		expect([...load().shortcuts.keys()]).toEqual(["ctrl+alt+y"]);
	});
});
