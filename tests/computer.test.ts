import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { computerTestHelpers as h } from "../server/computer";

test("Computer refuses private, file and metadata URLs", async () => {
  for (const url of ["http://127.0.0.1", "http://[::1]", "http://10.0.0.1", "http://169.254.169.254", "file:///etc/passwd", "http://localhost:5000", "https://user:secret@example.com"]) {
    await assert.rejects(h.publicUrl(url));
  }
});
test("Computer tools: text entry, full form review, changed targets, clicks, keypress, scroll and stop", { skip: !existsSync(chromium.executablePath()) ? "Run npm run setup:computer to enable browser tests." : false }, async () => {
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<form action="https://example.com/submit" method="post">
      <label>Name <input name="name" aria-label="Name"></label>
      <input name="hiddenField" type="hidden" value="exact hidden payload">
      <button type="button" onclick="document.querySelector('#result').textContent='clicked'">Click safely</button>
    </form><input type="password" aria-label="Password"><input autocomplete="cc-number" aria-label="Card">
    <p id="result"></p><div style="height:2000px">Long page</div>`);
    const s: any = { page, controller: new AbortController(), status: "running", elements: new Map() };
    const snap = JSON.parse(await h.observe(s));
    const input = snap.elements.find((e: any) => e.tag === "input" && e.type !== "password" && e.text === "Name");
    const fill = await h.prepare(s, { function: { name: "fill", arguments: { element: input.id, text: "Approved exact text" } } });
    assert.equal(fill.args.text, "Approved exact text");
    assert.equal(await page.locator('[name="name"]').inputValue(), "", "preparing an action must not execute it");
    await h.execute(s, fill);
    assert.equal(await page.locator('[name="name"]').inputValue(), "Approved exact text");
    const password = [...s.elements.values()].find((e:any)=>e.type==="password") as any;
    await assert.rejects(h.prepare(s,{function:{name:"fill",arguments:{element:password.id,text:"secret"}}}),/парол/);
    const card = [...s.elements.values()].find((e:any)=>e.text==="Card") as any;
    await assert.rejects(h.prepare(s,{function:{name:"fill",arguments:{element:card.id,text:"1111"}}}),/платёж/);
    const button = [...s.elements.values()].find((e:any)=>e.tag==="button") as any;
    const click=await h.prepare(s,{function:{name:"click",arguments:{element:button.id}}});
    assert.equal(click.form?.method, "post");
    assert.equal(click.form?.action,"https://example.com/submit");
    assert.deepEqual(click.form?.fields,[{name:"name",value:"Approved exact text"},{name:"hiddenField",value:"exact hidden payload"}]);
    await page.locator('[name="name"]').fill("Changed since approval");
    await assert.rejects(h.execute(s,click),/изменились/);
    await page.locator('[name="name"]').fill("Approved exact text");
    await h.execute(s,click);
    assert.equal(await page.locator("#result").innerText(),"clicked");
    const key=await h.prepare(s,{function:{name:"press",arguments:{key:"Tab"}}}); await h.execute(s,key);
    const scroll=await h.prepare(s,{function:{name:"scroll",arguments:{direction:"down"}}}); await h.execute(s,scroll);
    const read=await h.prepare(s,{function:{name:"read_page",arguments:{}}}); const result=JSON.parse(await h.execute(s,read));
    assert.match(result.text,/clicked/); assert.match(s.screenshot,/^data:image\/jpeg;base64,/);
    s.controller.abort();
    await assert.rejects(h.execute(s,read),/остановлена/);
  } finally { await browser.close(); }
});
