const test = require("node:test");
const assert = require("node:assert/strict");
const activate = require("../dist/index.js").default;

const NO_THROW = Symbol("no throw");

function createHarness({ usage, hasUI = true, idle = true } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const compactions = [];
	const sendAttempts = [];
	const sent = [];
	const sendFailures = new Map();
	let usageValue = usage;
	let idleValue = idle;
	let compactThrow = NO_THROW;
	let statusCalls = 0;

	const pi = {
		on(name, handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		sendUserMessage(content, options) {
			const call = { content, options };
			const index = sendAttempts.push(call) - 1;
			if (sendFailures.has(index)) throw sendFailures.get(index);
			sent.push(call);
		},
	};

	activate(pi);

	const ctx = {
		hasUI,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus() {
				statusCalls++;
				throw new Error("The extension must not publish a status string");
			},
		},
		getContextUsage() {
			if (typeof usageValue === "function") return usageValue();
			if (usageValue === undefined || usageValue === null || typeof usageValue === "object") {
				return usageValue;
			}
			return { tokens: usageValue };
		},
		isIdle() {
			return idleValue;
		},
		compact(options) {
			compactions.push(options);
			if (compactThrow !== NO_THROW) throw compactThrow;
		},
	};

	return {
		handlers,
		commands,
		notifications,
		compactions,
		sendAttempts,
		sent,
		ctx,
		get statusCalls() {
			return statusCalls;
		},
		setUsage(value) {
			usageValue = value;
		},
		setIdle(value) {
			idleValue = value;
		},
		setCompactThrow(value = NO_THROW) {
			compactThrow = value;
		},
		failSend(index, error) {
			sendFailures.set(index, error);
		},
		command(args) {
			return commands.get("max-context").handler(args, ctx);
		},
		input(event = {}) {
			return handlers.get("input")[0](
				{ type: "input", text: "hello", source: "interactive", ...event },
				ctx,
			);
		},
		agentEnd() {
			return handlers.get("agent_end")[0]({ type: "agent_end", messages: [] }, ctx);
		},
	};
}

function messages(harness) {
	return harness.notifications.map(({ message }) => message);
}

test("registers only the command and functional event handlers", async () => {
	const h = createHarness({ usage: 439 });

	assert.deepEqual([...h.commands.keys()], ["max-context"]);
	assert.deepEqual([...h.handlers.keys()], ["input", "agent_end"]);
	assert.match(h.commands.get("max-context").description, /soft context limit/);

	await h.command(undefined);
	assert.equal(messages(h).at(-1), "No max context soft limit set. Usage: /max-context 256k");
	await h.agentEnd();
	assert.equal(h.compactions.length, 0);
	assert.equal(h.statusCalls, 0);
});

test("reports, enables, and disables the configured limit", async () => {
	const h = createHarness({ usage: 439 });

	await h.command("128000");
	assert.match(messages(h).at(-1), /^Max context soft limit set to 128k /);
	await h.command(" ");
	assert.match(messages(h).at(-1), /soft limit: 128k .* currently 439/);
	await h.command(" OFF ");
	assert.equal(messages(h).at(-1), "Max context auto-compaction disabled.");
	await h.command("");
	assert.equal(messages(h).at(-1), "No max context soft limit set. Usage: /max-context 256k");
	assert.equal(h.statusCalls, 0);
});

test("accepts supported token formats and formats notifications", async (t) => {
	const cases = [
		[" 256K ", "256k"],
		["1.5m", "1.5M"],
		["1500", "1.5k"],
		["1000000", "1M"],
		["999", "999"],
		["12.34k", "12k"],
	];

	for (const [input, formatted] of cases) {
		await t.test(input, async () => {
			const h = createHarness();
			await h.command(input);
			assert.match(messages(h).at(-1), new RegExp(`set to ${formatted.replace(".", "\\.")} `));
			assert.equal(h.compactions.length, 0);
		});
	}
});

test("rejects malformed, zero, infinite, and unsafe token values", async () => {
	const invalid = [
		"abc",
		"-1",
		"1.2",
		"1x",
		"1e3",
		"0k",
		`${"9".repeat(400)}m`,
		"9007199254740992",
		"9007199254740992k",
	];

	for (const input of invalid) {
		const h = createHarness();
		await h.command(input);
		assert.equal(messages(h).at(-1), "Invalid format. Use e.g. /max-context 256k, /max-context 128000, or /max-context off");
		assert.equal(h.compactions.length, 0);
	}
});

test("recognizes every disable spelling", async () => {
	for (const value of ["off", " NoNe ", "0"]) {
		const h = createHarness();
		await h.command("10k");
		await h.command(value);
		assert.equal(messages(h).at(-1), "Max context auto-compaction disabled.");
	}
});

test("uses bounded buffers and compacts only above each threshold", async (t) => {
	await t.test("tiny limit", async () => {
		const h = createHarness({ usage: 1 });
		await h.command("1");
		assert.equal(h.compactions.length, 1);
		assert.match(messages(h)[1], /^Context at 1 \/ 1;/);
	});

	await t.test("ten percent buffer", async () => {
		const h = createHarness({ usage: 9000 });
		await h.command("10k");
		assert.equal(h.compactions.length, 0);
		h.setUsage(9001);
		await h.agentEnd();
		assert.equal(h.compactions.length, 1);
	});

	await t.test("maximum buffer", async () => {
		const h = createHarness({ usage: 983616 });
		await h.command("1m");
		assert.equal(h.compactions.length, 0);
		h.setUsage(983617);
		await h.agentEnd();
		assert.equal(h.compactions.length, 1);
	});
});

test("queues prompts during compaction and restores text and image content in order", async () => {
	const h = createHarness({ usage: 100 });
	await h.command("10k");
	h.setUsage(9001);

	assert.deepEqual(h.input({ text: "first" }), { action: "handled" });
	assert.equal(h.compactions.length, 1);
	assert.match(h.compactions[0].customInstructions, /configured soft limit of 10000 tokens/);

	const image = { type: "image", data: "one", mimeType: "image/png" };
	const images = [image];
	assert.deepEqual(h.input({ text: "look", images }), { action: "handled" });
	images.push({ type: "image", data: "late", mimeType: "image/png" });
	const imageOnly = { type: "image", data: "two", mimeType: "image/jpeg" };
	assert.deepEqual(h.input({ text: "   ", images: [imageOnly] }), { action: "handled" });

	await h.agentEnd();
	assert.equal(h.compactions.length, 1, "an in-flight compaction must not be duplicated");
	h.compactions[0].onComplete({});

	assert.deepEqual(h.sent, [
		{ content: "first", options: undefined },
		{ content: [{ type: "text", text: "look" }, image], options: { deliverAs: "followUp" } },
		{ content: [imageOnly], options: { deliverAs: "followUp" } },
	]);
	assert.ok(messages(h).includes("Context compaction completed."));
	assert.equal(h.statusCalls, 0);
});

test("reports asynchronous compaction errors and restores the queued prompt", async () => {
	const h = createHarness({ usage: 100 });
	await h.command("10k");
	h.setUsage(9001);
	assert.deepEqual(h.input({ text: "retry me" }), { action: "handled" });

	h.compactions[0].onError(new Error("provider failed"));
	assert.deepEqual(h.sent, [{ content: "retry me", options: undefined }]);
	assert.ok(messages(h).includes("Context compaction failed: provider failed"));
});

test("rolls back a queued prompt when compaction throws synchronously", async (t) => {
	for (const error of [new Error("sync failure"), "plain failure"]) {
		await t.test(String(error), async () => {
			const h = createHarness({ usage: 100 });
			await h.command("10k");
			h.setUsage(9001);
			h.setCompactThrow(error);

			assert.deepEqual(h.input({ text: "must not replay" }), { action: "continue" });
			assert.equal(h.sendAttempts.length, 0);
			assert.ok(messages(h).includes(`Context compaction failed: ${error instanceof Error ? error.message : error}`));

			h.setCompactThrow();
			h.setUsage(9000);
			assert.deepEqual(h.input(), { action: "continue" });
			h.setUsage(9001);
			assert.deepEqual(h.input({ text: "replay this" }), { action: "handled" });
			h.compactions.at(-1).onComplete({});
			assert.deepEqual(h.sent, [{ content: "replay this", options: undefined }]);
		});
	}
});

test("continues when disabled, busy, extension-authored, below threshold, or usage is unknown", async () => {
	const h = createHarness();
	assert.deepEqual(h.input(), { action: "continue" });
	await h.agentEnd();

	await h.command("10k");
	assert.deepEqual(h.input({ source: "extension" }), { action: "continue" });
	h.setIdle(false);
	assert.deepEqual(h.input(), { action: "continue" });
	h.setIdle(true);
	assert.deepEqual(h.input(), { action: "continue" });
	h.setUsage({ tokens: "unknown" });
	assert.deepEqual(h.input(), { action: "continue" });
	h.setUsage(9000);
	assert.deepEqual(h.input(), { action: "continue" });
	assert.equal(h.compactions.length, 0);
});

test("suppresses tight retries but retries after enough growth or a reset", async () => {
	const h = createHarness({ usage: 9001 });
	await h.command("10k");
	assert.equal(h.compactions.length, 1);
	await h.agentEnd();
	assert.equal(h.compactions.length, 1);
	h.compactions[0].onComplete({});

	h.setUsage(10001);
	await h.agentEnd();
	assert.equal(h.compactions.length, 1);
	h.setUsage(10002);
	await h.agentEnd();
	assert.equal(h.compactions.length, 2);
	h.compactions[1].onComplete({});

	h.setUsage(9000);
	await h.agentEnd();
	h.setUsage(9001);
	await h.agentEnd();
	assert.equal(h.compactions.length, 3);
});

test("reports queued-message delivery failures without stopping the remaining queue", async () => {
	const h = createHarness({ usage: 100 });
	await h.command("10k");
	h.setUsage(9001);
	h.failSend(0, new Error("first send"));
	h.failSend(1, "second send");

	h.input({ text: "one" });
	h.input({ text: "two" });
	h.compactions[0].onComplete({});

	assert.equal(h.sent.length, 0);
	assert.deepEqual(messages(h).filter((message) => message.startsWith("Failed to resume")), [
		"Failed to resume queued message after compaction: first send",
		"Failed to resume queued message after compaction: second send",
	]);
});

test("works without UI notifications", async () => {
	const h = createHarness({ usage: 9001, hasUI: false });
	await h.command("10k");
	assert.equal(h.compactions.length, 1);
	h.compactions[0].onComplete({});
	await h.command("invalid");
	assert.deepEqual(h.notifications, []);
	assert.equal(h.statusCalls, 0);
});
