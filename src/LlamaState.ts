import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);

export type LlamaStateType = "idle" | "processing" | "generating";

export interface SlotInfo {
	slotId: number;
	type: LlamaStateType;
	progress?: number;
	tokensDecoded?: number;
	tokensRemaining?: number;
	tokensPredicted?: number;
	tokensPerSecond?: number;
	eta?: string;
}

export interface LlamaStateData {
	type: LlamaStateType;
	slots: SlotInfo[];
	aggregated: {
		displayPrefix: "p" | "g" | null;
		displayValue: string;
	};
	ram?: { used: string; total: string; avail: string };
	gpu?: string;
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
	private scriptPath: string;
	private service: string;

	constructor(port: number = 8080, intervalMs: number = 1000) {
		this.port = port;
		this.intervalMs = intervalMs;
		// The script is copied to the project root
		this.scriptPath = path.resolve(process.cwd(), "llama-watch.sh");
		this.service = process.env.LLAMA_SERVICE || "llama";
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
	}

	private async poll(): Promise<void> {
		try {
			// Set LLAMA_PORT for the script
			const env = { ...process.env, LLAMA_PORT: this.port.toString() };
			const { stdout } = await execAsync(
				`${this.scriptPath} --json --api --slots-only --service ${this.service}`,
				{
					env,
					timeout: 5000,
				},
			);

			const data = JSON.parse(stdout);
			this.currentData = this.mapShellData(data);
		} catch (error) {
			// On error, we don't update currentData to avoid flickering
		}
	}

	private mapShellData(data: any): LlamaStateData {
		const slots: SlotInfo[] = data.slots.map((s: any) => ({
			slotId: s.id,
			type: s.type as LlamaStateType,
			progress: s.progress,
			tokensDecoded: s.decoded,
			tokensRemaining: s.total - (s.decoded || 0),
			tokensPredicted: s.total,
			tokensPerSecond: s.tps,
			eta: s.eta,
		}));

		let type: LlamaStateType = "idle";
		if (slots.some((s) => s.type === "generating")) {
			type = "generating";
		} else if (slots.some((s) => s.type === "processing")) {
			type = "processing";
		}

		// Sort by slotId ascending
		slots.sort((a, b) => a.slotId - b.slotId);

		// Build aggregated display value
		const entries = slots.map((s) => {
			if (s.type === "generating") {
				const v =
					s.tokensPerSecond !== undefined && s.tokensPerSecond > 0
						? Math.round(s.tokensPerSecond)
						: s.tokensDecoded ?? 0;
				return `${v}t/s`;
			} else if (s.type === "processing") {
				const pct =
					s.progress != null && s.progress > 0
						? Math.round(s.progress * 100)
						: null;
				return pct != null ? `${pct}%` : "--%";
			}
			return "-";
		});

		const displayValue = this.formatCompact(entries);

		return {
			type,
			slots,
			aggregated: { displayPrefix: null, displayValue },
			ram: data.ram,
			gpu: data.gpu,
		};
	}

	private formatCompact(entries: string[], maxShow = 3): string {
		if (entries.length === 0) return "all idle";
		if (entries.length <= maxShow) {
			return entries.join(", ");
		}
		const shown = entries.slice(0, maxShow - 1);
		const remaining = entries.length - (maxShow - 1);
		return [...shown, `+${remaining}`].join(", ");
	}
}
