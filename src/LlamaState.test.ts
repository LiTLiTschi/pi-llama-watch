import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { LlamaState } from "./LlamaState";

// Mock child_process
vi.mock("child_process", () => ({
	exec: vi.fn(),
}));

// Import the mocked exec
import { exec } from "child_process";

describe("LlamaState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test("initial state is idle with no slots", () => {
		const ls = new LlamaState();
		const state = ls.getState();
		expect(state.type).toBe("idle");
		expect(state.slots).toEqual([]);
		expect(state.aggregated.displayValue).toBe("");
		ls.stop();
	});

	test("poll updates state from shell output", async () => {
		const ls = new LlamaState();
		
		const mockJson = JSON.stringify({
			ram: { used: "10.0", total: "32.0", avail: "22.0" },
			gpu: "5.00/8.00",
			slots: [
				{ id: 0, type: "processing", progress: 0.5, eta: "~1m30s" },
				{ id: 1, type: "generating", progress: 0.2, decoded: 100, total: 500, tps: 10.5, eta: "~40s" }
			]
		});

		(exec as any).mockImplementation((_cmd, _opts, callback) => {
			callback(null, { stdout: mockJson });
		});

		// Trigger poll manually via private method or just wait for interval
		await (ls as any).poll();

		const state = ls.getState();
		expect(state.type).toBe("generating");
		expect(state.slots).toHaveLength(2);
		expect(state.slots[0].type).toBe("processing");
		expect(state.slots[1].type).toBe("generating");
		expect(state.slots[1].tokensPerSecond).toBe(10.5);
		expect(state.aggregated.displayValue).toBe("50%, 11t/s");
		expect(state.ram?.used).toBe("10.0");
		expect(state.gpu).toBe("5.00/8.00");
		ls.stop();
	});

	test("poll handles error gracefully", async () => {
		const ls = new LlamaState();
		
		(exec as any).mockImplementation((_cmd, _opts, callback) => {
			callback(new Error("Command failed"), null);
		});

		const initialState = ls.getState();
		await (ls as any).poll();
		const state = ls.getState();
		
		// State should remain unchanged on error
		expect(state).toEqual(initialState);
		ls.stop();
	});

	test("formatCompact works for various counts", () => {
		const ls = new LlamaState();
		expect((ls as any).formatCompact([])).toBe("all idle");
		expect((ls as any).formatCompact(["1t/s"])).toBe("1t/s");
		expect((ls as any).formatCompact(["1t/s", "2t/s", "3t/s"])).toBe("1t/s, 2t/s, 3t/s");
		expect((ls as any).formatCompact(["1t/s", "2t/s", "3t/s", "4t/s"])).toBe("1t/s, 2t/s, +2");
		ls.stop();
	});
});
