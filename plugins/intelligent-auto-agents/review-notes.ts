// Per-model review notes, added inside each returned `<task-result>` block in the coordinator's context.
// Data lives in review-notes.json; IAA_REVIEW_NOTE_OVERRIDES switches entries per run.
// The `model`, `effort` and `fallback` envelope attributes come from the patched OMP (core/PATCHING.md).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { matchesPattern, modelKey } from "./guidance";

export type ReviewNote = {
	id: string;
	enabled: boolean;
	family: string;
	patterns: string[];
	displayName: string;
	checks: { text: string; evidence: string[] }[];
};

export type ReviewNotes = {
	overridesEnv: string;
	notes: ReviewNote[];
	/** Override IDs that name nothing in the data; reported, never fatal. */
	unknownOverrides: string[];
};

const RESULT_BLOCK = /<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/g;
// The note always sits directly before `</task-result>`, so child output (inside `<output>`) cannot fake it.
const EXISTING_NOTE = /<review-note\b[^>]*>[^<]*<\/review-note>\n?$/;
const EVIDENCE_ID = /^MT-\d{3}$/;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function fail(message: string): never {
	throw new Error(`review-notes.json: ${message}`);
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
	const overrides: Record<string, boolean> = {};
	for (const [id, on] of Object.entries(parsed)) {
		if (typeof on !== "boolean") fail(`override ${id} must be true or false`);
		overrides[id] = on;
	}
	return overrides;
}

/**
 * Validate review-note data and apply per-run overrides. Family names resolve against this file's
 * `families` first, then guidance.json's, so both files share one pattern grammar and matcher.
 */
export function parseReviewNotes(
	raw: unknown,
	guidanceFamilies: Record<string, readonly string[]>,
	overridesJson: string | undefined,
): ReviewNotes {
	if (!record(raw)) fail("root must be an object");
	if (!nonEmptyText(raw.overridesEnv)) fail("overridesEnv is required");
	if (!record(raw.families)) fail("families must be an object");
	if (!record(raw.notes)) fail("notes must be an object keyed by family");
	const families: Record<string, string[]> = {};
	for (const [name, patterns] of Object.entries(guidanceFamilies)) families[name] = [...patterns];
	for (const [name, patterns] of Object.entries(raw.families)) {
		if (name in guidanceFamilies) fail(`family ${name} is already defined in guidance.json`);
		if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every(nonEmptyText))
			fail(`family ${name} needs model patterns`);
		families[name] = patterns.map(pattern => pattern.toLowerCase());
	}

	const overrides = parseOverrides(overridesJson);
	const known = new Set<string>();
	const notes: ReviewNote[] = [];
	for (const [family, entry] of Object.entries(raw.notes)) {
		if (!record(entry) || !nonEmptyText(entry.id)) fail(`note for ${family} needs an id`);
		const id = entry.id;
		if (known.has(id)) fail(`duplicate ID ${id}`);
		known.add(id);
		if (typeof entry.enabled !== "boolean") fail(`${id}.enabled must be a boolean`);
		const patterns = families[family];
		if (!patterns) fail(`${id} names unknown family ${family}`);
		if (!nonEmptyText(entry.displayName)) fail(`${id} needs displayName`);
		if (!Array.isArray(entry.checks) || entry.checks.length < 1 || entry.checks.length > 5)
			fail(`${id} needs 1 to 5 checks`);
		const checks = entry.checks.map((check, index) => {
			if (!record(check) || !nonEmptyText(check.text)) fail(`${id} check ${index} needs text`);
			const evidence = check.evidence;
			if (!Array.isArray(evidence) || evidence.length === 0 || !evidence.every(e => typeof e === "string" && EVIDENCE_ID.test(e)))
				fail(`${id} check ${index} needs MT-xxx evidence`);
			return { text: check.text.trim(), evidence: evidence.filter(nonEmptyText) };
		});
		notes.push({
			id,
			enabled: overrides[id] ?? entry.enabled,
			family,
			patterns,
			displayName: entry.displayName,
			checks,
		});
	}
	return {
		overridesEnv: raw.overridesEnv,
		notes,
		unknownOverrides: Object.keys(overrides).filter(id => !known.has(id)),
	};
}

function attribute(attrs: string, name: string): string | undefined {
	return new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
}

function noteFor(notes: ReviewNotes, model: string): ReviewNote | undefined {
	const key = modelKey(model);
	return notes.notes.find(note => note.enabled && note.patterns.some(pattern => matchesPattern(pattern, key)));
}

/** Text a coordinator reads before accepting a result from `model`; undefined when no enabled entry matches. */
export function renderReviewNote(notes: ReviewNotes, model: string, effort?: string, fallback = false): string | undefined {
	const note = noteFor(notes, model);
	if (!note) return undefined;
	const who = `${note.displayName}${effort ? ` (${effort})` : ""}${fallback ? "; a fallback replaced the routed model" : ""}`;
	const checks = note.checks.map(check => (/[.!?]$/.test(check.text) ? check.text : `${check.text}.`)).join(" ");
	return `<review-note model="${model}">Returned by ${who}. Before you accept: ${checks}</review-note>`;
}

function annotate(text: string, notes: ReviewNotes): string {
	return text.replace(RESULT_BLOCK, (block, attrs: string, body: string) => {
		const model = attribute(attrs, "model");
		if (!model || EXISTING_NOTE.test(body)) return block;
		const note = renderReviewNote(notes, model, attribute(attrs, "effort"), attribute(attrs, "fallback") === "true");
		if (!note) return block;
		const separator = body.endsWith("\n") ? "" : "\n";
		return `<task-result${attrs}>${body}${separator}${note}\n</task-result>`;
	});
}

function carriesTaskResults(message: Record<string, unknown>): boolean {
	if (message.role === "toolResult") return message.toolName === "task" || message.toolName === "wait";
	return message.role === "custom" && message.customType === "async-result";
}

function annotateContent(content: unknown, notes: ReviewNotes): unknown {
	if (typeof content === "string") {
		const next = annotate(content, notes);
		return next === content ? content : next;
	}
	if (!Array.isArray(content)) return content;
	let changed = false;
	const parts = content.map(part => {
		if (!record(part) || part.type !== "text" || typeof part.text !== "string") return part;
		const text = annotate(part.text, notes);
		if (text === part.text) return part;
		changed = true;
		return { ...part, text };
	});
	return changed ? parts : content;
}

/**
 * Add a review note inside every returned `<task-result>` block whose `model` matches an enabled entry.
 * Returns the same array when nothing changed; never touches messages other than task, wait and
 * async-result deliveries, or blocks without a `model` attribute.
 */
export function addReviewNotes<T>(messages: readonly T[], notes: ReviewNotes): readonly T[] {
	if (!notes.notes.some(note => note.enabled)) return messages;
	let changed = false;
	const next = messages.map(message => {
		if (!record(message) || !carriesTaskResults(message)) return message;
		const content = annotateContent(message.content, notes);
		if (content === message.content) return message;
		changed = true;
		return { ...message, content } as T;
	});
	return changed ? next : messages;
}

/**
 * Registered in every session: a child's context holds `<task-result>` blocks only for agents it
 * spawned itself, so a coordinator child gets notes for its own workers and a leaf gets none.
 */
export function registerReviewNotes(pi: ExtensionAPI, notes: ReviewNotes): void {
	if (notes.unknownOverrides.length > 0)
		pi.logger.warn(`${notes.overridesEnv} names unknown IDs: ${notes.unknownOverrides.join(", ")}`);
	if (!notes.notes.some(note => note.enabled)) return;
	pi.on("context", event => {
		const messages = addReviewNotes(event.messages, notes);
		return messages === event.messages ? undefined : { messages: [...messages] };
	});
}
