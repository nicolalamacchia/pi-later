/**
 * Deferred messages ("after you're done").
 *
 * /later <text>        queue a message; it is delivered as a normal user
 *                      message once the agent has finished everything it is
 *                      currently doing (until `agent_settled`: retries,
 *                      compaction and queued continuations included).
 * /later               open the queue (view / edit / delete / send now)
 * /later list          show the queue
 * /later edit <n> [t]  rewrite queued message n (opens an editor without text)
 * /later rm <n>        drop queued message n
 * /later clear         drop the whole queue
 * /later send          deliver the head of the queue now (if idle)
 * /later help          this text
 *
 * Queue head is delivered as a plain user turn, so it looks exactly like the
 * user typed it. The remaining items stay queued and are delivered one per
 * settled run. Queue state is persisted with custom entries (invisible in the
 * transcript) and restored on session resume.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "deferred-messages";
const STATUS_KEY = "later";
const WIDGET_KEY = "later";

interface DeferredMessage {
	id: number;
	text: string;
	createdAt: number;
}

interface DeferredState {
	items: DeferredMessage[];
	nextId: number;
}

export default function (pi: ExtensionAPI) {
	let items: DeferredMessage[] = [];
	let nextId = 1;
	let sending = false;

	const help = [
		"Deferred messages — delivered when the agent is fully done.",
		"/later <text>       queue a message",
		"/later              open the queue menu",
		"/later list         show the queue",
		"/later edit <n> [text]  edit queued message n",
		"/later rm <n>       remove queued message n",
		"/later clear        clear the queue",
		"/later send         send the head of the queue now (if idle)",
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
						.map((m) => ({ id: Number(m.id) || 0, text: m.text, createdAt: Number(m.createdAt) || Date.now() }))
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

	function updateDisplay(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		try {
			if (items.length === 0) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			const count = items.length;
			ctx.ui.setStatus(STATUS_KEY, `⏳ ${count} deferred`);
			ctx.ui.setWidget(
				WIDGET_KEY,
				items.map((m) => `${m.id}. ${preview(m.text)}`),
			);
		} catch {
			// display is best-effort
		}
	}

	function enqueue(text: string) {
		const message: DeferredMessage = { id: nextId++, text, createdAt: Date.now() };
		items = [...items, message];
		save();
		return message;
	}

	/**
	 * Deliver the head of the queue as a user message. Only one message per
	 * settle so every deferred message gets its own completed run.
	 */
	function deliverHead(ctx: ExtensionContext): boolean {
		if (sending || items.length === 0) return false;
		if (!ctx.isIdle()) return false;
		const [head, ...rest] = items;
		items = rest;
		save();
		updateDisplay(ctx);
		sending = true;
		try {
			pi.sendUserMessage(head.text);
		} catch (error) {
			// Put it back so nothing is lost.
			items = [head, ...items];
			save();
			updateDisplay(ctx);
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
		updateDisplay(ctx);
		ctx.ui.notify(`Deferred message ${target.id} updated`, "info");
	}

	async function openMenu(ctx: ExtensionContext) {
		if (items.length === 0) {
			ctx.ui.notify("No deferred messages.", "info");
			return;
		}
		const choices = [
			...items.map((m) => `${m.id}. ${preview(m.text, 50)}`),
			"Send first now",
			"Clear all",
		];
		const picked = await ctx.ui.select("Deferred messages", choices);
		if (!picked) return;

		if (picked === "Send first now") {
			if (!deliverHead(ctx)) ctx.ui.notify("Agent is busy; will send when it settles.", "info");
			return;
		}
		if (picked === "Clear all") {
			items = [];
			save();
			updateDisplay(ctx);
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
			updateDisplay(ctx);
		} else if (action === "Send now") {
			items = [target, ...items.filter((m) => m.id !== target.id)];
			save();
			updateDisplay(ctx);
			if (!deliverHead(ctx)) ctx.ui.notify("Agent is busy; will send when it settles.", "info");
		}
	}

	function list(ctx: ExtensionContext) {
		if (items.length === 0) {
			ctx.ui.notify("Deferred queue is empty.", "info");
			return;
		}
		const lines = items.map((m) => `${m.id}. ${m.text}`);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	pi.registerCommand("later", {
		description: "Queue a message to be sent after the agent finishes",
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
					updateDisplay(ctx);
					ctx.ui.notify("Deferred queue cleared", "info");
					return;
				case "send":
				case "flush":
					if (!deliverHead(ctx)) {
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
					updateDisplay(ctx);
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
			updateDisplay(ctx);
			if (deliverHead(ctx)) {
				ctx.ui.notify(`Delivered message ${queued.id}.`, "info");
			} else {
				ctx.ui.notify(`Queued message ${queued.id}; will send when the agent settles.`, "info");
			}
		},
	});

	// Restore from the active branch, then deliver if something is waiting.
	pi.on("session_start", async (_event, ctx) => {
		items = [];
		nextId = 1;
		load(ctx);
		updateDisplay(ctx);
		deliverHead(ctx);
	});

	// The only boundary where Pi will not continue automatically.
	pi.on("agent_settled", async (_event, ctx) => {
		deliverHead(ctx);
		updateDisplay(ctx);
	});
}
