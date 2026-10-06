import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	applyAssistantProgress,
	callTps,
	clearPendingSpawns,
	collectWorkerTree,
	effectiveStreamTokens,
	eventDeltaChars,
	generationWindowMs,
	getSparkHistory,
	parseTaskSpawns,
	pendingSpawnKey,
	personaBadge,
	pruneWorkers,
	queuePendingSpawns,
	truncateTerminalLine,
	terminalDisplayWidth,
	resolveMessageTokens,
	SPINNER_ADVANCE_MS,
	statusSpinnerFrame,
	type SessionThroughput,
	type TokenProgress,
	type ThroughputRegistry,
	default as throughput,
} from "./throughput.ts";

function progress(): TokenProgress {
	return {
		firstTokenAt: 0,
		lastTokenAt: 0,
		lastActivityAt: 0,
		updatedAt: 0,
		messageChars: 0,
		messageTokens: 0,
	};
}

describe("Throughput token accounting and TPS calculation", () => {
	test("counts toolcall_delta the same as thinking/text deltas", () => {
		expect(eventDeltaChars({ type: "thinking_delta", delta: "Considering the request..." })).toBe(26);
		expect(eventDeltaChars({ type: "toolcall_delta", delta: '{"path":"/tmp/foo.ts"}' })).toBe(22);
		expect(eventDeltaChars({ type: "text_delta", delta: { text: "hello" } })).toBe(5);
		expect(eventDeltaChars({ type: "start" })).toBe(0);
	});

	test("starts the clock on encrypted-reasoning thinking_start", () => {
		const session = progress();
		expect(
			applyAssistantProgress(session, { type: "thinking_start" }, { role: "assistant", content: [] }, 1_000),
		).toBe(true);
		expect(session.firstTokenAt).toBe(1_000);
		expect(session.messageTokens).toBe(0);
	});

	test("counts tool-only turns from streamed args and message content", () => {
		const session = progress();
		applyAssistantProgress(session, { type: "thinking_start" }, { role: "assistant", content: [] }, 1_000);
		applyAssistantProgress(
			session,
			{ type: "toolcall_delta", delta: '{"path":"/tmp/foo.ts"}' },
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/foo.ts" } }],
			},
			1_800,
		);
		expect(session.messageChars).toBeGreaterThan(0);
		expect(session.messageTokens).toBeGreaterThan(0);
	});

	test("prefers provider usage.output over char estimates", () => {
		expect(
			resolveMessageTokens(
				{
					usage: { output: 661, reasoningTokens: 516 },
					content: [{ type: "thinking", thinking: "short" }],
				},
				20,
			),
		).toBe(661);
	});

	test("measures sustained streaming duration when visible window >= 250ms", () => {
		const windowMs = generationWindowMs(
			{
				firstTokenAt: 1_000,
				requestStartedAt: 500,
				messageStartedAt: 500,
			},
			2_000,
		);
		expect(windowMs).toBe(1_000);
		expect(callTps(220, windowMs)).toBe(220);
	});

	test("uses total request duration on single-packet bursts (<250ms) to prevent false 1600+ TPS spikes", () => {
		// 60 tokens arrived in a 30ms burst after 270ms request processing -> 300ms total -> 200 TPS
		const windowMs = generationWindowMs(
			{
				firstTokenAt: 1_270,
				requestStartedAt: 1_000,
				messageStartedAt: 1_000,
			},
			1_300,
		);
		expect(windowMs).toBe(300);
		expect(callTps(60, windowMs)).toBe(200);
	});

	test("synchronizes sparkline history with recorded calls and active stream", () => {
		const session = {
			...progress(),
			sessionId: "test",
			role: "main" as const,
			order: 0,
			phase: "idle" as const,
			totalTokens: 0,
			avgTps: 200,
			lastTtfbMs: 0,
			callHistory: [
				{ tps: 210, ttfbMs: 200, generateMs: 300, tokens: 63 },
				{ tps: 220, ttfbMs: 200, generateMs: 300, tokens: 66 },
			],
			tickHistory: [],
			messageOpen: false,
		};
		// Completed calls sync immediately into sparkline
		const idleHistory = getSparkHistory(session, 0);
		expect(idleHistory).toEqual([210, 220]);

		// Active streaming appends live TPS to sparkline
		const liveHistory = getSparkHistory(session, 230);
		expect(liveHistory).toEqual([210, 220, 230]);
	});

	test("amortizes unstreamed thinking over total request duration", () => {
		const tokens = effectiveStreamTokens(
			{
				messageChars: 80, // ~23 estimated visible tokens
				messageTokens: 800, // 800 billed output tokens (777 hidden thinking)
				requestStartedAt: 1_000,
				firstTokenAt: 9_000, // 8s TTFB
			},
			300, // 300ms visible text generation window
			9_300, // 8.3s total request time
		);
		// 800 tokens / 8.3s request ~ 96 tok/s -> over 300ms window ~ 29 tokens (96.7 tok/s)
		const tps = callTps(tokens, 300);
		expect(tps).toBeGreaterThan(80);
		expect(tps).toBeLessThan(120);
	});

	test("preserves exact billed tokens when thinking is streamed", () => {
		const tokens = effectiveStreamTokens(
			{
				messageChars: 3_000, // streamed thinking + text
				messageTokens: 800,
				requestStartedAt: 1_000,
				firstTokenAt: 1_500,
			},
			3_500,
			5_000,
		);
		expect(tokens).toBe(800);
		expect(callTps(tokens, 3_500)).toBeCloseTo(228.57, 1);
	});
});

function throughputSession(
	sessionId: string,
	role: "main" | "worker",
	order: number,
	overrides: Partial<SessionThroughput> = {},
): SessionThroughput {
	return {
		sessionId,
		agentId: `agent-${sessionId}`,
		role,
		order,
		label: sessionId,
		model: "test-model",
		thinkingLevel: "low",
		agent: role === "main" ? "main" : "task",
		phase: "waiting",
		children: [],
		parentResolved: false,
		depth: 0,
		messageStartedAt: 0,
		requestStartedAt: 0,
		firstTokenAt: 0,
		lastTokenAt: 0,
		lastActivityAt: 1_000,
		lastSampleAt: 0,
		toolStartedAt: 0,
		messageChars: 0,
		messageTokens: 0,
		totalTokens: 0,
		avgTps: 0,
		lastTtfbMs: 0,
		callHistory: [],
		tickHistory: [],
		updatedAt: 1_000,
		messageOpen: false,
		...overrides,
	};
}

function throughputRegistry(...sessions: SessionThroughput[]): ThroughputRegistry {
	return {
		version: 4,
		nextOrder: sessions.length + 1,
		sessions: new Map(sessions.map((session) => [session.sessionId, session])),
		sessionByAgentId: new Map(sessions.map((session) => [session.agentId, session.sessionId])),
		pendingSpawns: new Map(),
	};
}

describe("Throughput hierarchy and persona dispatch", () => {
	test("parses task mode spawns without carrying task agent names", () => {
		expect(parseTaskSpawns({ name: "review", agent: "reviewer", mode: "orchestrate" }, "parent", 10)).toEqual([
			{ parentSessionId: "parent", workerName: "review", mode: "orchestrate", createdAt: 10 },
		]);
		expect(
			parseTaskSpawns(
				{
					tasks: [
						{ name: "plan", agent: "planner", mode: "brute" },
						{ name: "test" },
						{ agent: "reviewer" },
						null,
					],
				},
				"parent",
				11,
			),
		).toEqual([
			{ parentSessionId: "parent", workerName: "plan", mode: "brute", createdAt: 11 },
			{ parentSessionId: "parent", workerName: "test", createdAt: 11 },
		]);
		const unnamed: { task: string; name?: string } = { task: "# Mode: brute\nFix this" };
		expect(parseTaskSpawns({ tasks: [unnamed] }, "parent", 12, "call-87654321")).toEqual([
			{
				parentSessionId: "parent",
				workerName: "task-87654321-1",
				mode: "brute",
				createdAt: 12,
			},
		]);
		expect(unnamed.name).toBe("task-87654321-1");
		expect(parseTaskSpawns({ name: "context-mode", task: "# Mode: orchestrate\nCoordinate" }, "parent", 13))
			.toEqual([{ parentSessionId: "parent", workerName: "context-mode", mode: "orchestrate", createdAt: 13 }]);
		expect(parseTaskSpawns({ name: "tagged-plan [orch]", agent: "plan" }, "parent", 14)).toEqual([
			{ parentSessionId: "parent", workerName: "tagged-plan [orch]", mode: "orchestrate", createdAt: 14 },
		]);
		expect(parseTaskSpawns({ name: "tagged-task [brute]", agent: "task" }, "parent", 17)).toEqual([
			{ parentSessionId: "parent", workerName: "tagged-task [brute]", mode: "brute", createdAt: 17 },
		]);
		expect(parseTaskSpawns({ name: "persona-context", agent: "task", context: "\n  Persona: BRUTE\nFix this" }, "parent", 15))
			.toEqual([{ parentSessionId: "parent", workerName: "persona-context", mode: "brute", createdAt: 15 }]);
		expect(parseTaskSpawns({ name: "normal-overrides-tag [brute]", agent: "task", task: "mode: normal\nWork" }, "parent", 16))
			.toEqual([{ parentSessionId: "parent", workerName: "normal-overrides-tag [brute]", mode: "normal", createdAt: 16 }]);
		expect(parseTaskSpawns({ name: "brute-agent-ignored", agent: "brute" }, "parent", 18))
			.toEqual([{ parentSessionId: "parent", workerName: "brute-agent-ignored", createdAt: 18 }]);
	});

	test("expires pending spawns after 60 seconds and clears a parent's queue", () => {
		const registry = throughputRegistry();
		registry.pendingSpawns.set("parent:expired", [
			{ parentSessionId: "parent", workerName: "expired", createdAt: 39_999 },
		]);
		registry.pendingSpawns.set("parent:boundary", [
			{ parentSessionId: "parent", workerName: "boundary", createdAt: 40_000 },
		]);

		pruneWorkers(registry, 100_000);
		expect(registry.pendingSpawns.has("parent:expired")).toBe(false);
		expect(registry.pendingSpawns.get("parent:boundary")).toHaveLength(1);
		clearPendingSpawns(registry, "parent");
		expect(registry.pendingSpawns.size).toBe(0);
	});

	test("renders a DFS forest with branch continuations and unattached roots after main", () => {
		const main = throughputSession("main", "main", 0);
		const first = throughputSession("first", "worker", 1, { parentId: "main", depth: 1 });
		const second = throughputSession("second", "worker", 2, { parentId: "main", depth: 1 });
		const firstChild = throughputSession("first-child", "worker", 3, { parentId: "first", depth: 2 });
		const firstLastChild = throughputSession("first-last-child", "worker", 4, { parentId: "first", depth: 2 });
		const firstGrandchild = throughputSession("first-grandchild", "worker", 5, {
			parentId: "first-child",
			depth: 3,
		});
		const secondChild = throughputSession("second-child", "worker", 6, { parentId: "second", depth: 2 });
		const unattached = throughputSession("unattached", "worker", 7);
		const unattachedChild = throughputSession("unattached-child", "worker", 8, {
			parentId: "unattached",
			depth: 1,
		});

		expect(
			collectWorkerTree("main", [
				main,
				first,
				second,
				firstChild,
				firstLastChild,
				firstGrandchild,
				secondChild,
				unattached,
				unattachedChild,
			]).map(({ session, prefix }) => [session.sessionId, prefix]),
		).toEqual([
			["first", "├─ "],
			["first-child", "│  ├─ "],
			["first-grandchild", "│  │  └─ "],
			["first-last-child", "│  └─ "],
			["second", "└─ "],
			["second-child", "   └─ "],
			["unattached", ""],
			["unattached-child", "└─ "],
		]);
	});

	test("keeps completed ancestors until descendants finish, then prunes bottom-up", () => {
		const root = throughputSession("root", "worker", 1, {
			phase: "complete",
			completedAt: 1_000,
			children: ["child"],
			depth: 1,
		});
		const child = throughputSession("child", "worker", 2, {
			phase: "complete",
			completedAt: 1_000,
			parentId: "root",
			children: ["active"],
			depth: 2,
		});
		const active = throughputSession("active", "worker", 3, { parentId: "child", depth: 3, updatedAt: 4_000 });
		const registry = throughputRegistry(root, child, active);

		pruneWorkers(registry, 5_000);
		expect([...registry.sessions.keys()]).toEqual(["root", "child", "active"]);

		active.phase = "complete";
		active.completedAt = 5_000;
		pruneWorkers(registry, 8_001);
		expect([...registry.sessions.keys()]).toEqual([]);
		expect(root.children).toEqual([]);
		expect(child.children).toEqual([]);
	});

	test("retains a completed leaf through three seconds and prunes after expiry", () => {
		const leaf = throughputSession("leaf", "worker", 1, { phase: "complete", completedAt: 1_000 });
		const registry = throughputRegistry(leaf);
		pruneWorkers(registry, 4_000);
		expect(registry.sessions.has("leaf")).toBe(true);
		pruneWorkers(registry, 4_001);
		expect(registry.sessions.has("leaf")).toBe(false);
	});

	test("maps session modes to compact persona icons", () => {
		expect(personaBadge("orchestrate")).toEqual({ label: "🧠 orch", icon: "🧠", tone: "accent" });
		expect(personaBadge("brute")).toEqual({ label: "🚀 brute", icon: "🚀", tone: "warning" });
		expect(personaBadge("normal")).toEqual({ label: "🔘 normal", icon: "🔘", tone: "dim" });
		expect(personaBadge(undefined)).toEqual({ label: "🔘 normal", icon: "🔘", tone: "dim" });
	});

	test("prunes expired sessions even if stale registry links contain a cycle", () => {
		const first = throughputSession("cycle-first", "worker", 1, {
			parentId: "cycle-second",
			children: ["cycle-second"],
			depth: 1,
			updatedAt: 0,
		});
		const second = throughputSession("cycle-second", "worker", 2, {
			parentId: "cycle-first",
			children: ["cycle-first"],
			depth: 1,
			updatedAt: 0,
		});
		const registry = throughputRegistry(first, second);

		pruneWorkers(registry, 10 * 60_000 + 1);
		expect(registry.sessions.size).toBe(0);
	});

	test("truncates styled rows by terminal columns, including wide characters", () => {
		const styled = `\x1b[31m${"x".repeat(20)}\x1b[0m`;
		const truncated = truncateTerminalLine(styled, 4);
		expect(terminalDisplayWidth(truncated)).toBe(4);
		expect(truncated).toEndWith("\x1b[0m");
		expect(terminalDisplayWidth(truncateTerminalLine("界".repeat(4), 5))).toBe(4);
	});


	test("falls back to the queued mode when the mode registry lacks the worker", () => {
		const global = globalThis as Record<symbol, unknown>;
		const registryKey = Symbol.for("omp.throughput.registry.v4");
		const modeKey = Symbol.for("omp.session-persona.v1");
		const previousRegistry = global[registryKey];
		const previousModeRegistry = global[modeKey];
		delete global[registryKey];
		delete global[modeKey];
		const widgets: string[][] = [];
		const makeContext = (sessionId: string, name: string, agent: ExtensionContext["agent"]) => ({
			agent,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionName: () => name,
				getSessionFile: () => `/sessions/${sessionId}.jsonl`,
				getHeader: () => ({}),
			},
			model: { id: "test/model" },
			setInterval: () => 0,
			clearTimer: () => {},
			ui: {
				theme: { fg: (_color: string, value: string) => value },
				setWidget: (_name: string, lines: unknown) => {
					if (Array.isArray(lines)) widgets.push(lines as string[]);
				},
			},
		});
		const createPi = () => {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			throughput({
				on: (event: string, handler: unknown) => {
					handlers.set(event, handler as (event: unknown, ctx: unknown) => void);
				},
				getThinkingLevel: () => "low",
			} as unknown as Parameters<typeof throughput>[0]);
			return handlers;
		};
		const parentContext = makeContext("mode-fallback-parent", "main", {
			kind: "main", id: "registry-mode-fallback-parent", name: "main", depth: 0,
		});
		const workerContext = makeContext("mode-fallback-worker", "fallback-worker", {
			kind: "sub",
			id: "registry-mode-fallback-worker",
			name: "task",
			depth: 1,
			parentId: "registry-mode-fallback-parent",
		});
		const parentHandlers = createPi();
		const workerHandlers = createPi();
		try {
			parentHandlers.get("session_start")?.({}, parentContext);
			parentHandlers.get("tool_call")?.(
				{ toolName: "task", input: { name: "fallback-worker", agent: "task", mode: "brute" } },
				parentContext,
			);
			workerHandlers.get("session_start")?.({}, workerContext);
			expect((global[registryKey] as ThroughputRegistry).sessions.get("mode-fallback-worker")?.mode).toBe("brute");

			global[modeKey] = { mode: new Map(), getMode: () => "normal", paint: () => "normal" };
			parentHandlers.get("session_start")?.({}, parentContext);
			expect(widgets.at(-1)?.some((line) => line.includes("🚀 | task   "))).toBe(true);
		} finally {
			workerHandlers.get("session_shutdown")?.({}, workerContext);
			parentHandlers.get("session_shutdown")?.({}, parentContext);
			if (previousRegistry === undefined) delete global[registryKey];
			else global[registryKey] = previousRegistry;
			if (previousModeRegistry === undefined) delete global[modeKey];
			else global[modeKey] = previousModeRegistry;
		}
	});

	test("keeps reviewer seat numbers visible and ellipsizes long worker names", () => {
		const global = globalThis as Record<symbol, unknown>;
		const registryKey = Symbol.for("omp.throughput.registry.v4");
		const previousRegistry = global[registryKey];
		delete global[registryKey];
		const widgets: string[][] = [];
		const makeContext = (sessionId: string, name: string, agent: ExtensionContext["agent"]) => ({
			agent,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionName: () => name,
				getSessionFile: () => `/sessions/${sessionId}.jsonl`,
				getHeader: () => ({}),
			},
			model: { id: "test/model" },
			setInterval: () => 0,
			clearTimer: () => {},
			ui: {
				theme: { fg: (_color: string, value: string) => value },
				setWidget: (_name: string, lines: unknown) => {
					if (Array.isArray(lines)) widgets.push(lines as string[]);
				},
			},
		});
		const createPi = () => {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			throughput({
				on: (event: string, handler: unknown) => {
					handlers.set(event, handler as (event: unknown, ctx: unknown) => void);
				},
				getThinkingLevel: () => "high",
			} as unknown as Parameters<typeof throughput>[0]);
			return handlers;
		};
		const parentContext = makeContext("columns-parent", "main", {
			kind: "main", id: "registry-columns-parent", name: "main", depth: 0,
		});
		const workerContext = makeContext("columns-worker", "W1ReviewFrontierSecondPass", {
			kind: "sub", id: "registry-columns-worker", name: "review-frontier-2", depth: 1,
			parentId: "registry-columns-parent",
		});
		const parentHandlers = createPi();
		const workerHandlers = createPi();
		const stdout = process.stdout as NodeJS.WriteStream;
		const originalColumns = Object.getOwnPropertyDescriptor(stdout, "columns");
		try {
			parentHandlers.get("session_start")?.({}, parentContext);
			workerHandlers.get("session_start")?.({}, workerContext);
			for (const cols of [100, 150]) {
				Object.defineProperty(stdout, "columns", { configurable: true, value: cols });
				parentHandlers.get("session_start")?.({}, parentContext);
				const row = widgets.at(-1)?.find((line) => line.includes("W1Review"));
				expect(row).toContain("review-2");
				expect(row).toMatch(/W1Review\S*…/);
				expect(terminalDisplayWidth(row ?? "")).toBeLessThanOrEqual(cols);
			}
		} finally {
			workerHandlers.get("session_shutdown")?.({}, workerContext);
			parentHandlers.get("session_shutdown")?.({}, parentContext);
			if (originalColumns) Object.defineProperty(stdout, "columns", originalColumns);
			else Reflect.deleteProperty(stdout, "columns");
			if (previousRegistry === undefined) delete global[registryKey];
			else global[registryKey] = previousRegistry;
		}
	});

	test("links sessions by ctx.agent parent id and renders its name and depth", () => {
		const global = globalThis as Record<symbol, unknown>;
		const registryKey = Symbol.for("omp.throughput.registry.v4");
		const modeKey = Symbol.for("omp.session-persona.v1");
		const previousRegistry = global[registryKey];
		const previousModeRegistry = global[modeKey];
		delete global[registryKey];
		delete global[modeKey];
		const widgets: string[][] = [];
		const makeContext = (
			sessionId: string,
			name: string,
			agent: ExtensionContext["agent"],
			onHeaderRead?: () => void,
		) => ({
			agent,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionName: () => name,
				getSessionFile: () => `/sessions/${sessionId}.jsonl`,
				getHeader: () => {
					onHeaderRead?.();
					return { parentSession: "/sessions/unused-parent.jsonl" };
				},
			},
			model: { id: "test/model" },
			setInterval: () => 0,
			clearTimer: () => {},
			ui: {
				theme: { fg: (_color: string, value: string) => value },
				setWidget: (_name: string, lines: unknown) => {
					if (Array.isArray(lines)) widgets.push(lines as string[]);
				},
			},
		});
		const createPi = () => {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			throughput({
				on: (event: string, handler: unknown) => {
					handlers.set(event, handler as (event: unknown, ctx: unknown) => void);
				},
				getThinkingLevel: () => "low",
			} as unknown as Parameters<typeof throughput>[0]);
			return handlers;
		};
		const mainContext = makeContext("main-session", "main", {
			kind: "main", id: "registry-main", name: "main", depth: 0,
		});
		const otherContext = makeContext("other-parent", "other-parent", {
			kind: "sub", id: "registry-other", name: "task", depth: 1, parentId: "registry-main",
		});
		let workerHeaderReads = 0;
		const workerContext = makeContext("worker-session", "worker-task", {
			kind: "sub", id: "registry-worker", name: "explore", depth: 4, parentId: "registry-main",
		}, () => workerHeaderReads++);
		const mainHandlers = createPi();
		const otherHandlers = createPi();
		const workerHandlers = createPi();
		const modeSessionsQueried: string[] = [];
		const stdout = process.stdout as NodeJS.WriteStream;
		const originalColumns = Object.getOwnPropertyDescriptor(stdout, "columns");
		try {
			mainHandlers.get("session_start")?.({}, mainContext);
			otherHandlers.get("session_start")?.({}, otherContext);
			otherHandlers.get("tool_call")?.(
				{ toolName: "task", input: { name: "worker-task", agent: "scout", mode: "orchestrate" } },
				otherContext,
			);
			mainHandlers.get("tool_call")?.(
				{ toolName: "task", input: { name: "worker-task", agent: "reviewer", mode: "brute" } },
				mainContext,
			);
			workerHandlers.get("session_start")?.({}, workerContext);
			expect(workerHeaderReads).toBe(0);
			workerHandlers.get("session_start")?.({}, workerContext);
			expect(workerHeaderReads).toBe(0);
			global[modeKey] = {
				mode: new Map([["worker-session", "brute"]]),
				getMode: (sessionId: string) => {
					modeSessionsQueried.push(sessionId);
					return "brute";
				},
				setMode: () => undefined,
				paint: () => "mode-chip",
			};
			mainHandlers.get("session_start")?.({}, mainContext);

			const registry = global[registryKey] as ThroughputRegistry;
			expect(registry.version).toBe(4);
			expect(registry.sessionByAgentId.get("registry-main")).toBe("main-session");
			expect(registry.sessions.get("main-session")).toMatchObject({
				role: "main",
				depth: 0,
				agent: "main",
			});
			expect(registry.pendingSpawns.size).toBe(1);
			expect(registry.pendingSpawns.get("other-parent:worker-task")?.[0]).toMatchObject({
				mode: "orchestrate",
			});
			expect(registry.sessions.get("other-parent")).toMatchObject({
				role: "worker",
				parentId: "main-session",
				depth: 1,
				agent: "task",
			});
			expect(registry.sessions.get("worker-session")).toMatchObject({
				role: "worker",
				parentId: "main-session",
				depth: 4,
				agent: "explore",
				mode: "brute",
			});
			for (const cols of [80, 100, 120]) {
				Object.defineProperty(stdout, "columns", { configurable: true, value: cols });
				mainHandlers.get("session_start")?.({}, mainContext);
				for (const line of widgets.at(-1) ?? []) {
					expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(cols);
				}
			}
			const currentRegistry = global[registryKey] as ThroughputRegistry;
			const rootWorker = currentRegistry.sessions.get("worker-session");
			expect(rootWorker?.parentResolved).toBe(true);
			let ancestor = rootWorker;
			for (let depth = 2; depth <= 6 && ancestor; depth++) {
				const child = throughputSession(`deep-${depth}`, "worker", currentRegistry.nextOrder++, {
					label: `deep-${depth}`,
					parentId: ancestor.sessionId,
					depth,
					parentResolved: true,
					updatedAt: Date.now(),
				});
				ancestor.children.push(child.sessionId);
				currentRegistry.sessions.set(child.sessionId, child);
				ancestor = child;
			}
			Object.defineProperty(stdout, "columns", { configurable: true, value: 80 });
			mainHandlers.get("session_start")?.({}, mainContext);
			expect(widgets.at(-1)?.some((line) => line.includes("…└─ deep-6"))).toBe(true);
			otherHandlers.get("session_shutdown")?.({}, otherContext);
			expect(currentRegistry.pendingSpawns.has("other-parent:worker-task")).toBe(false);
			expect(registry.sessions.get("main-session")?.children).toEqual(["worker-session"]);
			mainHandlers.get("session_start")?.({}, mainContext);
			expect(widgets.at(-1)?.some((line) => line.includes("└─ worker-t"))).toBe(true);
			expect(widgets.at(-1)?.some((line) => line.includes("🚀 | explore"))).toBe(true);
			expect(modeSessionsQueried).toContain("worker-session");

			const coreContext = makeContext("core-session", "CoreOrch", {
				kind: "sub", id: "registry-core", name: "task", depth: 1, parentId: "registry-main",
			});
			const coreHandlers = createPi();
			mainHandlers.get("tool_call")?.(
				{ toolName: "task", input: { name: "CoreOrch", agent: "task" } },
				mainContext,
			);
			coreHandlers.get("session_start")?.({}, coreContext);
			coreHandlers.get("tool_call")?.(
				{ toolName: "task", input: { name: "DocSpecialist", agent: "scout" } },
				coreContext,
			);
			const docContext = makeContext("doc-session", "CoreOrch.DocSpecialist", {
				kind: "sub", id: "registry-doc", name: "scout", depth: 2, parentId: "registry-core",
			});
			const docHandlers = createPi();
			docHandlers.get("session_start")?.({}, docContext);
			Object.defineProperty(stdout, "columns", { configurable: true, value: 120 });
			mainHandlers.get("session_start")?.({}, mainContext);
			const renderedRows = widgets.at(-1) ?? [];
			const docRow = renderedRows.find((line) => line.includes("DocSpecialist"));
			expect(docRow).toBeDefined();
			expect(docRow).not.toContain("CoreOrch.DocSpecialist");
			expect(renderedRows.slice(1).every((line) => !/\bidle\b|\bstall\b|\blive\b/.test(line))).toBe(true);
			for (const line of renderedRows) expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(120);
		} finally {
			workerHandlers.get("session_shutdown")?.({}, workerContext);
			otherHandlers.get("session_shutdown")?.({}, otherContext);
			mainHandlers.get("session_shutdown")?.({}, mainContext);
			if (originalColumns) Object.defineProperty(stdout, "columns", originalColumns);
			else Reflect.deleteProperty(stdout, "columns");
			if (previousRegistry === undefined) delete global[registryKey];
			else global[registryKey] = previousRegistry;
			if (previousModeRegistry === undefined) delete global[modeKey];
			else global[modeKey] = previousModeRegistry;
		}
	});

});

describe("Throughput UI timer lifecycle", () => {
	test("arms through the extension context and clears the prior timer across session switches", () => {
		const global = globalThis as Record<symbol, unknown>;
		const registryKey = Symbol.for("omp.throughput.registry.v4");
		const previousRegistry = global[registryKey];
		delete global[registryKey];
		const intervals: number[] = [];
		const cleared: number[] = [];
		let nextTimer = 1;
		const makeContext = (sessionId: string, name: string, agent: ExtensionContext["agent"]) => ({
			agent,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionName: () => name,
				getSessionFile: () => `/sessions/${sessionId}.jsonl`,
				getHeader: () => ({}),
			},
			model: { id: "test/model" },
			setInterval: () => {
				const id = nextTimer++;
				intervals.push(id);
				return id;
			},
			clearTimer: (timer: number) => {
				cleared.push(timer);
			},
			ui: {
				theme: { fg: (_color: string, value: string) => value },
				setWidget: () => {},
			},
		});
		// One instance shared across sessions mirrors a host that reuses the runner.
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		throughput({
			on: (event: string, handler: unknown) => {
				handlers.set(event, handler as (event: unknown, ctx: unknown) => void);
			},
			getThinkingLevel: () => "low",
		} as unknown as Parameters<typeof throughput>[0]);
		const mainContext = makeContext("timer-main", "main", {
			kind: "main", id: "registry-timer-main", name: "main", depth: 0,
		});
		const workerContext = makeContext("timer-worker", "worker", {
			kind: "sub", id: "registry-timer-worker", name: "task", depth: 1, parentId: "registry-timer-main",
		});
		try {
			handlers.get("session_start")?.({}, mainContext);
			expect(intervals).toEqual([1]);
			expect(cleared).toEqual([]);

			// A worker session does not arm or clear the main timer.
			handlers.get("session_start")?.({}, workerContext);
			expect(intervals).toEqual([1]);
			expect(cleared).toEqual([]);

			// Returning to the main session clears the previous timer before arming a new one.
			handlers.get("session_start")?.({}, mainContext);
			expect(cleared).toEqual([1]);
			expect(intervals).toEqual([1, 2]);

			handlers.get("session_shutdown")?.({}, mainContext);
			expect(cleared).toEqual([1, 2]);
		} finally {
			if (previousRegistry === undefined) delete global[registryKey];
			else global[registryKey] = previousRegistry;
		}
	});
});

describe("Throughput native spinner parity", () => {
	test("advances frames on OMP's 80ms status cadence", () => {
		expect(SPINNER_ADVANCE_MS).toBe(80);
		const frames = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
		expect(statusSpinnerFrame(frames.length, 0)).toBe(0);
		expect(statusSpinnerFrame(frames.length, 79)).toBe(0);
		expect(statusSpinnerFrame(frames.length, 80)).toBe(1);
		expect(statusSpinnerFrame(frames.length, 80 * frames.length)).toBe(0);
		expect(statusSpinnerFrame(0, 1234)).toBe(0);
	});

	test("renders running workers with the theme's own spinner frames", () => {
		const global = globalThis as Record<symbol, unknown>;
		const registryKey = Symbol.for("omp.throughput.registry.v4");
		const previousRegistry = global[registryKey];
		delete global[registryKey];
		const widgets: string[][] = [];
		const makeContext = (sessionId: string, name: string, agent: ExtensionContext["agent"]) => ({
			agent,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionName: () => name,
				getSessionFile: () => `/sessions/${sessionId}.jsonl`,
				getHeader: () => ({}),
			},
			model: { id: "test/model" },
			setInterval: () => 0,
			clearTimer: () => {},
			ui: {
				theme: { fg: (_color: string, value: string) => value, spinnerFrames: ["A", "B"] },
				setWidget: (_name: string, lines: unknown) => {
					if (Array.isArray(lines)) widgets.push(lines as string[]);
				},
			},
		});
		const createPi = () => {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			throughput({
				on: (event: string, handler: unknown) => {
					handlers.set(event, handler as (event: unknown, ctx: unknown) => void);
				},
				getThinkingLevel: () => "low",
			} as unknown as Parameters<typeof throughput>[0]);
			return handlers;
		};
		const mainContext = makeContext("spinner-main", "main", {
			kind: "main", id: "registry-spinner-main", name: "main", depth: 0,
		});
		const workerContext = makeContext("spinner-worker", "spinworker", {
			kind: "sub", id: "registry-spinner-worker", name: "task", depth: 1, parentId: "registry-spinner-main",
		});
		const mainHandlers = createPi();
		const workerHandlers = createPi();
		try {
			mainHandlers.get("session_start")?.({}, mainContext);
			workerHandlers.get("session_start")?.({}, workerContext);
			workerHandlers.get("message_start")?.({ message: { role: "assistant" } }, workerContext);
			mainHandlers.get("session_start")?.({}, mainContext);
			const rows = widgets.at(-1) ?? [];
			const workerRow = rows.find((line) => line.includes("spinworker"));
			expect(workerRow).toBeDefined();
			expect(["A", "B"]).toContain(workerRow?.[0]);
		} finally {
			workerHandlers.get("session_shutdown")?.({}, workerContext);
			mainHandlers.get("session_shutdown")?.({}, mainContext);
			if (previousRegistry === undefined) delete global[registryKey];
			else global[registryKey] = previousRegistry;
		}
	});
});
