import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const hasPandoc = !spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error;
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label) {
	for (let n = 0; n < 200; n++) { if (check()) return; await sleep(25); }
	throw new Error("Timed out waiting for " + label);
}

test("CLI opens new addresses, restarts quietly without a viewer, and supports explicit --open/--no-open", {
	skip: (!hasPandoc && "pandoc not installed") || (process.platform === "win32" && "test opener shim is POSIX-only"), timeout: 30_000,
}, async t => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "amp-cli-open-")));
	const bin = join(root, "bin"), calls = join(root, "opened.jsonl"), file = join(root, "notes.md");
	mkdirSync(bin);
	writeFileSync(file, "# Notes\n");
	// Never launch the user's browser: intercept only this child's opener.
	for (const command of ["open", "xdg-open"]) writeFileSync(join(bin, command), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });
	const opened = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
	const runs = [];
	const start = async (args, state = "state", mode = "file") => {
		const input = mode === "index" ? ["--cwd", root] : [file];
		const child = spawn(process.execPath, [cli, ...input, ...args], {
			env: { ...process.env, PATH: bin + delimiter + process.env.PATH, AGENT_MARKDOWN_PREVIEW_HOME: join(root, state), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex") },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "", errors = "";
		child.stdout.on("data", chunk => { output += chunk; });
		child.stderr.on("data", chunk => { errors += chunk; });
		const exited = new Promise(resolve => child.once("exit", resolve));
		const run = {
			get output() { return output; },
			get url() { return output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]; },
			async stop() {
				if (child.exitCode !== null || child.signalCode !== null) return;
				child.kill("SIGTERM");
				const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
				try { await exited; } finally { clearTimeout(deadline); }
			},
		};
		runs.push(run);
		await until(() => {
			if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode}: ${errors}`);
			return run.url;
		}, "CLI address");
		return run;
	};
	t.after(async () => { await Promise.all(runs.map(run => run.stop())); rmSync(root, { recursive: true, force: true }); });

	const first = await start([]);
	await until(() => opened().length === 1, "first launch opener");
	assert.equal(opened()[0][0], first.url);
	await first.stop();

	const restart = await start([]);
	assert.equal(restart.url, first.url);
	await until(() => restart.output.includes("no new tab opened"), "quiet restart without a viewer or timeout");
	await sleep(100);
	assert.equal(opened().length, 1, "a missing/delayed background tab must not trigger another opener");
	await restart.stop();

	const explicit = await start(["--open"]);
	assert.equal(explicit.url, first.url);
	await until(() => opened().length === 2, "explicit restart opener");
	await explicit.stop();

	for (const state of ["state", "fresh-state"]) {
		const quiet = await start(["--no-open"], state);
		await sleep(100);
		assert.equal(opened().length, 2, "--no-open suppresses the opener for both remembered and new addresses");
		await quiet.stop();
	}

	const overview = await start([], "overview-state", "index");
	await until(() => opened().length === 3, "first overview opener");
	await overview.stop();
	const overviewRestart = await start([], "overview-state", "index");
	assert.equal(overviewRestart.url, overview.url);
	await until(() => overviewRestart.output.includes("no new tab opened"), "quiet overview restart");
	await sleep(100);
	assert.equal(opened().length, 3, "the overview also stays quiet without a connected tab");
	await overviewRestart.stop();
});
