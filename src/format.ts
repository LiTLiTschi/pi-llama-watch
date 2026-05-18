import type { LlamaStateData } from "./LlamaState.js";

export function formatProcessing(progress: number): string {
	const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
	return `${pct}%`;
}

export function formatGenerating(tokensPerSecond: number): string {
	const rounded = Math.round(tokensPerSecond);
	return `${rounded}t/s`;
}

export function formatState(state: LlamaStateData): string | null {
	if (state.type === "idle") {
		return null;
	}
	return state.aggregated.displayValue || null;
}
