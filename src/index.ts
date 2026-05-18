import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { LlamaState } from "./LlamaState.js";
import { formatState } from "./format.js";

const STATUS_KEY = "llama-watch";

export default function (pi: ExtensionAPI) {
	let llamaState: LlamaState | null = null;
	let statusTimer: ReturnType<typeof setInterval> | null = null;
	let enabled = false;

	function startStatusUpdate(ctx: ExtensionContext): void {
		const port = Number(process.env.LLAMA_PORT) || 8080;
		llamaState = new LlamaState(port);
		llamaState.start();

		statusTimer = setInterval(() => {
			if (!llamaState || !enabled) return;

			const state = llamaState.getState();
			const formatted = formatState(state);

			const theme = ctx.ui.theme;
			if (formatted === null) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} else {
				const colorMap: Record<string, string> = {
					processing: "warning",
					generating: "success",
				};
				const color = colorMap[state.type] ?? "dim";
				ctx.ui.setStatus(
					STATUS_KEY,
					theme.fg(color as Parameters<typeof theme.fg>[0], formatted),
				);
			}
		}, 1000);
	}

	function stopStatusUpdate(): void {
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = null;
		}
		llamaState?.stop();
		llamaState = null;
	}

	pi.on("agent_start", async (_event, ctx) => {
		enabled = true;
		startStatusUpdate(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		enabled = false;
		stopStatusUpdate();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		enabled = false;
		stopStatusUpdate();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("llama-watch", {
		description: "Toggle LLM status display in status bar: on, off, or toggle.",
		handler: async (args: string, ctx: ExtensionContext) => {
			const cmd = args.trim().toLowerCase();
			if (cmd === "on") {
				enabled = true;
				if (!llamaState) {
					startStatusUpdate(ctx);
				}
				ctx.ui.notify("LLM status: enabled", "info");
			} else if (cmd === "off") {
				enabled = false;
				stopStatusUpdate();
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("LLM status: disabled", "info");
			} else if (cmd === "toggle") {
				enabled = !enabled;
				if (enabled && !llamaState) {
					startStatusUpdate(ctx);
				} else if (!enabled) {
					stopStatusUpdate();
					ctx.ui.setStatus(STATUS_KEY, undefined);
				}
				ctx.ui.notify(
					`LLM status: ${enabled ? "enabled" : "disabled"}`,
					"info",
				);
			} else {
				ctx.ui.notify(`Usage: /llama-watch [on|off|toggle]`, "info");
			}
		},
	});
}
