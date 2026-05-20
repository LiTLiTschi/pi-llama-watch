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

export interface JournalctlResult {
	/** Slot IDs currently in prompt processing (not yet done) */
	processingSlots: Set<number>;
	/** Slot IDs that just completed prompt processing */
	doneSlots: Set<number>;
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
	// Cache for JOURNALCTL results (avoid parsing on every poll)
	private journalctlCache: JournalctlResult | null = null;
	private journalctlCacheTime = 0;
	private journalctlCacheTtl = 2000; // 2s cache, logs update slowly
	// Service name for journalctl (default: llama, configurable via env)
	private service = process.env.LLAMA_SERVICE || "llama";

	async getProcessingSlotsFromJournalctl(): Promise<Set<number>> {
		// Return cached result if still valid
		const now = Date.now();
		if (
			this.journalctlCache &&
			now - this.journalctlCacheTime < this.journalctlCacheTtl
		) {
			return this.journalctlCache.processingSlots;
		}

		try {
			const result = await this.parseJournalctlOutput(this.service);
			this.journalctlCache = result;
			this.journalctlCacheTime = now;
			return result.processingSlots;
		} catch {
			// If journalctl fails, return empty set (fall back to API-only detection)
			return new Set();
		}
	}

	/**
	 * Parse journalctl output to find slots in prompt processing.
	 * Mirrors the awk logic from llama-watch.sh:
	 *   /slot update_slots.*prompt processing done/ → mark as done
	 *   /slot update_slots.*prompt processing progress.*progress =/ → track progress
	 *   END { for (s in last) if (!done[s]) print s }
	 */
	private async parseJournalctlOutput(
		service: string,
	): Promise<JournalctlResult> {
		const processingSlots = new Set<number>();
		const doneSlots = new Set<number>();

		try {
			// Import child_process for journalctl command
			const { spawnSync } = await import("child_process");
			const result = spawnSync(
				"journalctl",
				["-u", service, "-n", "100", "--no-pager"],
				{
					encoding: "utf-8",
					timeout: 5000,
				},
			);

			if (result.status !== 0 || !result.stdout) {
				return { processingSlots, doneSlots };
			}

			const lines = result.stdout.split("\n");

			// Track progress per slot (like script's last[s] and done[s])
			const slotProgress = new Map<number, number>();

			for (const line of lines) {
				// Check for "prompt processing done"
				const doneMatch = line.match(
					/slot\s+update_slots.*prompt\s+processing\s+done/i,
				);
				if (doneMatch) {
					const idMatch = line.match(/id\s+(\d+)/);
					if (idMatch) {
						doneSlots.add(parseInt(idMatch[1], 10));
					}
				}

				// Check for "prompt processing progress"
				const progressMatch = line.match(
					/slot\s+update_slots.*prompt\s+processing\s+progress.*progress\s*=\s*([0-9.]+)/i,
				);
				if (progressMatch) {
					const idMatch = line.match(/id\s+(\d+)/);
					if (idMatch) {
						const slotId = parseInt(idMatch[1], 10);
						const progress = parseFloat(progressMatch[1]);
						// Only keep the latest progress per slot (like script's last[s])
						const current = slotProgress.get(slotId) ?? 0;
						if (progress > current) {
							slotProgress.set(slotId, progress);
						}
					}
				}
			}

			// END block: print slots that have progress but are not yet done
			for (const [slotId, _progress] of slotProgress) {
				if (!doneSlots.has(slotId)) {
					processingSlots.add(slotId);
				}
			}
		} catch {
			// If journalctl fails, return empty sets
		}

		return { processingSlots, doneSlots };
	}

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
			await this.parseSlotResponse(data);
		} catch {
			// Network error — keep current state
		}
	}

	// Exposed for testing; in production called from poll()
	// Accepts optional processingSlotIds for cross-reference with JOURNALCTL
	async parseSlotResponse(
		data: RawSlots,
		processingSlotIds?: Set<number>,
	): Promise<void> {
		const now = Date.now();
		const slots: SlotInfo[] = [];
		const inactiveSlotIds = new Set<number>();
		const currentSlotIds = new Set<number>();

		// If no processingSlotIds provided, get them from JOURNALCTL
		let effectiveProcessingSlotIds: Set<number>;
		if (processingSlotIds) {
			effectiveProcessingSlotIds = processingSlotIds;
		} else {
			effectiveProcessingSlotIds =
				await this.getProcessingSlotsFromJournalctl();
		}

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

			// Determine slot type: journalctl override wins, then decoding tokens indicate generating, else processing
			const type: LlamaStateType = effectiveProcessingSlotIds.has(slot.id)
				? "processing"
				: decoded > 0
					? "generating"
					: "processing";

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

		// Determine aggregated display — show all slot values, no p/g prefix
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
			const entries: Array<{ value: string }> = slots.map((s) => {
				if (s.type === "generating") {
					const v =
						s.tokensPerSecond !== undefined
							? Math.round(s.tokensPerSecond)
							: (s.tokensDecoded ?? 0);
					return { value: `${v}t/s` };
				} else if (s.type === "processing") {
					const pct =
						s.progress != null && s.progress > 0
							? Math.round(s.progress * 100)
							: undefined;
					return { value: pct != null ? `${pct}%` : "--%" };
				} else {
					// Inactive/idle slot
					return { value: "-" };
				}
			});

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
function formatCompact(entries: Array<{ value: string }>, maxShow = 3): string {
	if (entries.length === 0) return "";
	if (entries.length <= maxShow) {
		return entries.map((e) => e.value).join(", ");
	}
	const shown = entries.slice(0, maxShow - 1);
	const remaining = entries.length - (maxShow - 1);
	const parts = shown.map((e) => e.value);
	parts.push(`+${remaining}`);
	return parts.join(", ");
}
