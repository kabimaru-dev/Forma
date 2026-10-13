// A protocol fixture for integration tests, NOT a real language model.
// Never run with the delivered preview.
import { createServer } from "node:http";
let installed = [{ name: "forma-test:local", size: 2300000000, details: { parameter_size: "3B", quantization_level: "Q4_K_M" } }];
const requests = [];
createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/tags") return res.end(JSON.stringify({ models: installed }));
  if (req.url === "/test/requests") return res.end(JSON.stringify(requests));
  let body = ""; for await (const part of req) body += part;
  const data = JSON.parse(body || "{}"); requests.push({ url: req.url, data });
  if (req.url === "/api/show") return res.end(JSON.stringify({ capabilities: data.model === "no-tools" ? ["completion"] : ["completion", "tools"] }));
  if (req.url === "/api/chat") {
    const text = data.messages.at(-1).content;
    if (data.tools) {
      const task = data.messages.find(m => m.role === "user")?.content || "";
      const toolResults = data.messages.filter(m => m.role === "tool");
      let call;
      if (!toolResults.length) call = { name: "navigate", arguments: { url: task.includes("PRIVATE") ? "http://127.0.0.1:5000" : "https://example.com" } };
      else if (toolResults.length === 1 && !toolResults[0].content.startsWith("ERROR")) call = { name: "read_page", arguments: {} };
      const message = call ? { role: "assistant", content: "", tool_calls: [{ function: call }] } : { role: "assistant", content: `Тестовый агент завершил проверку. Получено результатов инструментов: ${toolResults.length}.` };
      return res.end(JSON.stringify({ message, done: true }));
    }
    if (text.includes("TEST_ERROR")) { res.statusCode = 404; return res.end(JSON.stringify({ error: "Тест: модель не найдена." })); }
    res.setHeader("Content-Type", "application/x-ndjson");
    const answer = text.includes("TEST_LONG") ? "Тестовый длинный ответ для проверки остановки. ".repeat(50) : "Это **тест протокола Ollama**, а не ответ нейросети.\n\nСообщений в контексте: " + data.messages.length + ".\n\n```js\nconsole.log('Forma');\n```\n\nПроверка завершена.";
    const tokens = answer.match(/.{1,8}/gs) || [];
    let n = 0;
    const timer = setInterval(() => {
      if (n < tokens.length) res.write(JSON.stringify({ message: { role: "assistant", content: tokens[n++] }, done: false }) + "\n");
      else { clearInterval(timer); res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n"); }
    }, 30);
    res.on("close", () => clearInterval(timer));
    return;
  }
  if (req.url === "/api/pull") {
    res.setHeader("Content-Type", "application/x-ndjson");
    if (data.model === "bad-model") return res.end(JSON.stringify({ error: "Тест: модель не найдена в библиотеке." }) + "\n");
    let complete = 0;
    const timer = setInterval(() => {
      complete += 20;
      if (complete <= 100) res.write(JSON.stringify({ status: "pulling", completed: complete, total: 100 }) + "\n");
      else { clearInterval(timer); installed.push({ name: data.model, size: 1000000000, details: { parameter_size: "1B" } }); res.end(JSON.stringify({ status: "success" }) + "\n"); }
    }, data.model === "slow-model" ? 1200 : 100);
    res.on("close", () => clearInterval(timer)); return;
  }
  res.statusCode = 404; res.end("{}");
}).listen(Number(process.env.FIXTURE_PORT || 11434), "127.0.0.1", () => console.log(`TEST FIXTURE ONLY: ${process.env.FIXTURE_PORT || 11434}`));
