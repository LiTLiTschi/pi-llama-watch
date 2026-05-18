export type LlamaStateType = "idle" | "processing" | "generating";

export interface SlotInfo {
	slotId: number;
	type: LlamaStateType;
	progress?: number;
	tokensDecoded?: number;
	tokensRemaining?: number;
	tokensPredicted?: number;
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

export class LlamaState {
	private port: number;
	private intervalMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private currentData: LlamaStateData = {
		type: "idle",
		slots: [],
		aggregated: { displayPrefix: null, displayValue: "" },
	};

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
		// Also do an immediate poll
		this.poll();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
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
		const slots: SlotInfo[] = [];

		for (const [, slot] of Object.entries(data)) {
			if (!slot.is_processing) {
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

			slots.push({
				slotId: slot.id,
				type,
				progress,
				tokensDecoded: decoded,
				tokensRemaining: remaining,
				tokensPredicted: predicted,
			});
		}

		// Determine aggregated display
		let type: LlamaStateType = "idle";
		let displayPrefix: "p" | "g" | null = null;
		let displayValue = "";

		if (slots.length === 0) {
			type = "idle";
		} else {
			// Generating wins over processing
			const hasGenerating = slots.some((s) => s.type === "generating");
			if (hasGenerating) {
				type = "generating";
				displayPrefix = "g";
				// Pick generating slot with highest speed (tokensDecoded / tokensPredicted ratio is not speed)
				// Actually speed = tokens over time. For display, pick slot with highest decoded/remaining ratio as proxy
				// Simpler: just pick the first generating slot and use its decoded vs predict
				const genSlots = slots.filter((s) => s.type === "generating");
				const top = genSlots.reduce((a, b) => {
					const aRatio =
						(a.tokensPredicted ?? 1) > 0
							? (a.tokensDecoded ?? 0) / (a.tokensPredicted ?? 1)
							: 0;
					const bRatio =
						(b.tokensPredicted ?? 1) > 0
							? (b.tokensDecoded ?? 0) / (b.tokensPredicted ?? 1)
							: 0;
					return aRatio >= bRatio ? a : b;
				});
				displayValue = `${top.tokensDecoded}/s`;
			} else {
				type = "processing";
				displayPrefix = "p";
				// Pick slot with highest progress
				const top = slots.reduce((a, b) =>
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
