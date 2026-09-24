// Compiles src/ to dist/ and copies runtime assets verbatim. The renderer reads
// client/*.js as text and runs shared/*.js as-is, so those are copied rather than
// taking tsc's re-emitted JavaScript.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", root], { stdio: "inherit" });
cpSync(join(root, "src", "client"), join(dist, "client"), { recursive: true });
cpSync(join(root, "src", "shared"), join(dist, "shared"), { recursive: true });
cpSync(join(root, "src", "index-page.html"), join(dist, "index-page.html"));
chmodSync(join(dist, "cli.js"), 0o755);
