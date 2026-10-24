/**
 * Deferred messages ("after you're done").
 *
 * /later <text>          queue a message; it is delivered as a normal user
 *                        message once the agent has finished everything it is
 *                        currently doing (until `agent_settled`: retries,
 *                        compaction and queued continuations included).
 * /later in 10m <text>   same, but not before 10m from now (system clock)
 * /later at 14:30 <text> same, but not before 14:30 local time (next
 *                        occurrence today or tomorrow)
 * /later at 2025-01-31 14:30 <text>  ...at a specific date and time
 * /later                 open the queue (view / edit / delete / send now)
 * /later list            show the queue
 * /later edit <n> [t]    rewrite queued message n (opens an editor without text)
 * /later rm <n>          drop queued message n
 * /later clear           drop the whole queue
 * /later send            deliver the head of the queue now (if idle)
 * /later help            this text
 *
 * Delivery always goes through the normal deferred path: a plain user turn,
 * one per settled run, never as a steering interruption. A timer only decides
 * *earliest* delivery; if pi is busy at that moment the message waits for
 * `agent_settled`. Timers live in the pi process, so a message due while pi is
 * closed is delivered on the next session start.
 *
 * Queue state (including due times) is persisted with custom entries (invisible
 * in the transcript) and restored on session resume.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "deferred-messages";
const STATUS_KEY = "later";
const WIDGET_KEY = "later";
const MAX_TIMEOUT = 2_147_483_647; // setTimeout clamps above 2^31-1 ms

interface DeferredMessage {
	id: number;
	text: string;
	createdAt: number;
	/** Earliest delivery time (epoch ms); undefined means "as soon as idle". */
	dueAt?: number;
}

interface DeferredState {
	items: DeferredMessage[];
	nextId: number;
}

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** Parse "90s", "10m", "2h", "1d", "1h30m" (spaces allowed) into milliseconds. */
export function parseDuration(input: string): number | undefined {
	const compact = input
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "")
		.replace(/minutes?|mins?/g, "m")
		.replace(/seconds?|secs?/g, "s")
		.replace(/hours?|hrs?/g, "h")
		.replace(/days?/g, "d");
	if (!compact) return undefined;
	const parts = [...compact.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)];
	if (parts.length === 0 || parts.map((p) => p[0]).join("") !== compact) return undefined;
	const ms = parts.reduce((sum, [, n, unit]) => sum + Number(n) * UNIT_MS[unit], 0);
	return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
}

/**
 * Parse "14:30", "9:05", or "2025-01-31 14:30" into an epoch time using the
 * system clock. A bare time resolves to the next occurrence (today, or
 * tomorrow when already past).
 */
export function parseClock(input: string, now = new Date()): number | undefined {
	const match = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(input.trim());
	if (!match) return undefined;
	const [, year, month, day, hour, minute, second] = match;
	const h = Number(hour);
	const m = Number(minute);
	const s = second === undefined ? 0 : Number(second);
	if (h > 23 || m > 59 || s > 59) return undefined;

	if (year !== undefined) {
		const at = new Date(Number(year), Number(month) - 1, Number(day), h, m, s, 0);
		return Number.isNaN(at.getTime()) ? undefined : at.getTime();
	}

	const at = new Date(now);
	at.setHours(h, m, s, 0);
	if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
	return at.getTime();
}

export default function (pi: ExtensionAPI) {
	let items: DeferredMessage[] = [];
	let nextId = 1;
	let sending = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timerCtx: ExtensionContext | undefined;

	const help = [
		"Deferred messages — delivered when the agent is fully done.",
		"/later <text>          queue a message",
		"/later in 10m <text>   queue, not before 10m from now",
		"/later at 14:30 <text> queue, not before that local time",
		"/later                 open the queue menu",
		"/later list            show the queue",
		"/later edit <n> [text] edit queued message n",
		"/later rm <n>          remove queued message n",
		"/later clear           clear the queue",
		"/later send            send the head of the queue now (if idle)",
	].join("\n");

	function save() {
		const state: DeferredState = { items, nextId };
		pi.appendEntry(ENTRY_TYPE, state);
	}

	function load(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as Partial<DeferredState> | undefined;
			const restored = Array.isArray(data?.items)
				? data.items
						.filter((m): m is DeferredMessage => !!m && typeof m.text === "string")
						.map((m) => {
							const dueAt = Number(m.dueAt);
							return {
								id: Number(m.id) || 0,
								text: m.text,
								createdAt: Number(m.createdAt) || Date.now(),
								...(Number.isFinite(dueAt) && dueAt > 0 ? { dueAt } : {}),
							};
						})
				: [];
			items = restored;
			nextId = Math.max(Number(data?.nextId) || 1, ...restored.map((m) => m.id + 1), 1);
			return;
		}
	}

	function preview(text: string, max = 60) {
		const oneLine = text.replace(/\s+/g, " ").trim();
		return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
	}

	function dueLabel(dueAt: number | undefined): string {
		if (dueAt === undefined) return "";
		const at = new Date(dueAt);
		const sameDay = at.toDateString() === new Date().toDateString();
		const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		return sameDay
			? `⏰ ${time} `
			: `⏰ ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time} `;
	}

	function updateDisplay(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		try {
			if (items.length === 0) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			const timed = items.filter((m) => m.dueAt !== undefined).length;
			ctx.ui.setStatus(STATUS_KEY, timed > 0 ? `⏳ ${items.length} deferred (${timed} timed)` : `⏳ ${items.length} deferred`);
			ctx.ui.setWidget(
				WIDGET_KEY,
				items.map((m) => `${m.id}. ${dueLabel(m.dueAt)}${preview(m.text)}`),
			);
		} catch {
			// display is best-effort
		}
	}

	/** Earliest due time in the queue, if any item is timed. */
	function nextDue(): number | undefined {
		let next: number | undefined;
		for (const m of items) {
			if (m.dueAt === undefined) continue;
			if (next === undefined || m.dueAt < next) next = m.dueAt;
		}
		return next;
	}

	/**
	 * (Re)arm the system-clock timer for the earliest timed message. Timers are
	 * session-scoped: they start from session_start or a command, never from the
	 * extension factory, and are cleared on session_shutdown.
	 */
	function armTimer(ctx?: ExtensionContext) {
		if (ctx) timerCtx = ctx;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		const due = nextDue();
		if (due === undefined) return;
		const now = Date.now();
		// Already due while busy: agent_settled will deliver it. Avoid a 0ms spin.
		if (due <= now && !timerCtx?.isIdle()) return;
		const delay = Math.min(Math.max(due - now, 0), MAX_TIMEOUT);
		timer = setTimeout(() => {
			timer = undefined;
			const current = timerCtx;
			if (!current) return;
			deliverNext(current);
			updateDisplay(current);
			const pending = nextDue();
			if (pending !== undefined && pending > Date.now()) armTimer(current);
		}, delay);
		// Do not keep the process alive just for a deferred message.
		(timer as unknown as { unref?: () => void }).unref?.();
	}

	function refresh(ctx: ExtensionContext) {
		updateDisplay(ctx);
		armTimer(ctx);
	}

	function enqueue(text: string, dueAt?: number) {
		const message: DeferredMessage = { id: nextId++, text, createdAt: Date.now(), ...(dueAt !== undefined ? { dueAt } : {}) };
		items = [...items, message];
		save();
		return message;
	}

	/**
	 * Deliver the next deliverable message as a user message. Only one message
	 * per settle so every deferred message gets its own completed run. Timed
	 * messages stay queued until their due time unless `ignoreDue` is set.
	 */
	function deliverNext(ctx: ExtensionContext, options: { ignoreDue?: boolean } = {}): boolean {
		if (sending || items.length === 0) return false;
		if (!ctx.isIdle()) return false;
		const now = Date.now();
		const index = items.findIndex((m) => options.ignoreDue || m.dueAt === undefined || m.dueAt <= now);
		if (index === -1) return false;
		const target = items[index];
		items = items.filter((_, i) => i !== index);
		save();
		refresh(ctx);
		sending = true;
		try {
			pi.sendUserMessage(target.text);
		} catch (error) {
			// Put it back so nothing is lost.
			items = [target, ...items];
			save();
			refresh(ctx);
			throw error;
		} finally {
			sending = false;
		}
		return true;
	}

	function findItem(raw: string | undefined): DeferredMessage | undefined {
		const id = Number(raw);
		if (!Number.isFinite(id)) return undefined;
		return items.find((m) => m.id === id);
	}

	async function editItem(target: DeferredMessage, ctx: ExtensionContext, text?: string) {
		let next = text;
		if (next === undefined) {
			if (!ctx.hasUI) {
				ctx.ui.notify("/later edit needs text in this mode", "warning");
				return;
			}
			next = await ctx.ui.editor(`Edit deferred message ${target.id}`, target.text);
		}
		if (next === undefined || next.trim() === "") return;
		items = items.map((m) => (m.id === target.id ? { ...m, text: next as string } : m));
		save();
		refresh(ctx);
		ctx.ui.notify(`Deferred message ${target.id} updated`, "info");
	}

	async function openMenu(ctx: ExtensionContext) {
		if (items.length === 0) {
			ctx.ui.notify("No deferred messages.", "info");
			return;
		}
		const choices = [
			...items.map((m) => `${m.id}. ${dueLabel(m.dueAt)}${preview(m.text, 50)}`),
			"Send first now",
			"Clear all",
		];
		const picked = await ctx.ui.select("Deferred messages", choices);
		if (!picked) return;

		if (picked === "Send first now") {
			if (!deliverNext(ctx, { ignoreDue: true })) ctx.ui.notify("Agent is busy; will send when it settles.", "info");
			return;
		}
		if (picked === "Clear all") {
			items = [];
			save();
			refresh(ctx);
			ctx.ui.notify("Deferred queue cleared", "info");
			return;
		}
		const target = items.find((m) => picked.startsWith(`${m.id}. `));
		if (!target) return;
		const action = await ctx.ui.select(`Message ${target.id}`, ["Edit", "Delete", "Send now", "Cancel"]);
		if (action === "Edit") await editItem(target, ctx);
		else if (action === "Delete") {
			items = items.filter((m) => m.id !== target.id);
			save();
			refresh(ctx);
		} else if (action === "Send now") {
			items = [target, ...items.filter((m) => m.id !== target.id)];
			save();
			refresh(ctx);
			if (!deliverNext(ctx, { ignoreDue: true })) ctx.ui.notify("Agent is busy; will send when it settles.", "info");
		}
	}

	function list(ctx: ExtensionContext) {
		if (items.length === 0) {
			ctx.ui.notify("Deferred queue is empty.", "info");
			return;
		}
		const lines = items.map((m) => `${m.id}. ${dueLabel(m.dueAt)}${m.text}`);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	pi.registerCommand("later", {
		description: "Queue a message to be sent after the agent finishes (optionally after a delay or at a time)",
		handler: async (args, ctx) => {
			const raw = args.trim();
			const [verb, ...restParts] = raw.split(/\s+/);
			const rest = raw.slice(verb.length).trim();

			switch (verb) {
				case "list":
					list(ctx);
					return;
				case "help":
					ctx.ui.notify(help, "info");
					return;
				case "clear":
					items = [];
					save();
					refresh(ctx);
					ctx.ui.notify("Deferred queue cleared", "info");
					return;
				case "send":
				case "flush":
					if (!deliverNext(ctx, { ignoreDue: true })) {
						ctx.ui.notify(items.length ? "Agent is busy; sending when it settles." : "Queue is empty.", "info");
					}
					return;
				case "rm":
				case "del":
				case "remove": {
					const target = findItem(restParts[0]);
					if (!target) {
						ctx.ui.notify("Usage: /later rm <id>", "warning");
						return;
					}
					items = items.filter((m) => m.id !== target.id);
					save();
					refresh(ctx);
					ctx.ui.notify(`Removed deferred message ${target.id}`, "info");
					return;
				}
				case "edit": {
					const target = findItem(restParts[0]);
					if (!target) {
						ctx.ui.notify("Usage: /later edit <id> [new text]", "warning");
						return;
					}
					const newText = rest.slice(restParts[0].length).trim();
					await editItem(target, ctx, newText === "" ? undefined : newText);
					return;
				}
				case "in": {
					const spec = restParts[0];
					const text = spec === undefined ? "" : rest.slice(spec.length).trim();
					const delay = spec === undefined ? undefined : parseDuration(spec);
					if (delay === undefined || text === "") {
						ctx.ui.notify("Usage: /later in <duration> <text>  (e.g. /later in 10m check the build)", "warning");
						return;
					}
					const queued = enqueue(text, Date.now() + delay);
					refresh(ctx);
					ctx.ui.notify(`Queued message ${queued.id}; will send after ${new Date(queued.dueAt as number).toLocaleString()}.`, "info");
					deliverNext(ctx);
					return;
				}
				case "at": {
					let dueAt: number | undefined;
					let text = "";
					// Try a two-token date-time ("2025-01-31 14:30") first, then a bare clock.
					for (const candidate of [restParts.slice(0, 2).join(" "), restParts[0]]) {
						if (!candidate) continue;
						const parsed = parseClock(candidate);
						if (parsed === undefined) continue;
						dueAt = parsed;
						text = rest.slice(candidate.length).trim();
						break;
					}
					if (dueAt === undefined || text === "") {
						ctx.ui.notify("Usage: /later at <HH:MM|YYYY-MM-DD HH:MM> <text>", "warning");
						return;
					}
					const queued = enqueue(text, dueAt);
					refresh(ctx);
					ctx.ui.notify(`Queued message ${queued.id}; will send after ${new Date(dueAt).toLocaleString()}.`, "info");
					deliverNext(ctx);
					return;
				}
			}

			if (raw === "") {
				if (!ctx.hasUI) {
					list(ctx);
					return;
				}
				await openMenu(ctx);
				return;
			}

			const queued = enqueue(raw);
			refresh(ctx);
			if (deliverNext(ctx)) {
				ctx.ui.notify(`Delivered message ${queued.id}.`, "info");
			} else {
				ctx.ui.notify(`Queued message ${queued.id}; will send when the agent settles.`, "info");
			}
		},
	});

	// Restore from the active branch, arm timers, then deliver if something is waiting.
	pi.on("session_start", async (_event, ctx) => {
		items = [];
		nextId = 1;
		load(ctx);
		refresh(ctx);
		deliverNext(ctx);
	});

	// The only boundary where Pi will not continue automatically.
	pi.on("agent_settled", async (_event, ctx) => {
		deliverNext(ctx);
		refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		timerCtx = undefined;
	});
}
