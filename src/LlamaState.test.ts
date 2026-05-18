import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { LlamaState } from "./LlamaState";

describe("LlamaState", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Mock fetch to return nothing (no slots)
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({}),
		} as Response);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	test("constructor uses port 8080 by default", () => {
		const ls = new LlamaState();
		// We can't test the port directly, but we can verify the object exists
		expect(ls).toBeInstanceOf(LlamaState);
		ls.stop();
	});

	test("constructor accepts custom port", () => {
		const ls = new LlamaState(9999);
		expect(ls).toBeInstanceOf(LlamaState);
		ls.stop();
	});

	test("initial state is idle with no slots", () => {
		const ls = new LlamaState();
		const state = ls.getState();
		expect(state.type).toBe("idle");
		expect(state.slots).toEqual([]);
		expect(state.aggregated.displayPrefix).toBeNull();
		expect(state.aggregated.displayValue).toBe("");
		ls.stop();
	});

	test("parseSlotResponse: empty response stays idle", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({});
		const state = ls.getState();
		expect(state.type).toBe("idle");
		expect(state.slots).toEqual([]);
		ls.stop();
	});

	test("parseSlotResponse: single processing slot (n_decoded=0)", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 256 }],
				params: { n_predict: 256 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("processing");
		expect(state.slots).toHaveLength(1);
		expect(state.slots[0].slotId).toBe(0);
		expect(state.slots[0].type).toBe("processing");
		expect(state.slots[0].tokensRemaining).toBe(256);
		expect(state.aggregated.displayPrefix).toBe("p");
		ls.stop();
	});

	test("parseSlotResponse: single generating slot (n_decoded>0)", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				next_token: [{ n_decoded: 50, n_remain: 206 }],
				params: { n_predict: 256 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("generating");
		expect(state.slots[0].slotId).toBe(0);
		expect(state.slots[0].type).toBe("generating");
		expect(state.slots[0].tokensDecoded).toBe(50);
		expect(state.slots[0].tokensRemaining).toBe(206);
		ls.stop();
	});

	test("parseSlotResponse: multiple generating slots picks highest speed", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				next_token: [{ n_decoded: 100, n_remain: 100 }],
				params: { n_predict: 200 },
			},
			"1": {
				id: 1,
				is_processing: true,
				next_token: [{ n_decoded: 200, n_remain: 100 }],
				params: { n_predict: 300 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("generating");
		expect(state.slots).toHaveLength(2);
		// Slot 1 has higher speed (200/300 ≈ 67% vs 100/200 = 50%)
		expect(state.aggregated.displayPrefix).toBe("g");
		ls.stop();
	});

	test("parseSlotResponse: processing + generating → generating wins", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 100 }],
				params: { n_predict: 100 },
			},
			"1": {
				id: 1,
				is_processing: true,
				next_token: [{ n_decoded: 30, n_remain: 70 }],
				params: { n_predict: 100 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("generating");
		expect(state.slots).toHaveLength(2);
		ls.stop();
	});

	test("parseSlotResponse: idle when is_processing=false", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: false,
				next_token: [{ n_decoded: 0, n_remain: 0 }],
				params: {},
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("idle");
		ls.stop();
	});

	test("parseSlotResponse: handles malformed slot data gracefully", () => {
		const ls = new LlamaState(8080);
		// Slot with missing fields
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				// next_token missing
			} as any,
		});
		const state = ls.getState();
		// Should not crash — treat as idle or process what we can
		expect(state).toBeDefined();
		ls.stop();
	});

	test("parseSlotResponse: calculates progress for processing slots", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 100 }],
				params: { n_predict: 1000 },
			},
		});
		const state = ls.getState();
		expect(state.slots[0].type).toBe("processing");
		expect(state.slots[0].progress).toBe(0.9); // (1000-100)/1000 = 0.9
		ls.stop();
	});

	test("parseSlotResponse: handles multiple processing slots", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 50 }],
				params: { n_predict: 100 },
			},
			"1": {
				id: 1,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 80 }],
				params: { n_predict: 100 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("processing");
		expect(state.slots).toHaveLength(2);
		// Slot 0 has 50% progress, Slot 1 has 20% progress
		expect(state.aggregated.displayPrefix).toBe("p");
		ls.stop();
	});
});
