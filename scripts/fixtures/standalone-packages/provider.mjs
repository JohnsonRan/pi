// Adapted from pi-subagents 88639462's standalone-provider fixture.
// Only the built-in read tool sees the random fixture; no real provider calls.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export default function registerProvider(pi) {
	const faux = fauxProvider({ provider: "package-smoke", models: [{ id: "local" }], tokensPerSecond: 100000 });
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("read", { path: "/stage/work/fixture.txt" }), { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "read");
			assert.ok(result && !result.isError, "the real child must successfully execute read");
			const content = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			fs.appendFileSync("/stage/child-read.jsonl", `${JSON.stringify({ pid: process.pid, result })}\n`);
			return fauxAssistantMessage(`Fixture read: ${content}`);
		},
	]);
	pi.registerProvider(faux.provider);
	pi.on("session_start", (_event, ctx) => {
		assert.ok(ctx.sessionManager instanceof SessionManager, "use the embedded SDK, not an installed duplicate");
		assert.equal(process.env.BUN_BE_BUN, undefined, "package-manager mode must not leak into the agent");
		fs.appendFileSync("/stage/lifecycle.jsonl", `${JSON.stringify({ event: "start", pid: process.pid, executable: process.execPath, tools: pi.getActiveTools() })}\n`);
	});
	pi.on("session_shutdown", () => {
		fs.appendFileSync("/stage/lifecycle.jsonl", `${JSON.stringify({ event: "shutdown", pid: process.pid, calls: faux.state.callCount })}\n`);
	});
}
