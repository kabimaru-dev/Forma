import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Forma requires Node.js 22+."); process.exit(1); }
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(npm, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`npm ${args.join(" ")} exited with ${code}`)));
  });
}
// Compare actual source contents, not timestamps. This also handles updates
// extracted from ZIP archives where timestamps may predate an old dist build.
function sourceHash() {
  const hash = createHash("sha256");
  const visit = entry => {
    if (!existsSync(entry)) return;
    if (statSync(entry).isDirectory()) {
      for (const name of readdirSync(entry).sort()) visit(path.join(entry, name));
    } else {
      hash.update(entry);
      hash.update(readFileSync(entry));
    }
  };
  for (const entry of ["client/src", "client/public", "client/index.html", "server", "shared", "script/build.ts", "vite.config.ts", "package.json"]) visit(entry);
  return hash.digest("hex");
}
try {
  if (!existsSync("node_modules/.package-lock.json")) await run(["ci"]);
  const latest = sourceHash();
  const stampPath = "dist/.forma-source-hash";
  const last = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";
  if (!existsSync("dist/index.cjs") || !existsSync("dist/public/index.html") || latest !== last) {
    await run(["run", "build"]);
    mkdirSync("dist", { recursive: true });
    writeFileSync(stampPath, latest);
  }
  console.log("\nForma: open http://127.0.0.1:5000 (or configured PORT). Stop: Ctrl+C.\n");
  await run(["start"]);
} catch (error) { console.error(error.message); process.exit(1); }
