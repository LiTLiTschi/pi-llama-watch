import { describe, test, expect } from "vitest";
import { formatProcessing, formatGenerating, formatState } from "./format";
import type { LlamaStateData } from "./LlamaState";

describe("formatProcessing", () => {
	test("returns percentage string for 0.88 progress", () => {
		expect(formatProcessing(0.88)).toBe("88%");
	});

	test("returns percentage string for 0.5 progress", () => {
		expect(formatProcessing(0.5)).toBe("50%");
	});

	test("returns percentage string for 0.005 progress (rounds up)", () => {
		expect(formatProcessing(0.005)).toBe("1%");
	});

	test("returns 100% for progress >= 1.0", () => {
		expect(formatProcessing(1.0)).toBe("100%");
		expect(formatProcessing(1.5)).toBe("100%");
	});

	test("returns 0% for progress <= 0", () => {
		expect(formatProcessing(0)).toBe("0%");
		expect(formatProcessing(-0.1)).toBe("0%");
	});

	test("rounds down for non-exact percentages", () => {
		expect(formatProcessing(0.884)).toBe("88%");
		expect(formatProcessing(0.885)).toBe("89%");
	});
});

describe("formatGenerating", () => {
	test("returns tokens per second string for 25", () => {
		expect(formatGenerating(25)).toBe("25t/s");
	});

	test("returns tokens per second string for 1", () => {
		expect(formatGenerating(1)).toBe("1t/s");
	});

	test("returns tokens per second string for 10.5", () => {
		expect(formatGenerating(10.5)).toBe("11t/s");
	});

	test("returns 0t/s for 0 speed", () => {
		expect(formatGenerating(0)).toBe("0t/s");
	});

	test("rounds to nearest integer", () => {
		expect(formatGenerating(10.4)).toBe("10t/s");
		expect(formatGenerating(10.6)).toBe("11t/s");
	});
});

describe("formatState", () => {
	test("returns em-dash for idle state", () => {
		const state: LlamaStateData = {
			type: "idle",
			slots: [],
			aggregated: { displayPrefix: null, displayValue: "" },
		};
		expect(formatState(state)).toBe("—");
	});

	test("returns displayValue for processing state", () => {
		const state: LlamaStateData = {
			type: "processing",
			slots: [{ slotId: 1, type: "processing", progress: 0.88 }],
			aggregated: { displayPrefix: null, displayValue: "88%" },
		};
		expect(formatState(state)).toBe("88%");
	});

	test("returns displayValue for generating state", () => {
		const state: LlamaStateData = {
			type: "generating",
			slots: [
				{
					slotId: 1,
					type: "generating",
					tokensDecoded: 100,
					tokensRemaining: 50,
				},
			],
			aggregated: { displayPrefix: null, displayValue: "25t/s" },
		};
		expect(formatState(state)).toBe("25t/s");
	});

	test("returns em-dash when displayValue is empty string", () => {
		const state: LlamaStateData = {
			type: "processing",
			slots: [],
			aggregated: { displayPrefix: null, displayValue: "" },
		};
		expect(formatState(state)).toBe("—");
	});
});
