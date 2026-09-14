import { describe, expect, test } from "bun:test";
import { replaceConstitution, spliceConstitution, spliceMode } from "./index.ts";

const FENCES = `<system-conventions>
rules
</system-conventions>

body

<personality>
voice
</personality>`;

const NEXT = `<system-conventions>
next
</system-conventions>

replaced

<personality>
other
</personality>`;

const FINGERPRINT = "Dispatcher for this Oh My Pi session. Specialists do the work. You do not.";

describe("session-mode constitution splice", () => {
	test("normal is a no-op and does not read mode files", () => {
		expect(spliceMode([FENCES], "normal")).toBeUndefined();
	});

	test("replaceConstitution swaps between the two fences", () => {
		expect(replaceConstitution(`prefix\n${FENCES}\nsuffix`, NEXT)).toBe(`prefix\n${NEXT}\nsuffix`);
	});

	test("missing fences stay put and do not wrap", () => {
		const prompt = ["no fences here"];
		const result = spliceConstitution(prompt, NEXT, FINGERPRINT);
		expect(result).toEqual({ error: "session-mode: constitution markers not found in systemPrompt" });
		expect(prompt).toEqual(["no fences here"]);
	});

	test("already-applied fingerprint skips the splice", () => {
		expect(spliceConstitution([`${FENCES}\n${FINGERPRINT}`], NEXT, FINGERPRINT)).toBeUndefined();
	});

	test("fenced prompt is replaced in place", () => {
		const result = spliceConstitution(["keep", FENCES, "keep"], NEXT, FINGERPRINT);
		expect(result).toEqual({ systemPrompt: ["keep", NEXT, "keep"] });
	});
});
