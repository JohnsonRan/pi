import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "rebuild-from-inputs.sh");

// Disposable fixture repo input vector (rebuilt per test run; SHAs are
// resolved dynamically, so the fixture never depends on recorded object ids).
// The new-model contract: independent patches squash-merge; chain descendants
// (seam → mte → esc here) apply as predecessor-relative range diffs and must
// keep the predecessor patch tip in their ancestry.
function buildFixture() {
	const dir = mkdtempSync(join(tmpdir(), "replay-fixture-"));
	const run = (cmd) =>
		execSync(cmd, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	run("git init -q -b upstream-main .");
	run("git config user.name t");
	run("git config user.email t@invalid");
	run("git config commit.gpgsign false");
	const commit = (msg) => {
		run(`git commit -q --allow-empty -m ${JSON.stringify(msg)}`);
		return run("git rev-parse HEAD").trim();
	};
	const file = (name, content, msg, branch, from = "upstream-main") => {
		if (branch) run(`git checkout -q -B ${branch} ${from}`);
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
		execFileSync("git", ["add", "--", name], { cwd: dir });
		return commit(msg);
	};
	execFileSync("bash", ["-c", "printf 'base\\n' > f.txt && git add f.txt"], { cwd: dir });
	const upstream = commit("base");
	// ci branch: the replay helpers plus ci.txt, and an f.txt edit so the
	// conflict fixture patch conflicts with it deterministically.
	run("git checkout -q -B ci upstream-main");
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "rebuild-from-inputs.sh"), readFileSync(SCRIPT));
	execFileSync("bash", ["-c", "printf 'ci\\n' > ci.txt && printf 'ci-edited\\n' > f.txt && git add scripts ci.txt f.txt"], { cwd: dir });
	run("git commit -q -m ci-content");
	const ciSha = run("git rev-parse HEAD").trim();
	const aaa = file("aaa.txt", "aaa\n", "aaa", "patch/model-refresh");
	const seam = file("seam.txt", "seam\n", "seam", "patch/agent-run-failure-seam");
	const mte = file("mte.txt", "mte\n", "mte", "patch/managed-tool-executions", "patch/agent-run-failure-seam");
	const esc = file("esc.txt", "esc\n", "esc", "patch/esc-abort", "patch/managed-tool-executions");
	// Conflict fixture: touches f.txt which ci already edited.
	const conf = file("f.txt", "base\nconflict\n", "conf", "patch/ws-cached-empty-delta");
	// Changelog offender fixture.
	const offender = (() => {
		run("git checkout -q -B patch/quarantine-auth-storage-flake upstream-main");
		mkdirSync(join(dir, "packages", "coding-agent"), { recursive: true });
		writeFileSync(join(dir, "packages", "coding-agent", "CHANGELOG.md"), "offender\n");
		execFileSync("git", ["add", "--", "packages/coding-agent/CHANGELOG.md"], { cwd: dir });
		return commit("offender");
	})();
	run("git checkout -q upstream-main");
	return { dir, run, file, upstream, ci: ciSha, aaa, seam, mte, esc, conf, offender };
}

const CHAIN = (fixture) => [
	"--patch", `agent-run-failure-seam=${fixture.seam}`,
	"--patch", `managed-tool-executions=${fixture.mte}`,
	"--patch", `esc-abort=${fixture.esc}`,
];

function replay(fixture, args, { expectFail = false, target, diagnostic = true } = {}) {
	const targetPath = target ?? `${mkdtempSync(join(tmpdir(), "replay-target-"))}-fresh`;
	const proc = spawnSync("bash", [SCRIPT, "--source", fixture.dir, "--target", targetPath, ...(diagnostic ? ["--diagnostic"] : []), ...args], {
		cwd: fixture.dir,
		encoding: "utf8",
	});
	const status = proc.status ?? 1;
	const out = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
	if (expectFail) {
		assert.notEqual(status, 0, `expected failure, got exit 0\n${out}`);
	} else {
		assert.equal(status, 0, `expected success, got exit ${status}\n${out}`);
	}
	return { status, out, target: targetPath };
}

// Chronological commit subjects (oldest first).
const log = (repo) =>
	execSync("git log --format=%s", { cwd: repo, encoding: "utf8" })
		.trim()
		.split("\n")
		.reverse();

const HEAD = (repo) => execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();

function cleanup(fixture, target) {
	rmSync(fixture.dir, { recursive: true, force: true });
	if (target) rmSync(target, { recursive: true, force: true });
}

test("applies recorded inputs in the declared fixed order", () => {
	const fixture = buildFixture();
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-refresh=${fixture.aaa}`,
		...CHAIN(fixture),
	]);
	try {
		const subjects = log(target);
		assert.equal(subjects[0], "base");
		assert.equal(subjects[1], "merge ci branch");
		assert.equal(subjects[2], "merge patch/model-refresh branch");
		assert.equal(subjects[3], "merge patch/agent-run-failure-seam branch");
		assert.equal(subjects[4], "merge patch/managed-tool-executions branch");
		assert.equal(subjects[5], "merge patch/esc-abort branch");
		assert.equal(subjects[subjects.length - 1], "record upstream sync inputs (diagnostic subset)");
		// The marker records the exact frozen input vector.
		const body = execSync("git show -s --format=%B HEAD", { cwd: target, encoding: "utf8" });
		assert.match(body, new RegExp(`origin/patch/esc-abort ${fixture.esc}`));
		assert.match(body, new RegExp(`origin/ci ${fixture.ci}`));
		// The marker commit is empty: the replay is content-stable.
		const diff = execSync("git show --stat --format= HEAD", { cwd: target, encoding: "utf8" });
		assert.equal(diff.trim(), "");
		// Content actually present: independent patch merged, chain applied.
		assert.ok(existsSync(join(target, "aaa.txt")));
		assert.ok(existsSync(join(target, "seam.txt")));
		assert.ok(existsSync(join(target, "mte.txt")));
		assert.ok(existsSync(join(target, "esc.txt")));
	} finally {
		cleanup(fixture, target);
	}
});

test("chain descendant integrates as a predecessor-relative range diff", () => {
	const fixture = buildFixture();
	// esc-abort edits mte.txt too; the range diff must carry the descendant's
	// change without resurrecting a conflict with mte's own squashed content.
	const esc2 = fixture.file("mte.txt", "mte\nesc-edit\n", "esc-edit", "patch/esc-abort", "patch/esc-abort");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `agent-run-failure-seam=${fixture.seam}`,
		"--patch", `managed-tool-executions=${fixture.mte}`,
		"--patch", `esc-abort=${esc2}`,
	]);
	try {
		assert.equal(readFileSync(join(target, "mte.txt"), "utf8"), "mte\nesc-edit\n");
	} finally {
		cleanup(fixture, target);
	}
});

test("stop-before halts exactly before the named mutation and records a partial marker", () => {
	const fixture = buildFixture();
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-refresh=${fixture.aaa}`,
		...CHAIN(fixture),
		"--stop-before", "managed-tool-executions",
	]);
	try {
		const subjects = log(target);
		assert.ok(subjects.includes("merge patch/model-refresh branch"));
		assert.ok(subjects.includes("merge patch/agent-run-failure-seam branch"));
		assert.ok(!subjects.includes("merge patch/managed-tool-executions branch"));
		assert.ok(!existsSync(join(target, "mte.txt")));
		assert.equal(subjects[subjects.length - 1], "record upstream sync inputs (partial through managed-tool-executions)");
		const body = execSync("git show -s --format=%B HEAD", { cwd: target, encoding: "utf8" });
		assert.ok(!body.startsWith("record upstream sync inputs\n\n"), "partial marker must not match the complete key");
	} finally {
		cleanup(fixture, target);
	}
});

test("rejects a target path that already exists before any mutation", () => {
	const fixture = buildFixture();
	const existing = mkdtempSync(join(tmpdir(), "replay-existing-"));
	try {
		const { out } = replay(fixture, ["--upstream", fixture.upstream, "--ci", fixture.ci, "--patch", `model-refresh=${fixture.aaa}`], {
			expectFail: true,
			target: existing,
		});
		assert.match(out, /already exists/);
		assert.equal(HEAD(fixture.dir), fixture.upstream);
	} finally {
		cleanup(fixture);
		rmSync(existing, { recursive: true, force: true });
	}
});

test("rejects source==target before any mutation", () => {
	const fixture = buildFixture();
	try {
		const { out } = replay(
			fixture,
			["--upstream", fixture.upstream, "--ci", fixture.ci, "--patch", `model-refresh=${fixture.aaa}`],
			{ expectFail: true, target: fixture.dir },
		);
		assert.match(out, /already exists|must not equal/);
		assert.equal(HEAD(fixture.dir), fixture.upstream);
	} finally {
		cleanup(fixture);
	}
});

test("the source repository is fully untouched by a replay", () => {
	const fixture = buildFixture();
	const before = execSync("git for-each-ref", { cwd: fixture.dir, encoding: "utf8" });
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-refresh=${fixture.aaa}`,
	]);
	try {
		assert.equal(HEAD(fixture.dir), fixture.upstream);
		assert.equal(execSync("git for-each-ref", { cwd: fixture.dir, encoding: "utf8" }), before);
		assert.equal(execSync("git status --porcelain", { cwd: fixture.dir, encoding: "utf8" }), "");
	} finally {
		cleanup(fixture, target);
	}
});

test("rejects an unknown patch name", () => {
	const fixture = buildFixture();
	try {
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `not-a-real-patch=${fixture.aaa}`,
		], { expectFail: true });
		assert.match(out, /unknown patch input name/);
	} finally {
		cleanup(fixture);
	}
});

test("rejects an explicit subset without --diagnostic", () => {
	const fixture = buildFixture();
	try {
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `model-refresh=${fixture.aaa}`,
		], { expectFail: true, diagnostic: false });
		assert.match(out, /missing explicit input/);
	} finally {
		cleanup(fixture);
	}
});

test("chain ancestry guard: descendant must contain the predecessor patch tip", () => {
	const fixture = buildFixture();
	try {
		// esc-abort built straight off seam, skipping the mte ancestor.
		const bad = fixture.file("esc.txt", "esc\n", "esc", "patch/esc-abort", "patch/agent-run-failure-seam");
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `agent-run-failure-seam=${fixture.seam}`,
			"--patch", `managed-tool-executions=${fixture.mte}`,
			"--patch", `esc-abort=${bad}`,
		], { expectFail: true });
		assert.match(out, /must descend from patch\/managed-tool-executions/);
	} finally {
		cleanup(fixture);
	}
});

test("a squash conflict fails closed and names the patch", () => {
	const fixture = buildFixture();
	const { out, target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `ws-cached-empty-delta=${fixture.conf}`,
	], { expectFail: true });
	try {
		assert.match(out, /merge patch\/ws-cached-empty-delta branch conflicts: f\.txt/);
		// No fixup machinery: the conflict stays exactly where git put it.
		const status = execSync("git status --porcelain", { cwd: target, encoding: "utf8" });
		assert.match(status, /UU f\.txt/);
	} finally {
		cleanup(fixture, target);
	}
});

test("rejects a patch that carries a packages/*/CHANGELOG.md hunk", () => {
	const fixture = buildFixture();
	try {
		const { out } = replay(fixture, [
			"--upstream", fixture.upstream,
			"--ci", fixture.ci,
			"--patch", `quarantine-auth-storage-flake=${fixture.offender}`,
		], { expectFail: true });
		assert.match(out, /modifies an upstream-maintained packages\/\*\/CHANGELOG\.md/);
	} finally {
		cleanup(fixture);
	}
});

test("a second replay of the same vector reports the marker already recorded", () => {
	const fixture = buildFixture();
	const args = [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `model-refresh=${fixture.aaa}`,
	];
	const first = replay(fixture, args);
	try {
		// Point the fixture's main at the recorded marker (as origin/main would
		// look after a published sync) and replay again into a fresh target.
		const marker = execSync("git rev-parse HEAD", { cwd: first.target, encoding: "utf8" }).trim();
		fixture.run(`git fetch -q --no-tags ${first.target} ${marker} && git branch -f main FETCH_HEAD`);
		const { out } = replay(fixture, args);
		assert.match(out, /skipping rebuild/);
	} finally {
		cleanup(fixture, first.target);
	}
});

test("--print-inputs and --print-marker resolve current refs from a source repo", () => {
	// A fixture source with every PATCH_ORDER ref as a local branch, so the test
	// does not depend on the remote-tracking refs of whichever checkout runs it.
	const fixture = buildFixture();
	try {
		const order = readFileSync(SCRIPT, "utf8").match(/^PATCH_ORDER=\(\n([\s\S]*?)^\)/m)[1].trim().split(/\s+/);
		for (const name of order) fixture.run(`git branch -f patch/${name} upstream-main`);
		fixture.run(`git branch -f ci ${fixture.ci}`);
		const inputs = execFileSync("bash", [SCRIPT, "--print-inputs", "--source", fixture.dir], { encoding: "utf8" });
		assert.match(inputs, new RegExp(`^upstream/main ${fixture.upstream}$`, "m"));
		assert.match(inputs, new RegExp(`^ci ${fixture.ci}$`, "m"));
		assert.match(inputs, /^patch\/esc-abort [0-9a-f]{40}$/m);
		const marker = execFileSync("bash", [SCRIPT, "--print-marker", "--source", fixture.dir], { encoding: "utf8" });
		assert.ok(marker.startsWith(`record upstream sync inputs\n\nupstream/main ${fixture.upstream}`));
		assert.match(marker, /^applied-order ci model-refresh /m);
	} finally {
		cleanup(fixture);
	}
});

test("Codex recovery applies only its delta after the retry-patterns prerequisite", () => {
	const fixture = buildFixture();
	const patterns = fixture.file("retry-policy.txt", "terminal-patterns\n", "patterns", "patch/retry-non-retryable-patterns");
	const codex = fixture.file("retry-policy.txt", "terminal-patterns\ncodex-recovery\n", "codex", "patch/codex-websocket-recovery", "patch/retry-non-retryable-patterns");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `retry-non-retryable-patterns=${patterns}`,
		"--patch", `codex-websocket-recovery=${codex}`,
	]);
	try {
		assert.equal(readFileSync(join(target, "retry-policy.txt"), "utf8"), "terminal-patterns\ncodex-recovery\n");
		const subjects = log(target);
		assert.ok(subjects.indexOf("merge patch/retry-non-retryable-patterns branch") < subjects.indexOf("merge patch/codex-websocket-recovery branch"));
	} finally {
		cleanup(fixture, target);
	}
});

test("Codex recovery rejects a tip without its retry-patterns predecessor", () => {
	const fixture = buildFixture();
	const patterns = fixture.file("retry-policy.txt", "terminal-patterns\n", "patterns", "patch/retry-non-retryable-patterns");
	const codex = fixture.file("codex.txt", "codex\n", "codex", "patch/codex-websocket-recovery");
	const { target, out } = replay(fixture, [
		"--upstream", fixture.upstream,
		"--ci", fixture.ci,
		"--patch", `retry-non-retryable-patterns=${patterns}`,
		"--patch", `codex-websocket-recovery=${codex}`,
	], { expectFail: true });
	try {
		assert.match(out, /patch\/codex-websocket-recovery must descend from patch\/retry-non-retryable-patterns/);
	} finally {
		cleanup(fixture, target);
	}
});

test("recovery prerequisites replay as ordered ranges while presentation remains independent", () => {
	const fixture = buildFixture();
	const names = ["slow-hook-tui-only", "defer-threshold-compaction", "startup-submit-readiness", "cold-start-retry", "message-origin"];
	let predecessor = "upstream-main";
	let content = "";
	const args = ["--upstream", fixture.upstream, "--ci", fixture.ci];
	for (const name of names) {
		content += `${name}\n`;
		const branch = `patch/${name}`;
		const tip = fixture.file("recovery.txt", content, name, branch, predecessor);
		args.push("--patch", `${name}=${tip}`);
		predecessor = branch;
	}
	const presentation = fixture.file("presentation.txt", "visible errors\n", "presentation", "patch/retry-error-presentation");
	args.push("--patch", `retry-error-presentation=${presentation}`);
	const { target } = replay(fixture, args);
	try {
		assert.equal(readFileSync(join(target, "recovery.txt"), "utf8"), content);
		assert.equal(readFileSync(join(target, "presentation.txt"), "utf8"), "visible errors\n");
		assert.deepEqual(log(target), [
			"base", "merge ci branch",
			...names.slice(0, -1).map((name) => `merge patch/${name} branch`),
			"merge patch/retry-error-presentation branch",
			"merge patch/message-origin branch",
			"record upstream sync inputs (diagnostic subset)",
		]);
	} finally {
		cleanup(fixture, target);
	}
});

test("shared Chord test prerequisite integrates once for both runtime consumers", () => {
	const fixture = buildFixture();
	const deps = fixture.file("deps.txt", "websocket test deps\n", "deps", "patch/chord-websocket-test-deps");
	fixture.file("deps.txt", "websocket test deps\nportable entry\n", "portable", "patch/single-executable", "patch/chord-websocket-test-deps");
	const single = fixture.file("binary.txt", "surviving build steps\n", "follow-up", "patch/single-executable", "patch/single-executable");
	const thinking = fixture.file("thinking.txt", "surviving thinking preview\n", "thinking", "patch/thinking-preview", "patch/chord-websocket-test-deps");
	const { target } = replay(fixture, [
		"--upstream", fixture.upstream, "--ci", fixture.ci,
		"--patch", `thinking-preview=${thinking}`,
		"--patch", `single-executable=${single}`,
		"--patch", `chord-websocket-test-deps=${deps}`,
	]);
	try {
		assert.equal(readFileSync(join(target, "deps.txt"), "utf8"), "websocket test deps\nportable entry\n");
		assert.equal(readFileSync(join(target, "binary.txt"), "utf8"), "surviving build steps\n");
		assert.equal(readFileSync(join(target, "thinking.txt"), "utf8"), "surviving thinking preview\n");
		assert.deepEqual(log(target), [
			"base", "merge ci branch", "merge patch/chord-websocket-test-deps branch",
			"merge patch/single-executable branch", "merge patch/thinking-preview branch",
			"record upstream sync inputs (diagnostic subset)",
		]);
	} finally {
		cleanup(fixture, target);
	}
});

for (const consumer of ["single-executable", "thinking-preview"]) {
	test(`${consumer} cannot enter a complete replay without the Chord prerequisite input`, () => {
		const fixture = buildFixture();
		const order = readFileSync(SCRIPT, "utf8").match(/^PATCH_ORDER=\(\n([\s\S]*?)^\)/m)[1].trim().split(/\s+/);
		const args = ["--upstream", fixture.upstream, "--ci", fixture.ci];
		for (const name of order) {
			if (name !== "chord-websocket-test-deps") args.push("--patch", `${name}=${name === consumer ? fixture.aaa : fixture.upstream}`);
		}
		try {
			const { out } = replay(fixture, args, { expectFail: true, diagnostic: false });
			assert.match(out, /missing explicit input patch\/chord-websocket-test-deps/);
		} finally {
			cleanup(fixture);
		}
	});
}

for (const [ancestor, descendant] of [
	["chord-websocket-test-deps", "single-executable"],
	["chord-websocket-test-deps", "thinking-preview"],
	["slow-hook-tui-only", "defer-threshold-compaction"],
	["defer-threshold-compaction", "startup-submit-readiness"],
	["startup-submit-readiness", "cold-start-retry"],
	["cold-start-retry", "message-origin"],
]) {
	test(`${descendant} rejects a tip missing ${ancestor}`, () => {
		const fixture = buildFixture();
		const predecessor = fixture.file("predecessor.txt", "prerequisite\n", ancestor, `patch/${ancestor}`);
		const bad = fixture.file("descendant.txt", "missing prerequisite\n", descendant, `patch/${descendant}`);
		const { target, out } = replay(fixture, [
			"--upstream", fixture.upstream, "--ci", fixture.ci,
			"--patch", `${ancestor}=${predecessor}`,
			"--patch", `${descendant}=${bad}`,
		], { expectFail: true });
		try {
			assert.ok(out.includes(`patch/${descendant} must descend from patch/${ancestor}`));
		} finally {
			cleanup(fixture, target);
		}
	});
}

test("--check passes when the workflow fetch list matches the recorded inputs", () => {
	let status = 0;
	let err = "";
	try {
		execFileSync("bash", [SCRIPT, "--check"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		status = error.status ?? 1;
		err = String(error.stderr ?? "");
	}
	assert.equal(status, 0, err);
});
