import assert from "node:assert/strict";
import test from "node:test";
import { sandboxArguments } from "./smoke-standalone-packages.mjs";

// PR #5: installed-plugin acceptance must not accidentally use hosted Node/npm/Bun.
test("runtime sandbox hides executable directories and clears credentials", () => {
	const args = sandboxArguments("/fixture");
	assert.ok(args.includes("--unshare-net"));
	assert.ok(args.includes("--clearenv"));
	assert.ok(args.includes("--unshare-pid"));
	const mounts = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--tmpfs") mounts.push(args[i + 1]);
		if (args[i] === "--ro-bind") assert.doesNotMatch(args[i + 2], /\/(?:node|nodejs|npm|npx|corepack|bun|bunx)$/);
	}
	assert.deepEqual(mounts, ["/usr/bin", "/usr/local/bin"]);
	assert.ok(args.includes("PI_OFFLINE"));
	assert.ok(!args.includes("BUN_BE_BUN"));
	assert.ok(!args.includes("GITHUB_TOKEN"));
	assert.ok(!args.includes("/etc/resolv.conf"));
});

test("installation permits network without skipping update queries or exposing runtime mode", () => {
	const args = sandboxArguments("/fixture", true);
	assert.ok(!args.includes("--unshare-net"));
	assert.ok(!args.includes("PI_OFFLINE"));
	assert.ok(!args.includes("BUN_BE_BUN"));
	assert.ok(args.includes("--clearenv"));
	assert.ok(args.includes("/stage/bundle:/usr/bin:/bin"));
});
