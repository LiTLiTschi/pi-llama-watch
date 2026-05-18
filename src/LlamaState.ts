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
		const inactiveSlotIds = new Set<number>();
		const currentSlotIds = new Set<number>();

		// First pass: collect all slot IDs from the API
		const allSlotIds = new Set<number>();
		for (const [, slot] of Object.entries(data)) {
			allSlotIds.add(slot.id);
		}

		// Second pass: process active slots
		for (const [, slot] of Object.entries(data)) {
			if (!slot.is_processing) {
				inactiveSlotIds.add(slot.id);
				continue;
			}

			const decoded = slot.next_token?.[0]?.n_decoded ?? 0;
			const remaining = slot.next_token?.[0]?.n_remain ?? 0;
			const predicted = slot.params?.n_predict ?? decoded + remaining;

			const type: LlamaStateType = decoded > 0 ? "generating" : "processing";

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

		// Add inactive slots (they'll be shown as [-])
		for (const inactiveId of inactiveSlotIds) {
			slots.push({
				slotId: inactiveId,
				type: "idle" as LlamaStateType,
			});
		}

		// Determine aggregated display — show ALL slot values as `slotId:value`, no p/g
		let type: LlamaStateType = "idle";
		let displayValue = "";

		if (slots.length === 0) {
			type = "idle";
			displayValue = "all idle";
		} else {
			// Determine overall type
			if (slots.some((s) => s.type === "generating")) {
				type = "generating";
			} else if (slots.some((s) => s.type === "processing")) {
				type = "processing";
			} else {
				type = "idle";
			}
			// Sort by slotId ascending so display is deterministic
			slots.sort((a, b) => a.slotId - b.slotId);

			// Build one entry per slot
			const entries: Array<{ slotId: number; value: string }> = slots.map(
				(s) => {
					if (s.type === "generating") {
						const v =
							s.tokensPerSecond !== undefined
								? Math.round(s.tokensPerSecond)
								: (s.tokensDecoded ?? 0);
						return { slotId: s.slotId, value: `${v}t/s` };
					} else if (s.type === "processing") {
						const pct =
							s.progress != null && s.progress > 0
								? Math.round(s.progress * 100)
								: undefined;
						return {
							slotId: s.slotId,
							value: pct != null ? `${pct}%` : "--%",
						};
					} else {
						// Inactive/idle slot
						return { slotId: s.slotId, value: "-" };
					}
				},
			);

			// Compact: all if ≤3, truncate with +N if more
			displayValue = formatCompact(entries);
		}

		this.currentData = {
			type,
			slots,
			aggregated: { displayPrefix: null, displayValue },
		};
	}
}

/** Compact display: show all if ≤3, else top-2 + "+N remaining" */
function formatCompact(
	entries: Array<{ slotId: number; value: string }>,
	maxShow = 3,
): string {
	if (entries.length === 0) return "";
	if (entries.length <= maxShow) {
		return entries.map((e) => `${e.slotId}:${e.value}`).join(", ");
	}
	const shown = entries.slice(0, maxShow - 1);
	const remaining = entries.length - (maxShow - 1);
	const parts = shown.map((e) => `${e.slotId}:${e.value}`);
	parts.push(`+${remaining}`);
	return parts.join(", ");
}
