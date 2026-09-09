// Load the actual public-installed trees, never source-staged dependency copies.
// Completion/exit checks follow pi-subagents 88639462's standalone-parent fixture.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import registerNotify from "/stage/agent/git/github.com/xz-dev/pi-notify/index.ts";
import registerSubagents from "/stage/agent/git/github.com/xz-dev/pi-subagents/index.ts";

function waitForFile(file, predicate) {
	return new Promise((resolve) => {
		const check = () => {
			if (fs.existsSync(file) && predicate(fs.readFileSync(file, "utf8"))) {
				fs.unwatchFile(file, check);
				resolve();
			}
		};
		fs.watchFile(file, { interval: 25 }, check);
		check();
	});
}

export default function registerAcceptance(pi) {
	const tools = new Map();
	let deliver, notifications = 0;
	const notification = new Promise((resolve) => { deliver = resolve; });
	const host = new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") return (definition) => {
				target.registerTool(definition);
				tools.set(definition.name, definition);
			};
			if (key === "sendMessage") return (message, options) => {
				// Keep real completion delivery, but never trigger an unrelated parent model request.
				target.sendMessage(message, { ...options, triggerTurn: false });
				if (message.customType === "subagent-notify") { notifications++; deliver(message); }
			};
			return Reflect.get(target, key);
		},
	});
	registerNotify(host);
	registerSubagents(host);
	pi.on("session_start", async (_event, ctx) => {
		const timeout = setTimeout(() => { console.error("Installed extension acceptance timed out"); process.exit(1); }, 60_000);
		try {
			assert.ok(tools.has("agent_notify"), "installed pi-notify must register its configured public tool");
			assert.ok(tools.has("subagent"), "installed pi-subagents must register its public tool");
			const token = fs.readFileSync("/stage/work/fixture.txt", "utf8");
			const signal = new AbortController().signal;
			await tools.get("agent_notify").execute("notify-acceptance", { title: "Standalone acceptance", content: token }, signal, undefined, ctx);
			await waitForFile("/stage/notification-marker", (text) => text === token);
			const launch = await tools.get("subagent").execute("child-acceptance", {
				agent: "package-smoke", task: "Read /stage/work/fixture.txt and return its contents.",
				model: "package-smoke/local", context: "fresh", async: true, acceptance: false, timeoutMs: 30000, output: false,
			}, signal, undefined, ctx);
			assert.notEqual(launch.isError, true, JSON.stringify(launch));
			fs.writeFileSync("/stage/launch.json", JSON.stringify(launch, null, 2));
			const completed = await notification;
			fs.writeFileSync("/stage/notification.json", JSON.stringify(completed, null, 2));
			assert.ok(JSON.stringify(completed).includes(token), "normal parent notification must contain the actual child read result");
			const runDir = launch.details.asyncDir;
			const status = JSON.parse(fs.readFileSync(`${runDir}/status.json`, "utf8"));
			assert.equal(status.state, "complete");
			assert.notEqual(status.pid, process.pid);
			assert.equal(status.sessionId, ctx.sessionManager.getSessionId());
			assert.equal(status.steps[0].model, "package-smoke/local");
			const read = fs.readFileSync("/stage/child-read.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(read.length, 1);
			assert.equal(read[0].pid, status.pid);
			assert.ok(JSON.stringify(read[0].result).includes(token));
			await waitForFile(`${runDir}/process-terminal.json`, (text) => JSON.parse(text).state === "observed");
			const terminal = JSON.parse(fs.readFileSync(`${runDir}/process-terminal.json`, "utf8"));
			assert.ok(terminal.instances.some((instance) => instance.kind === "runner" && instance.exitCode === 0));
			assert.throws(() => process.kill(status.pid, 0), { code: "ESRCH" }, "child must exit before sandbox teardown");
			const lifecycle = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const starts = lifecycle.filter((entry) => entry.event === "start" && entry.pid === status.pid);
			assert.equal(starts.length, 1, "bootstrap must not start an extra child session");
			assert.deepEqual(starts[0].tools, ["read"]);
			assert.ok(lifecycle.some((entry) => entry.event === "shutdown" && entry.pid === status.pid && entry.calls === 2));
			assert.equal(notifications, 1);
			console.log("PASS installed extensions: real notification action, child fixture read, normal completion, observed exit");
			process.exit(0);
		} catch (error) {
			console.error(error);
			process.exit(1);
		} finally {
			clearTimeout(timeout);
		}
	});
}
