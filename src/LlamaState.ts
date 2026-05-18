export type LlamaStateType = "idle" | "processing" | "generating";

export interface SlotInfo {
	slotId: number;
	type: LlamaStateType;
	progress?: number;
	tokensDecoded?: number;
	tokensRemaining?: number;
	tokensPredicted?: number;
	tokensPerSecond?: number;
}

export interface LlamaStateData {
	type: LlamaStateType;
	slots: SlotInfo[];
	aggregated: {
		displayPrefix: "p" | "g" | null;
		displayValue: string;
	};
}

export interface RawSlot {
	id: number;
	is_processing: boolean;
	next_token?: { n_decoded: number; n_remain: number }[];
	params?: { n_predict: number };
}

export interface RawSlots {
	[key: string]: RawSlot;
}

// Internal tracking for per-slot TPS computation
interface SlotHistory {
	decoded: number;
	timestamp: number;
}

export class LlamaState {
	private port: number;
	private intervalMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private currentData: LlamaStateData = {
		type: "idle",
		slots: [],
		aggregated: { displayPrefix: null, displayValue: "" },
	};
	// Per-slot history for TPS calculation
	private history: Map<number, SlotHistory> = new Map();

	constructor(port: number = 8080, intervalMs: number = 1000) {
		this.port = port;
		this.intervalMs = intervalMs;
	}

	getState(): LlamaStateData {
		return this.currentData;
	}

	start(): void {
		this.stop();
		this.timer = setInterval(() => this.poll(), this.intervalMs);
		this.poll();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.history.clear();
	}

	private async poll(): Promise<void> {
		try {
			const resp = await fetch(`http://127.0.0.1:${this.port}/slots`);
			if (!resp.ok) {
				return;
			}
			const data: RawSlots = await resp.json();
			this.parseSlotResponse(data);
		} catch {
			// Network error — keep current state
		}
	}

	// Exposed for testing; in production called from poll()
	parseSlotResponse(data: RawSlots): void {
		const now = Date.now();
		const slots: SlotInfo[] = [];
		const currentSlotIds = new Set<number>();

		for (const [, slot] of Object.entries(data)) {
			if (!slot.is_processing) {
				continue;
			}

			const decoded = slot.next_token?.[0]?.n_decoded ?? 0;
			const remaining = slot.next_token?.[0]?.n_remain ?? 0;
			const predicted =
				slot.params?.n_predict ?? decoded + remaining;

			const type: LlamaStateType =
				decoded > 0 ? "generating" : "processing";

			const progress =
				type === "processing"
					? predicted > 0
						? (predicted - remaining) / predicted
						: 0
					: undefined;

			// Compute TPS for generating slots
			let tps: number | undefined;
			if (type === "generating" && decoded > 0) {
				const hist = this.history.get(slot.id);
				if (hist) {
					const elapsedSec = (now - hist.timestamp) / 1000;
					const decodedDelta = decoded - hist.decoded;
					if (elapsedSec > 0 && decodedDelta > 0) {
						tps = decodedDelta / elapsedSec;
					}
				}
			}

			// Update history
			this.history.set(slot.id, { decoded, timestamp: now });
			currentSlotIds.add(slot.id);

			slots.push({
				slotId: slot.id,
				type,
				progress,
				tokensDecoded: decoded,
				tokensRemaining: remaining,
				tokensPredicted: predicted,
				tokensPerSecond: tps,
			});
		}

		// Remove history for slots no longer active
		for (const id of this.history.keys()) {
			if (!currentSlotIds.has(id)) {
				this.history.delete(id);
			}
		}

		// Determine aggregated display
		let type: LlamaStateType = "idle";
		let displayPrefix: "p" | "g" | null = null;
		let displayValue = "";

		if (slots.length === 0) {
			type = "idle";
		} else {
			const hasGenerating = slots.some((s) => s.type === "generating");
			if (hasGenerating) {
				type = "generating";
				displayPrefix = "g";
				// Pick generating slot with highest actual TPS
				const genSlots = slots.filter((s) => s.type === "generating");
				const top = genSlots.reduce(
					(a, b) =>
						(a.tokensPerSecond ?? 0) >=
						(b.tokensPerSecond ?? 0)
							? a
							: b,
				);
				// Show TPS if we have a measurement, otherwise show raw decoded count
				if (top.tokensPerSecond) {
					displayValue = `${Math.round(top.tokensPerSecond)}t/s`;
				} else {
					displayValue = `${top.tokensDecoded}`;
				}
			} else {
				type = "processing";
				displayPrefix = "p";
				const top = slots.reduce(
					(a, b) =>
						(a.progress ?? 0) >= (b.progress ?? 0) ? a : b,
				);
				displayValue = top.progress
					? `${Math.round(top.progress * 100)}%`
					: "0%";
			}
		}

		this.currentData = {
			type,
			slots,
			aggregated: { displayPrefix, displayValue },
		};
	}
}
