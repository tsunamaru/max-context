import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";

const MIN_BUFFER_TOKENS = 512;
const MAX_BUFFER_TOKENS = 16_384;

type PendingUserInput = {
	text: string;
	images?: ImageContent[];
};

export default function (pi: ExtensionAPI) {
	let maxContextTokens: number | null = null;
	let compactionInFlight = false;
	let lastCompactionStartedAtTokens: number | null = null;
	let pendingUserInputs: PendingUserInput[] = [];

	// Parse token values like "256k", "128000", "1.5m".
	function parseTokenValue(input: string): number | undefined {
		const trimmed = input.trim().toLowerCase();

		const suffixMatch = trimmed.match(/^(\d+(?:\.\d+)?)([km])$/);
		if (suffixMatch) {
			const value = Number(suffixMatch[1]);
			if (!Number.isFinite(value) || value <= 0) return undefined;

			const multiplier = suffixMatch[2] === "k" ? 1000 : 1_000_000;
			const tokens = Math.round(value * multiplier);
			return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
		}

		if (!/^\d+$/.test(trimmed)) return undefined;
		const tokens = Number(trimmed);
		return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
	}

	function fmt(n: number): string {
		if (n >= 1_000_000) {
			const value = n / 1_000_000;
			return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}M`;
		}
		if (n >= 1000) {
			const value = n / 1000;
			return `${n >= 10_000 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`;
		}
		return String(n);
	}

	function isDisableValue(input: string): boolean {
		const trimmed = input.trim().toLowerCase();
		return trimmed === "off" || trimmed === "none" || trimmed === "0";
	}

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}

	function getUsageTokens(ctx: ExtensionContext): number | null {
		const usage = ctx.getContextUsage();
		return usage && typeof usage.tokens === "number" ? usage.tokens : null;
	}

	function getBuffer(limit: number): number {
		const tenPercent = Math.floor(limit * 0.1);
		const desired = Math.max(MIN_BUFFER_TOKENS, Math.min(MAX_BUFFER_TOKENS, tenPercent));
		return Math.max(1, Math.min(desired, Math.floor(limit / 2)));
	}

	function getThreshold(limit: number): number {
		return Math.max(0, limit - getBuffer(limit));
	}

	function getCompactionDecision(ctx: ExtensionContext):
		| { shouldCompact: false }
		| { shouldCompact: true; tokens: number; threshold: number; buffer: number } {
		if (maxContextTokens === null) return { shouldCompact: false };

		const tokens = getUsageTokens(ctx);
		if (tokens === null) return { shouldCompact: false };

		const buffer = getBuffer(maxContextTokens);
		const threshold = getThreshold(maxContextTokens);
		if (tokens <= threshold) {
			lastCompactionStartedAtTokens = null;
			return { shouldCompact: false };
		}

		// If the last compaction did not reduce usage enough, avoid tight retry loops.
		const retryDelta = Math.max(buffer, Math.floor(maxContextTokens * 0.05));
		if (lastCompactionStartedAtTokens !== null && tokens <= lastCompactionStartedAtTokens + retryDelta) {
			return { shouldCompact: false };
		}

		return { shouldCompact: true, tokens, threshold, buffer };
	}

	function contentForPendingInput(input: PendingUserInput): string | (TextContent | ImageContent)[] {
		if (!input.images?.length) return input.text;

		const content: (TextContent | ImageContent)[] = [];
		if (input.text.trim().length > 0) content.push({ type: "text", text: input.text });
		content.push(...input.images);
		return content;
	}

	function enqueueUserInput(event: InputEvent) {
		pendingUserInputs.push({
			text: event.text,
			images: event.images ? [...event.images] : undefined,
		});
	}

	function flushPendingUserInputs(ctx: ExtensionContext) {
		if (pendingUserInputs.length === 0) return;

		const queued = pendingUserInputs;
		pendingUserInputs = [];

		for (let i = 0; i < queued.length; i++) {
			try {
				pi.sendUserMessage(contentForPendingInput(queued[i]), i === 0 ? undefined : { deliverAs: "followUp" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `Failed to resume queued message after compaction: ${message}`, "error");
			}
		}
	}

	function startCompaction(ctx: ExtensionContext, reason: string): boolean {
		if (maxContextTokens === null || compactionInFlight) return false;

		const decision = getCompactionDecision(ctx);
		if (!decision.shouldCompact) return false;

		compactionInFlight = true;
		lastCompactionStartedAtTokens = decision.tokens;

		notify(
			ctx,
			`Context at ${fmt(decision.tokens)} / ${fmt(maxContextTokens)}; ${reason}`,
			"info",
		);

		try {
			ctx.compact({
				customInstructions: `Compact the conversation to keep total context near the configured soft limit of ${maxContextTokens} tokens. Preserve all important decisions, code changes, and next steps.`,
				onComplete: () => {
					compactionInFlight = false;
					notify(ctx, "Context compaction completed.", "info");
					flushPendingUserInputs(ctx);
				},
				onError: (error) => {
					compactionInFlight = false;
					notify(ctx, `Context compaction failed: ${error.message}`, "error");
					flushPendingUserInputs(ctx);
				},
			});
			return true;
		} catch (error) {
			compactionInFlight = false;
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Context compaction failed: ${message}`, "error");
			return false;
		}
	}

	pi.registerCommand("max-context", {
		description:
			"Set a soft context limit. Auto-compacts near the limit. Usage: /max-context 256k, /max-context 128000, /max-context off",
		handler: async (args, ctx) => {
			if (!args || args.trim() === "") {
				if (maxContextTokens !== null) {
					const tokens = getUsageTokens(ctx);
					const current = tokens === null ? "current usage unknown" : `currently ${fmt(tokens)}`;
					notify(
						ctx,
						`Max context soft limit: ${fmt(maxContextTokens)} (${maxContextTokens.toLocaleString()} tokens), ${current}. Use /max-context off to clear.`,
						"info",
					);
				} else {
					notify(ctx, "No max context soft limit set. Usage: /max-context 256k", "info");
				}
				return;
			}

			if (isDisableValue(args)) {
				maxContextTokens = null;
				lastCompactionStartedAtTokens = null;
				notify(ctx, "Max context auto-compaction disabled.", "info");
				return;
			}

			const parsed = parseTokenValue(args);
			if (parsed === undefined) {
				notify(
					ctx,
					"Invalid format. Use e.g. /max-context 256k, /max-context 128000, or /max-context off",
					"error",
				);
				return;
			}

			maxContextTokens = parsed;
			lastCompactionStartedAtTokens = null;

			notify(
				ctx,
				`Max context soft limit set to ${fmt(parsed)} (${parsed.toLocaleString()} tokens). Will auto-compact near this limit.`,
				"info",
			);
			startCompaction(ctx, "compacting after setting a lower limit...");
		},
	});

	// If a prompt arrives while compaction is needed or in progress, hold it and replay it after compaction.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || maxContextTokens === null || !ctx.isIdle()) {
			return { action: "continue" };
		}

		if (compactionInFlight) {
			enqueueUserInput(event);
			notify(ctx, "Context compaction is still running; queued your message.", "info");
			return { action: "handled" };
		}

		if (!getCompactionDecision(ctx).shouldCompact) return { action: "continue" };

		const pendingStart = pendingUserInputs.length;
		enqueueUserInput(event);
		if (startCompaction(ctx, "compacting before processing your message...")) {
			notify(ctx, "Queued your message until compaction finishes.", "info");
			return { action: "handled" };
		}

		pendingUserInputs.splice(pendingStart);
		return { action: "continue" };
	});

	// After each completed prompt, compact while idle if the soft limit was crossed.
	pi.on("agent_end", async (_event, ctx) => {
		startCompaction(ctx, "compacting while idle before the next prompt...");
	});
}
