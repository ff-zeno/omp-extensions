import { describe, expect, test } from "bun:test";
import {
	applyAssistantProgress,
	callTps,
	effectiveStreamTokens,
	eventDeltaChars,
	generationWindowMs,
	getSparkHistory,
	resolveMessageTokens,
	type TokenProgress,
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
