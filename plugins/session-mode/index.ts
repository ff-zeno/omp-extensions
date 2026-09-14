// Session mode cycle (Alt+O / /orch): normal → orchestrate → brute.
// Independent of the Ctrl+P model cycle.
// Never writes SYSTEM.md or any SYSTEM*.md.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type SessionMode = "normal" | "orchestrate" | "brute";
export type SpliceResult = { systemPrompt: string[] } | { error: string } | undefined;

const SUBAGENT_MARKER = "You are operating on a piece of work assigned to you by the main agent";
const REGISTRY_KEY = Symbol.for("omp.session-mode.v1");
const CYCLE: SessionMode[] = ["normal", "orchestrate", "brute"];
const ORCHESTRATE_PALETTE = [43, 44, 45, 80, 81, 147, 141, 135, 99, 98];
const BRUTE_PALETTE = [196, 202, 208, 214, 166, 160, 203, 209, 215, 172];
const MODE_LABEL: Record<SessionMode, string> = {
	normal: "normal",
	orchestrate: "orchestrate",
	brute: "brute",
};
const MODE_PALETTE: Record<SessionMode, number[] | null> = {
	normal: null,
	orchestrate: ORCHESTRATE_PALETTE,
	brute: BRUTE_PALETTE,
};
const MODE_NOTIFY: Record<SessionMode, string> = {
	normal: "Mode: normal",
	orchestrate: "Mode: orchestrate",
	brute: "Mode: brute",
};
const MODE_FILES: Record<Exclude<SessionMode, "normal">, string> = {
	orchestrate: "SYSTEM.orchestrate.md",
	brute: "SYSTEM.brute.md",
};
const CONSTITUTION_START = "<system-conventions>";
const CONSTITUTION_END = "</personality>";
const MODE_FINGERPRINT: Record<Exclude<SessionMode, "normal">, string> = {
	orchestrate: "Dispatcher for this Oh My Pi session. Specialists do the work. You do not.",
	brute: "Execute the user's asked action in this Oh My Pi session.",
};

interface Registry {
	mode: Map<string, SessionMode>;
	paint(sessionId: string, tick: number): string;
}

function getRegistry(): Registry {
	const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
	g[REGISTRY_KEY] ??= { mode: new Map(), paint };
	g[REGISTRY_KEY].paint = paint;
	return g[REGISTRY_KEY];
}

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function currentMode(id: string): SessionMode {
	return getRegistry().mode.get(id) ?? "normal";
}

function paintWord(word: string, palette: number[] | null, tick: number): string {
	if (!palette) return `\x1b[38;5;245m${word}\x1b[0m`;
	return [...word]
		.map((ch, i) => {
			const color = palette[(i + tick) % palette.length];
			return `\x1b[38;5;${color}m${ch}\x1b[0m`;
		})
		.join("");
}

function paint(id: string, tick: number): string {
	const mode = currentMode(id);
	return paintWord(MODE_LABEL[mode], MODE_PALETTE[mode], tick);
}

function setMode(id: string, mode: SessionMode): void {
	const registry = getRegistry();
	if (mode === "normal") registry.mode.delete(id);
	else registry.mode.set(id, mode);
}

function cycle(ctx: ExtensionContext): void {
	const id = sessionId(ctx);
	const next = CYCLE[(CYCLE.indexOf(currentMode(id)) + 1) % CYCLE.length];
	setMode(id, next);
	if (ctx.hasUI) ctx.ui.notify(MODE_NOTIFY[next], "info");
}

export function readModeBody(mode: Exclude<SessionMode, "normal">, here = dirname(fileURLToPath(import.meta.url))): string | undefined {
	const name = MODE_FILES[mode];
	const paths = [join(homedir(), ".omp", "agent", name), join(here, name)];
	for (const p of paths) {
		try {
			return readFileSync(p, "utf8").replaceAll("\r\n", "\n").trimEnd();
		} catch {
			continue;
		}
	}
	return undefined;
}

export function replaceConstitution(haystack: string, next: string): string | undefined {
	const start = haystack.indexOf(CONSTITUTION_START);
	const end = haystack.indexOf(CONSTITUTION_END, start);
	if (start < 0 || end < 0) return undefined;
	return haystack.slice(0, start) + next + haystack.slice(end + CONSTITUTION_END.length);
}

export function spliceConstitution(systemPrompt: string[], next: string, fingerprint: string): SpliceResult {
	if (systemPrompt.some((block) => block.includes(fingerprint))) return undefined;
	for (let i = 0; i < systemPrompt.length; i++) {
		const spliced = replaceConstitution(systemPrompt[i] ?? "", next);
		if (!spliced) continue;
		return { systemPrompt: systemPrompt.map((block, j) => (j === i ? spliced : block)) };
	}
	const joined = systemPrompt.join("\n");
	const spliced = replaceConstitution(joined, next);
	if (spliced) return { systemPrompt: [spliced] };
	return { error: "session-mode: constitution markers not found in systemPrompt" };
}

export function spliceMode(systemPrompt: string[], target: SessionMode, here?: string): SpliceResult {
	if (target === "normal") return undefined;
	const next = readModeBody(target, here);
	if (next === undefined) return { error: `session-mode: missing ${MODE_FILES[target]}` };
	return spliceConstitution(systemPrompt, next, MODE_FINGERPRINT[target]);
}

export default function sessionMode(pi: ExtensionAPI): void {
	getRegistry();
	pi.registerShortcut("alt+o", {
		description: "Cycle session mode: normal → orchestrate → brute",
		handler: cycle,
	});

	pi.registerCommand("orch", {
		description: "Cycle session mode: normal → orchestrate → brute (Alt+O)",
		handler: async (_args, ctx) => {
			cycle(ctx);
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		getRegistry().mode.delete(sessionId(ctx));
	});

	pi.on("before_agent_start", (event, ctx) => {
		const systemPrompt = event.systemPrompt ?? ctx.getSystemPrompt() ?? [];
		if (systemPrompt.some((block) => block.includes(SUBAGENT_MARKER))) return;
		const mode = currentMode(sessionId(ctx));
		if (mode === "normal") return;
		const result = spliceMode(systemPrompt, mode);
		if (!result) return;
		if ("error" in result) {
			if (ctx.hasUI) ctx.ui.notify(result.error, "warning");
			return;
		}
		return { systemPrompt: result.systemPrompt };
	});
}
