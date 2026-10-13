import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function listen(server) { return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); }
async function getFreePort() { const server = createServer(); const port = await listen(server); await new Promise(r => server.close(r)); return port; }
function serverProcess(port, data, env = {}) {
  return spawn(process.execPath, ["script/start.mjs"], { cwd: root, env: { ...process.env, BIND_HOST: "127.0.0.1", PORT: String(port), DATA_FILE: data, OLLAMA_HOST: "http://127.0.0.1:1", FORMA_PREVIEW: "false", ...env }, stdio: ["ignore", "pipe", "pipe"] });
}
async function waitForServer(port, child) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/api/settings`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Server readiness timeout");
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exit = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await exit;
}

test("Full local package: Ollama connection, persistence, installed models, chat, security", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "forma-test-"));
  const calls = [];
  const installed = [{ name: "existing-model:local", size: 1000000, details: { parameter_size: "1B" } }];
  const fixture = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: installed }));
    let raw = ""; for await (const chunk of req) raw += chunk;
    const json = JSON.parse(raw || "{}"); calls.push({ path: req.url, json });
    if (req.url === "/api/chat") {
      res.setHeader("Content-Type", "application/x-ndjson");
      return res.end(JSON.stringify({ message: { content: "Protocol fixture answer" }, done: false }) + "\n" + JSON.stringify({ message: { content: "" }, done: true }) + "\n");
    }
    if (req.url === "/api/pull") {
      installed.push({ name: json.model, size: 2000000 });
      res.setHeader("Content-Type", "application/x-ndjson"); return res.end('{"status":"success"}\n');
    }
    if (req.url === "/api/show") return res.end(JSON.stringify({ capabilities: ["completion"] }));
    res.statusCode = 404; res.end("{}");
  });
  const fixturePort = await listen(fixture);
  const malformed = createServer((_req,res) => { res.setHeader("Content-Type", "text/html"); res.end("<html>not Ollama</html>"); });
  const malformedPort = await listen(malformed);
  const port = await getFreePort(), base = `http://127.0.0.1:${port}`, data = path.join(dir,"test.db");
  const unavailablePort = await getFreePort();
  let child = serverProcess(port,data,{OLLAMA_HOST:`http://127.0.0.1:${unavailablePort}`});
  let logs = ""; child.stdout.on("data",x=>logs+=x); child.stderr.on("data",x=>logs+=x);
  const api = async (url, body, method = body === undefined ? "GET" : "POST", headers = {}) => {
    const response = await fetch(base+url, { method, headers: { "X-Visitor-Id":"test-user", ...(body!==undefined ? {"Content-Type":"application/json"} : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json(); return { response, json };
  };
  try {
    await waitForServer(port, child);
    await t.test("backend and Ollama errors are distinct", async () => {
      const {json} = await api("/api/status"); assert.equal(json.backend,true); assert.equal(json.connected,false); assert.match(json.message,/ECONNREFUSED/);
    });
    await t.test("edit, normalize and persist working Ollama URL without restart", async () => {
      const {json} = await api("/api/connection",{url:`127.0.0.1:${fixturePort}/api`});
      assert.equal(json.saved,true); assert.equal(json.host,`http://127.0.0.1:${fixturePort}`);
      assert.equal(json.models[0].name,"existing-model:local");
      assert.equal(calls.filter(x=>x.path==="/api/pull").length,0);
      assert.equal((await api("/api/settings")).json.ollamaUrl,json.host);
      assert.equal((await api("/api/status")).json.connected,true);
    });
    await t.test("bad endpoint diagnostics preserve last working address", async () => {
      const {json} = await api("/api/connection",{url:`http://127.0.0.1:${malformedPort}`});
      assert.equal(json.connected,false); assert.match(json.message,/не JSON/);
      assert.equal((await api("/api/status")).json.connected,true);
      const invalid=await api("/api/connection",{url:"http://user:password@localhost:11434"});
      assert.equal(invalid.response.status,400);
    });
    let id;
    await t.test("existing model streams answers using configured endpoint", async () => {
      const created = await api("/api/chats",{title:"Secret chat test",model:"existing-model:local"}); id=created.json.id;
      const response=await fetch(`${base}/api/chats/${id}/send`,{method:"POST",headers:{"Content-Type":"application/json","X-Visitor-Id":"test-user"},body:JSON.stringify({content:"Do not log this secret",model:"existing-model:local"})});
      assert.equal(response.status,200); assert.match(await response.text(),/Protocol fixture answer/);
      assert.equal((await api(`/api/chats/${id}`)).json.messages.length,2);
      assert.equal(calls.find(x=>x.path==="/api/chat").json.messages.at(-1).content,"Do not log this secret");
    });
    await t.test("visitor isolation, export, unknown API and CORS", async () => {
      assert.equal((await api(`/api/chats/${id}`,undefined,"GET",{"X-Visitor-Id":"another-user"})).response.status,404);
      const exported = await fetch(`${base}/api/chats/${id}/export`,{headers:{"X-Visitor-Id":"test-user"}});
      assert.match(exported.headers.get("content-disposition"),/\.md/); assert.match(await exported.text(),/Protocol fixture answer/);
      const unknown = await api("/api/nonexistent"); assert.equal(unknown.response.status,404);
      const denied=await api("/api/status",undefined,"GET",{"Origin":"https://unrelated.example"}); assert.equal(denied.response.status,403);
      const allowed=await api("/api/status",undefined,"GET",{"Origin":"http://localhost:5173"}); assert.equal(allowed.response.headers.get("access-control-allow-origin"),"http://localhost:5173");
      assert.equal(logs.includes("Do not log this secret"),false);
    });
    await t.test("Computer refuses models without tools, not a dead button", async () => {
      const {json}=await api("/api/computer"); assert.equal(json.enabled,true); assert.equal(json.session,null);
      const failed=await api("/api/computer/start",{task:"Read a website",model:"existing-model:local"});
      assert.equal(failed.response.status,422); assert.match(failed.json.message,/не поддерживает tools/);
    });
    await t.test("connection and chat survive server restart", async () => {
      await stop(child); child=serverProcess(port,data); await waitForServer(port,child);
      assert.equal((await api("/api/status")).json.connected,true);
      assert.equal((await api(`/api/chats/${id}`)).json.messages.length,2);
    });
    await t.test("preview blocks local connection reconfiguration and Computer execution", async () => {
      await stop(child); child=serverProcess(port,data,{FORMA_PREVIEW:"true"}); await waitForServer(port,child);
      assert.equal((await api("/api/connection",{url:`http://127.0.0.1:${fixturePort}`})).response.status,403);
      assert.equal((await api("/api/computer/start",{task:"Read",model:"existing-model:local"})).response.status,403);
      assert.equal((await api("/api/computer")).json.enabled,false);
    });
  } finally {
    await stop(child);
    await new Promise(r=>fixture.close(r)); await new Promise(r=>malformed.close(r));
    await rm(dir,{recursive:true,force:true});
  }
});
