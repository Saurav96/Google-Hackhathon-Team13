// Click-through checks for the interactive report. Run: node ui_test.mjs http://localhost:8080
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] || "http://127.0.0.1:8090";
const results = [];
const errors = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + String(detail).replace(/\s+/g, " ").slice(0, 150) : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new", defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message.slice(0, 200)));

const text = (sel) => page.$eval(sel, (e) => e.innerText).catch(() => "");
const clickText = async (sel, needle) => {
  for (const h of await page.$$(sel)) {
    if ((await h.evaluate((e) => e.innerText)).includes(needle)) { await h.click(); return true; }
  }
  return false;
};
const stat = async (label) => page.$$eval(".stats > div", (divs, l) => divs.find((d) => d.innerText.includes(l))?.querySelector("strong")?.innerText || "", label);
const until = (fn, timeout, ...args) => page.waitForFunction(fn, { timeout }, ...args).then(() => true).catch(() => false);
const shot = (name) => page.screenshot({ path: `shot_${name}.png` });
const answers = () => page.$$eval(".msg-actions", (n) => n.length);
const askAndWait = async (question, timeout = 150000) => {
  const before = await answers();
  await page.type(".composer textarea", question);
  await page.keyboard.press("Enter");
  return until((n) => document.querySelectorAll(".msg-actions").length === n + 1 && !document.querySelector(".send.is-stop"), timeout, before);
};
const setBudget = async (value) => {
  await (await page.$('.stats button[aria-label="Change the budget"]')).click();
  await page.waitForSelector(".stats input");
  await page.$eval(".stats input", (e) => { e.value = ""; });
  await page.type(".stats input", String(value));
  await page.keyboard.press("Enter");
  await sleep(1200);
};

try {
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector("table.grid tbody tr", { timeout: 30000 });

  // First open.
  check("opens on the interactive report", (await text(".report-head h1")).includes("Relief funding recommendation"));
  check("report is on the left and wider, advisor on the right", await page.evaluate(() => { const r = document.querySelector(".report").getBoundingClientRect(), a = document.querySelector(".advisor").getBoundingClientRect(); return r.left < a.left && r.width > 2 * a.width; }));
  await until(() => document.querySelector(".report-head .state")?.innerText !== "Analyzing", 15000);
  check("the report shows its state", (await text(".report-head .state")) === "Draft", await text(".report-head .state"));
  check("no details or evidence tabs", await page.$(".tabs") === null);
  await until(() => document.querySelectorAll(".stats strong")[1]?.innerText === "$33,000", 15000);
  check("a draft is ready without asking the advisor", (await stat("Proposed")) === "$33,000" && (await stat("Modeled reach")) === "105", `${await stat("Proposed")} / ${await stat("Modeled reach")}`);
  check("the draft is labeled as a draft", (await text(".sec")).includes("Draft"));
  check("sample applicants are labeled as demo inputs", (await text(".table-head")).includes("Demo applicants"));
  check("six report sections are present", (await page.$$(".sec")).length === 6);
  check("google map rendered", await until(() => document.querySelector(".map-canvas")?.childElementCount > 0, 20000));
  check("favicon present", await page.$('link[rel="icon"]') !== null);
  await shot("report");

  // Budget and selection, edited directly.
  await setBudget(0);
  check("a budget of $0 stays $0", (await stat("Budget")).startsWith("$0"), await stat("Budget"));
  check("over budget is flagged", (await text(".stats")).includes("Over budget"));
  await setBudget(50000);
  const boxes = await page.$$("table.grid tbody input[type=checkbox]");
  await boxes[0].click();
  await sleep(1500);
  check("ticking an applicant updates the totals", (await stat("Proposed")) === "$48,000", await stat("Proposed"));
  await boxes[0].click();
  await sleep(1200);
  check("unticking restores them", (await stat("Proposed")) === "$33,000");
  check("why money is left over is explained from the plan", await clickText("summary", "unallocated") && (await text(".why")).includes("Hub"));

  // Text edits and freshness.
  await clickText(".narrative-meta .ghost", "Edit");
  await page.waitForSelector(".narrative-edit textarea");
  await page.$eval(".narrative-edit textarea", (e) => { e.value = ""; });
  await page.type(".narrative-edit textarea", "Committee note: fund the four anchors first.");
  await clickText(".narrative-edit .btn", "Save text");
  await sleep(400);
  check("the officer can edit section text", (await text(".narrative")).includes("Committee note") && (await text(".narrative-meta")).includes("Current"));
  await setBudget(40000);
  check("edited text is marked stale when inputs change", (await text(".narrative-meta")).includes("Needs update"));
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector("table.grid tbody tr");
  check("edits and budget survive a reload", (await text(".narrative")).includes("Committee note") && (await stat("Budget")).startsWith("$40,000"));

  // Revisions.
  const revisionBefore = await text(".report-head .sub");
  await clickText(".bar-tools button", "Revisions");
  await page.waitForSelector(".menu li");
  check("revision history lists the changes", (await page.$$(".menu li")).length >= 5, await text(".menu li"));
  const restoreButtons = await page.$$(".menu li button");
  await restoreButtons[restoreButtons.length - 1].click();
  await sleep(1200);
  check("an earlier revision can be restored as a new one", (await stat("Budget")).startsWith("$50,000") && (await text(".report-head .sub")) !== revisionBefore, await text(".report-head .sub"));

  // Map, card and links.
  await clickText(".link-row", "Speed Queen");
  check("selecting a business shows its cascade", await until(() => document.querySelector(".headline")?.innerText.includes("39 businesses"), 15000), await text(".headline"));
  check("a card opens on the map", (await text(".card")).includes("outside the demo queue") && (await text(".card")).includes("Requested grant") && (await text(".card")).includes("Public record"));
  check("the chat stays visible", await page.$(".composer textarea") !== null);
  check("links are also available as a list", await page.$$eval("summary", (n) => n.some((e) => e.innerText.includes("Every link in this view"))));
  await clickText(".card .btn", "More details");
  check("the card expands for chains", (await text(".card-more")).includes("→"));
  await page.select(".steps-pick select", "1");
  check("changing steps updates the cascade", await until(() => document.querySelector(".headline")?.innerText.includes("16 businesses"), 10000));
  await clickText(".chips button", "Worker spending");
  await clickText(".chips button", "All links");
  await page.evaluate(() => document.getElementById("sec-impact").scrollIntoView());
  await sleep(1500);
  await shot("map");
  await clickText(".map-tools .ghost", "Clear selection");
  check("clear selection resets the map", await until(() => document.querySelector(".headline")?.innerText.includes("Click any dot"), 5000));

  // Employer closure.
  await page.evaluate(() => document.querySelector(".report").scrollTo(0, 0));
  await clickText(".sec .seg button", "Employer closure");
  await page.waitForSelector(".blocks button");
  await (await page.$(".blocks button")).click();
  check("employer closure shows shops then suppliers", await until(() => document.querySelector(".headline")?.innerText.includes("suppliers behind them"), 20000), await text(".headline"));
  check("allocation sections are hidden for a closure", (await page.$$(".sec")).length === 3);
  check("closure links are listed for keyboard users", await clickText("summary", "Every link in this view") && (await text(".report")).includes("workers allocated"));
  await page.evaluate(() => document.getElementById("sec-impact").scrollIntoView());
  await sleep(1800);
  await shot("employer");
  await page.evaluate(() => document.querySelector(".report").scrollTo(0, 0));
  await clickText(".sec .seg button", "Allocate relief");
  await page.waitForSelector("table.grid tbody tr");

  // Other sections.
  check("alternatives compares every applicant", (await page.$$eval(".sec", (s) => s[2].querySelector("table").querySelectorAll("tbody tr").length)) === 11);
  check("businesses outside the queue are listed from the whole corridor", await until(() => document.querySelectorAll(".sec")[2]?.innerText.includes("Outside the queue"), 8000));
  check("scenarios show stated assumptions", await until(() => document.querySelectorAll(".sec")[3]?.innerText.includes("Cautious"), 10000));
  check("neighborhood audit reflects the selection", (await page.$$eval(".sec", (s) => s[4].innerText)).includes("Funded, poverty"));

  // Section discussion and proposals.
  await clickText(".sec-tools .ghost", "Discuss");
  check("discuss sets a section badge in the chat", (await text(".scope")).includes("Discussing: Recommendation"));
  const selectionBefore = await stat("Proposed");
  check("advisor answers a budget change request", await askAndWait("Recalculate the split for a 20,000 dollar budget."));
  check("the answer became a reviewable proposal", await until(() => document.querySelector(".proposal-card"), 8000), await text(".proposal-card h3"));
  check("asking did not change the report", (await stat("Proposed")) === selectionBefore && (await stat("Budget")).startsWith("$50,000"));
  await shot("proposal");
  await clickText(".proposal-actions .btn", "Dismiss");
  await sleep(300);
  check("a proposal can be dismissed", await page.$(".proposal-card") === null && (await stat("Proposed")) === selectionBefore);
  check("advisor proposes again on request", await askAndWait("Propose the split for a 20,000 dollar budget again.") && await until(() => document.querySelector(".proposal-list"), 8000));
  await clickText(".proposal-actions .btn", "Apply changes");
  await sleep(1500);
  check("applying a proposal updates the whole report", (await stat("Budget")).startsWith("$20,000") && (await stat("Proposed")) !== selectionBefore, `${await stat("Budget")} / ${await stat("Proposed")}`);

  check("advisor proposes a wording change", await askAndWait("Make the recommendation text clearer for the committee. Explain that reach does not mean businesses saved."));
  const hasDiff = await until(() => document.querySelector(".diff-after"), 8000);
  check("a text edit shows before and after", hasDiff, await text(".diff-after"));
  if (hasDiff) {
    const after = await text(".diff-after p");
    await clickText(".proposal-actions .btn", "Apply changes");
    await sleep(600);
    check("applied text appears in the report", (await text(".narrative")).includes(after.slice(0, 40)), await text(".narrative-meta"));
  }
  const first = await text(".msg-agent .prose");
  check("chat answers stay short", first.split(/\s+/).length <= 190, `${first.split(/\s+/).length} words`);
  check("follow up questions are offered", (await page.$$(".follow-ups button")).length >= 2);

  // Export.
  const exported = await page.evaluate(async () => {
    const snapshot = { revision: 9, budget_usd: 20000, selection_ids: ["0375063-01-001"], narrative: "Test.", notes_markdown: "", subject_id: "", employer_block_id: "", scope: "allocation", needs_update: false };
    const out = {};
    for (const format of ["pdf", "md"]) {
      const r = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format, snapshot }) });
      out[format] = { status: r.status, type: r.headers.get("content-type"), body: format === "md" ? await r.text() : (await r.blob()).size };
    }
    return out;
  });
  check("PDF export works", exported.pdf.status === 200 && exported.pdf.type.includes("pdf") && exported.pdf.body > 2000, `${exported.pdf.body} bytes`);
  check("Markdown export matches the report, not the default plan", exported.md.status === 200 && exported.md.body.includes("$20,000") && exported.md.body.includes("$8,000") && !exported.md.body.includes("$33,000"));
  await clickText(".bar-tools button", "Export");
  await page.mouse.click(500, 500);
  await sleep(200);
  check("a menu closes when you click outside it", await page.$(".menu") === null);
  await clickText(".bar-tools button", "Revisions");
  await page.mouse.click(500, 500);
  await sleep(200);
  check("the revisions menu closes the same way", await page.$(".menu") === null);
  await clickText(".bar-tools button", "Export");
  check("export menu offers PDF and Markdown", (await text(".menu")).includes("PDF report") && (await text(".menu")).includes("Markdown") && (await text(".menu")).includes("revision"));
  await clickText(".menu button", "Markdown");
  check("exporting confirms the revision", await until(() => document.querySelector(".toast")?.innerText.includes("Exported revision"), 8000), await text(".toast"));

  // Chat conveniences.
  await (await page.$('.msg-actions button[aria-label="Copy"]')).click();
  check("copy shows a confirmation", await until(() => [...document.querySelectorAll(".toast")].some((t) => t.innerText.includes("Copied")), 3000));
  await clickText(".chat-head button", "Activity");
  check("activity lists tools and timings", await until(() => /[0-9] s/.test(document.querySelector(".activity")?.innerText || ""), 5000));
  await page.mouse.click(500, 500);
  await sleep(200);
  check("activity closes when you click outside it", await page.$(".sheet-over") === null);
  await clickText(".chat-head button", "New chat");
  await page.waitForSelector(".welcome");
  check("a new chat keeps the report", (await stat("Budget")).startsWith("$20,000"));
  await clickText(".chat-head button", "History");
  check("chat history lists the earlier chat", (await page.$$(".history li")).length >= 1);
  await (await page.$(".history-open")).click();
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(1200);
  check("after a reload the chat sits at its newest message", await page.evaluate(() => { const el = document.querySelector(".chat-scroll"); return el.scrollHeight - el.scrollTop - el.clientHeight < 40; }));
  await clickText(".chat-head button", "New chat");
  await clickText(".chat-head button", "History");
  await clickText(".sheet-head button", "Close");
  await page.type(".composer textarea", "Write the full grant memo for the grants selected in my report.");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".send.is-stop", { timeout: 5000 });
  await sleep(2500);
  await (await page.$(".send.is-stop")).click();
  check("an answer can be stopped", await until(() => document.body.innerText.includes("You stopped this answer"), 8000));

  // Sources, theme, layout.
  await clickText(".bar-tools button", "Sources and methodology");
  check("sources open in a drawer", await until(() => document.querySelector(".drawer")?.innerText.includes("Modeled"), 5000));
  await page.keyboard.press("Escape");
  await (await page.$('.bar-tools button[aria-label^="Switch to"]')).click();
  await page.reload({ waitUntil: "networkidle2" });
  check("dark mode survives a reload", await page.evaluate(() => document.documentElement.dataset.theme === "dark"));
  await sleep(1500);
  await shot("dark");
  await (await page.$('.bar-tools button[aria-label^="Switch to"]')).click();
  check("a resize handle exists", (await page.$$(".grip")).length === 1);
  await clickText(".bar-tools button", "Hide advisor");
  await sleep(300);
  check("the advisor can be hidden and the report widens", await page.$(".advisor") === null && await page.evaluate(() => document.querySelector(".report").getBoundingClientRect().width > 1300));
  await clickText(".bar-tools button", "Advisor");
  await sleep(300);
  for (const [w, h] of [[1024, 768], [390, 844]]) {
    await page.setViewport({ width: w, height: h });
    await sleep(900);
    check(`no sideways scroll at ${w}px`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  }
  await shot("phone");
} catch (error) {
  check("test run completed", false, error.message);
  await shot("failure");
}

const real = errors.filter((e) => !/favicon|google\.maps\.Marker is deprecated|ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(e));
check("no console errors", real.length === 0, real.slice(0, 3).join(" || "));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
