import "dotenv/config";
const host = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const port = process.env.PORT || "5000";
console.log(`Node: ${process.version}\nOllama environment URL: ${host}`);
for (const [name, url] of [["Ollama", `${host}/api/tags`], ["Forma", `http://127.0.0.1:${port}/api/status`]]) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await r.json();
    console.log(`${name}: HTTP ${r.status} at ${url}`);
    if (name === "Ollama") console.log("Installed models:", json.models?.map(m => m.name).join(", ") || "none");
    else console.log("Configured Ollama:", json.host, "\nStatus:", json.message);
  } catch(e) { console.log(`${name}: ${e.cause?.code || e.name} (${e.message})`); }
}
