#!/usr/bin/env node
// PR #5: exercise public package management without external Node/npm/Bun.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pins = {
	"pi-notify": "2d69229acd3037c31d4e9d566d02f6c0b92f24b9",
	"pi-subagents": "88639462aae9ba97465b203a305f3abf66bd195c",
};

export function sandboxArguments(root, network = false) {
	const args = ["--die-with-parent", "--unshare-pid"];
	if (!network) args.push("--unshare-net");
	args.push("--ro-bind", "/usr", "/usr", "--tmpfs", "/usr/bin", "--tmpfs", "/usr/local/bin", "--symlink", "usr/bin", "/bin");
	// Hide ALL host executable directories, then expose only these OS tools.
	for (const command of ["sh", "bash", "git", "env", "uname", "readlink", "dirname", "mkdir", "rm", "ln", "cat", "sleep"]) {
		const source = ["/usr/bin", "/bin"].map((dir) => path.join(dir, command)).find(fs.existsSync);
		assert.ok(source, `required system command: ${command}`);
		args.push("--ro-bind", fs.realpathSync(source), `/usr/bin/${command}`);
	}
	for (const entry of ["/lib", "/lib64", "/etc/ld.so.cache", ...(network ? ["/etc/ssl/certs", "/etc/resolv.conf", "/etc/hosts"] : [])]) {
		if (fs.existsSync(entry)) args.push("--ro-bind", entry, entry);
	}
	args.push("--proc", "/proc", "--dev", "/dev", "--bind", root, "/stage", "--bind", path.join(root, "tmp"), "/tmp", "--chdir", "/stage/work", "--clearenv");
	for (const [key, value] of Object.entries({
		PATH: "/stage/bundle:/usr/bin:/bin", HOME: "/stage/home", PI_CODING_AGENT_DIR: "/stage/agent",
		XDG_CACHE_HOME: "/stage/cache", BUN_INSTALL_CACHE_DIR: "/stage/bun-cache", JITI_FS_CACHE: "false",
		GIT_TERMINAL_PROMPT: "0", PI_SKIP_VERSION_CHECK: "1", TERM: "dumb", ...(network ? {} : { PI_OFFLINE: "1" }),
	})) args.push("--setenv", key, value);
	return args;
}

function main() {
	assert.equal(process.platform, "linux", "this acceptance requires Linux/bubblewrap; never skip");
	const [bundleArg, rootArg] = process.argv.slice(2);
	assert.ok(bundleArg && rootArg, "Usage: smoke-standalone-packages.mjs <bundle-directory> <fresh-artifact-directory>");
	const bundle = path.resolve(bundleArg), root = path.resolve(rootArg);
	assert.equal(fs.existsSync(root), false, "use a fresh artifact directory");
	fs.mkdirSync(root, { recursive: true });
	for (const name of ["home", "agent", "work/.pi/agents", "tmp", "cache", "bun-cache"]) fs.mkdirSync(path.join(root, name), { recursive: true });
	fs.cpSync(bundle, path.join(root, "bundle"), { recursive: true });
	fs.cpSync(new URL("fixtures/standalone-packages/", import.meta.url), path.join(root, "fixtures"), { recursive: true });
	const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	const receipt = { source: process.env.GITHUB_SHA, pins, binarySha256: sha(path.join(root, "bundle/pi-native")), wrapperSha256: sha(path.join(root, "bundle/pi")), checks: [], complete: false };
	const run = (name, command, args, { network = false, bun = false, cwd } = {}) => {
		const sandbox = sandboxArguments(root, network);
		if (bun) sandbox.push("--setenv", "BUN_BE_BUN", "1");
		if (cwd) sandbox.push("--chdir", cwd);
		const result = spawnSync("bwrap", [...sandbox, "--", command, ...args], { encoding: "utf8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });
		fs.writeFileSync(path.join(root, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
		receipt.checks.push({ name, network, command, args, status: result.status, error: result.error?.message });
		assert.ifError(result.error);
		return result;
	};
	const pi = (name, args) => {
		const result = run(name, "/stage/bundle/pi", args, { network: true });
		assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
	};
	const packageRoot = (name) => path.join(root, "agent/git/github.com/xz-dev", name);
	try {
		assert.equal(JSON.parse(fs.readFileSync(path.join(root, "bundle/package.json"))).piConfig.distribution, "xz-dev");
		const absence = run("no-external-runtimes", "/bin/sh", ["-c", "for x in node nodejs npm npx corepack bun bunx; do if command -v \"$x\"; then exit 1; fi; done; test -z \"${BUN_BE_BUN-}\""]);
		assert.equal(absence.status, 0, absence.stdout + absence.stderr);
		const revision = run("embedded-revision", "/stage/bundle/pi", ["--revision"], { bun: true });
		assert.equal(revision.status, 0, revision.stderr);
		assert.match(revision.stdout, /^1\.4\.2\+/);
		receipt.bunRevision = revision.stdout.trim();
		// A bounded range exercises update (exact-version pins are skipped) while admitting only one version.
		const npmSource = "npm:is-number@>=7.0.0 <=7.0.0";
		pi("npm-install", ["install", npmSource]);
		for (const [name, pin] of Object.entries(pins)) {
			pi(`${name}-install`, ["install", `git:github.com/xz-dev/${name}@${pin}`]);
		}
		// Exercise real dependency repair, not just a pinned-update no-op.
		const dependency = path.join(packageRoot("pi-notify"), "node_modules/pi-extension-utils");
		assert.ok(fs.existsSync(dependency), "the public install must materialize the Git dependency");
		fs.rmSync(dependency, { recursive: true });
		pi("package-update", ["update", "--extensions"]);
		assert.ok(fs.existsSync(dependency), "update must repair the missing runtime dependency");
		assert.equal(JSON.parse(fs.readFileSync(path.join(root, "agent/npm/node_modules/is-number/package.json"))).version, "7.0.0");
		for (const [name, pin] of Object.entries(pins)) {
			const head = run(`${name}-head-after-update`, "git", ["-C", `/stage/agent/git/github.com/xz-dev/${name}`, "rev-parse", "HEAD"]);
			assert.equal(head.status, 0, head.stderr);
			assert.equal(head.stdout.trim(), pin);
		}
		fs.renameSync(path.join(root, "bun-cache"), path.join(root, "installation-cache"));
		fs.mkdirSync(path.join(root, "bun-cache"));
		const token = randomUUID();
		fs.writeFileSync(path.join(root, "work/fixture.txt"), token);
		fs.writeFileSync(path.join(root, "work/bunfig.toml"), '[install]\nauto = "disable"\n');
		fs.writeFileSync(path.join(root, "work/negative.ts"), 'import "@earendil-works/pi-coding-agent";\n');
		const negative = run("no-ambient-sdk", "/stage/bundle/pi", ["--no-install", "/stage/work/negative.ts"], { bun: true });
		assert.notEqual(negative.status, 0);
		assert.match(negative.stderr, /Cannot find (?:module|package).*pi-coding-agent/);
		fs.writeFileSync(path.join(root, "work/.pi/agents/package-smoke.md"), "---\nname: package-smoke\ndescription: Read a fixture in a native standalone child\nmodel: package-smoke/local\ntools: read\nextensions:\n  - /stage/fixtures/provider.mjs\ncompletionGuard: false\n---\nRead the requested fixture.\n");
		fs.writeFileSync(path.join(root, "agent/pi-notify.json"), JSON.stringify({ hooks: { "agent-notify": { actions: [["shell:/bin/sh", "-c", 'printf "%s" "$PI_NOTIFY_CONTENT" > /stage/notification-marker']] } } }));
		const functional = run("installed-extensions", "/stage/bundle/pi", ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--mode", "rpc", "--provider", "package-smoke", "--model", "local", "--extension", "/stage/fixtures/provider.mjs", "--extension", "/stage/fixtures/parent.mjs"]);
		assert.equal(functional.status, 0, functional.stdout + functional.stderr);
		assert.match(functional.stdout, /PASS installed extensions/);
		assert.equal(fs.readFileSync(path.join(root, "notification-marker"), "utf8"), token);
		assert.deepEqual(fs.readdirSync(path.join(root, "bun-cache")), [], "offline execution must not install a cached SDK");
		const installedInputs = {};
		for (const name of Object.keys(pins)) {
			const directory = packageRoot(name);
			installedInputs[name] = Object.fromEntries(fs.readdirSync(directory, { recursive: true }).sort().flatMap((relative) => {
				const file = path.join(directory, relative), stat = fs.lstatSync(file);
				return stat.isSymbolicLink() ? [[relative, { link: fs.readlinkSync(file) }]] : stat.isFile() ? [[relative, { sha256: sha(file) }]] : [];
			}));
		}
		fs.writeFileSync(path.join(root, "installed-inputs.json"), JSON.stringify(installedInputs, null, 2));
		receipt.installedInputsSha256 = sha(path.join(root, "installed-inputs.json"));
		pi("npm-remove", ["remove", npmSource]);
		assert.equal(fs.existsSync(path.join(root, "agent/npm/node_modules/is-number")), false);
		for (const [name, pin] of Object.entries(pins)) {
			pi(`${name}-remove`, ["remove", `git:github.com/xz-dev/${name}@${pin}`]);
			assert.equal(fs.existsSync(packageRoot(name)), false);
		}
		assert.equal(fs.existsSync(path.join(root, "work/package.json")), false, "never create a caller manifest as a workaround");
		receipt.packageManagement = "passed";
		// Report this separately after the core flow; a known upstream defect is not a passing query.
		const control = run("metadata-with-project", "/stage/bundle/pi", ["info", "is-number@7.0.0", "version", "--json"], { network: true, bun: true, cwd: "/stage/agent/npm" });
		assert.equal(control.status, 0, control.stderr);
		const metadata = run("metadata-without-project", "/stage/bundle/pi", ["info", "is-number@7.0.0", "version", "--json"], { network: true, bun: true });
		receipt.projectlessMetadata = metadata.status === 0 ? "passed" : "failed";
		assert.equal(metadata.status, 0, "Package flow passed, but official Bun projectless metadata remains blocked; see metadata-without-project.log");
		receipt.complete = true;
	} catch (error) {
		receipt.error = String(error);
		throw error;
	} finally {
		fs.writeFileSync(path.join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
		console.log(JSON.stringify(receipt, null, 2));
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
