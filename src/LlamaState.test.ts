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

	test("parseSlotResponse: multiple generating slots shows all", () => {
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
		// Both slots shown, sorted by slotId asc
		expect(state.aggregated.displayValue).toBe("100t/s, 200t/s");
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
				params: { n_predict: 0 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("idle");
		ls.stop();
	});

	test("parseSlotResponse: handles malformed slot data gracefully", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				// next_token missing
			} as any,
		});
		const state = ls.getState();
		expect(state.type).toBeDefined();
		expect(Array.isArray(state.slots)).toBe(true);
		expect(state.aggregated).toBeDefined();
		ls.stop();
	});

	test("parseSlotResponse: computes TPS for generating slots across polls", () => {
		const ls = new LlamaState(8080);
		let fakeTime = 1000000;
		vi.spyOn(Date, "now").mockImplementation(() => fakeTime);

		// First poll: slot generates 50 tokens
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				next_token: [{ n_decoded: 50, n_remain: 206 }],
				params: { n_predict: 256 },
			},
		});

		// Advance time by 2 seconds
		fakeTime += 2000;

		// Second poll: slot generates 150 more tokens (total 200)
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				next_token: [{ n_decoded: 200, n_remain: 56 }],
				params: { n_predict: 256 },
			},
		});

		const state = ls.getState();
		expect(state.slots[0].tokensPerSecond).toBe(75);
		expect(state.aggregated.displayValue).toBe("75t/s");
		ls.stop();
	});

	test("parseSlotResponse: TPS is undefined on first poll", () => {
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
		expect(state.slots[0].tokensPerSecond).toBeUndefined();
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
		expect(state.slots[0].progress).toBe(0.9);
		ls.stop();
	});

	test("parseSlotResponse: multiple processing slots shows all percentages", () => {
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
		expect(state.aggregated.displayValue).toBe("50%, 20%");
		ls.stop();
	});

	test("parseSlotResponse: many generating slots truncates with +N", () => {
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
			"2": {
				id: 2,
				is_processing: true,
				next_token: [{ n_decoded: 150, n_remain: 50 }],
				params: { n_predict: 200 },
			},
			"3": {
				id: 3,
				is_processing: true,
				next_token: [{ n_decoded: 50, n_remain: 50 }],
				params: { n_predict: 100 },
			},
			"4": {
				id: 4,
				is_processing: true,
				next_token: [{ n_decoded: 30, n_remain: 20 }],
				params: { n_predict: 50 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("generating");
		expect(state.slots).toHaveLength(5);
		// Shows top 2 + "+3 remaining"
		expect(state.aggregated.displayValue).toBe("100t/s, 200t/s, +3");
		ls.stop();
	});

	test("parseSlotResponse: many processing slots truncates with +N", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 10 }],
				params: { n_predict: 100 },
			},
			"1": {
				id: 1,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 50 }],
				params: { n_predict: 100 },
			},
			"2": {
				id: 2,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 80 }],
				params: { n_predict: 100 },
			},
			"3": {
				id: 3,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 90 }],
				params: { n_predict: 100 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("processing");
		expect(state.slots).toHaveLength(4);
		// Shows top 2 + "+2 remaining"
		expect(state.aggregated.displayValue).toBe("90%, 50%, +2");
		ls.stop();
	});

	test("parseSlotResponse: inactive slot shows as [-] between active slots", () => {
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
				is_processing: false,
				next_token: [{ n_decoded: 0, n_remain: 0 }],
				params: { n_predict: 0 },
			},
			"2": {
				id: 2,
				is_processing: true,
				next_token: [{ n_decoded: 50, n_remain: 50 }],
				params: { n_predict: 100 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("generating");
		expect(state.slots).toHaveLength(3);
		// Active + inactive + active
		expect(state.aggregated.displayValue).toBe("100t/s, -, 50t/s");
		ls.stop();
	});

	test("parseSlotResponse: all slots inactive shows all idle", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: false,
				next_token: [{ n_decoded: 0, n_remain: 0 }],
				params: { n_predict: 0 },
			},
			"1": {
				id: 1,
				is_processing: false,
				next_token: [{ n_decoded: 0, n_remain: 0 }],
				params: { n_predict: 0 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("idle");
		expect(state.slots).toHaveLength(2);
		expect(state.aggregated.displayValue).toBe("-, -");
		ls.stop();
	});

	test("parseSlotResponse: single active generating among inactive", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: false,
				next_token: [{ n_decoded: 0, n_remain: 0 }],
				params: { n_predict: 0 },
			},
			"1": {
				id: 1,
				is_processing: true,
				next_token: [{ n_decoded: 75, n_remain: 50 }],
				params: { n_predict: 125 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("generating");
		expect(state.slots).toHaveLength(2);
		expect(state.aggregated.displayValue).toBe("-, 75t/s");
		ls.stop();
	});

	test("parseSlotResponse: single active processing among inactive", () => {
		const ls = new LlamaState(8080);
		ls["parseSlotResponse"]({
			"0": {
				id: 0,
				is_processing: false,
				next_token: [{ n_decoded: 0, n_remain: 0 }],
				params: { n_predict: 0 },
			},
			"1": {
				id: 1,
				is_processing: true,
				next_token: [{ n_decoded: 0, n_remain: 50 }],
				params: { n_predict: 100 },
			},
		});
		const state = ls.getState();
		expect(state.type).toBe("processing");
		expect(state.slots).toHaveLength(2);
		expect(state.aggregated.displayValue).toBe("-, 50%");
		ls.stop();
	});
});
