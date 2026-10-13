import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
try {
  if (!existsSync("node_modules/.package-lock.json")) await run(["ci"]);
  if (!existsSync("dist/index.cjs")) await run(["run", "build"]);
  console.log("\nForma: open http://127.0.0.1:5000 (or configured PORT). Stop: Ctrl+C.\n");
  await run(["start"]);
} catch(error) { console.error(error.message); process.exit(1); }
