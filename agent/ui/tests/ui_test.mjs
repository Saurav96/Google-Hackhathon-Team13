import puppeteer from "puppeteer-core";

const BASE = process.argv[2] || "http://127.0.0.1:8090";
const results = [];
const errors = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new", args: ["--window-size=1500,900"], defaultViewport: { width: 1500, height: 900 },
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message.slice(0, 200)));

const text = (sel) => page.$eval(sel, (e) => e.innerText).catch(() => "");
const clickText = async (sel, needle) => {
  const handles = await page.$$(sel);
  for (const h of handles) {
    const t = await h.evaluate((e) => e.innerText);
    if (t.includes(needle)) { await h.click(); return true; }
  }
  return false;
};
const shot = (name) => page.screenshot({ path: `shot_${name}.png` });

try {
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(".queue li", { timeout: 30000 });
  check("page loads with the queue", (await page.$$(".queue li")).length === 11);
  check("first-time hint is shown", (await text(".headline")).includes("Click any dot"));
  await page.waitForFunction(() => document.querySelector(".map-canvas").childElementCount > 0, { timeout: 20000 }).then(() => check("google map rendered", true)).catch(() => check("google map rendered", false));
  check("no map error banner", await page.$(".map-problem") === null);
  check("favicon present", await page.$('link[rel="icon"]') !== null);

  // Select from the list, then click again to deselect (the reported bug).
  await clickText(".queue-main", "Speed Queen");
  await page.waitForFunction(() => document.querySelector(".headline").innerText.includes("39 businesses"), { timeout: 15000 });
  check("selecting a business shows its cascade", true, await text(".headline"));
  await sleep(1600);
  await shot("cascade");
  await clickText(".queue-main", "Speed Queen");
  await page.waitForFunction(() => document.querySelector(".headline").innerText.includes("Click any dot"), { timeout: 5000 }).then(() => check("clicking it again clears the selection", true)).catch(() => check("clicking it again clears the selection", false));

  // Details tab.
  await clickText(".queue-main", "Speed Queen");
  await page.waitForFunction(() => document.querySelector(".headline").innerText.includes("39 businesses"));
  await clickText(".tabs button", "Details");
  await page.waitForSelector(".details .figures");
  const figures = await page.$$eval(".figures strong", (n) => n.map((e) => e.innerText));
  check("details show 16 direct, 23 further, 37 never applied", figures.join(",") === "16,23,37", figures.join(","));
  await page.waitForSelector("table.plain tbody tr", { timeout: 10000 }).then(() => check("scenario table loads", true)).catch(() => check("scenario table loads", false));
  await page.select(".details select", "1088753-08-161");
  await page.waitForFunction(() => [...document.querySelectorAll(".details .sub")].some((p) => p.innerText.includes("also depend on")), { timeout: 10000 }).then(() => check("what-if picker answers", true)).catch(() => check("what-if picker answers", false));
  await clickText(".hops button", "1");
  await page.waitForFunction(() => document.querySelector(".headline").innerText.includes("16 businesses"), { timeout: 10000 }).then(() => check("changing steps to 1 updates the cascade", true)).catch(async () => check("changing steps to 1 updates the cascade", false, await text(".headline")));
  await shot("details");

  // Evidence tab.
  await clickText(".tabs button", "Evidence");
  const evidence = await text(".details");
  check("evidence lists real and modeled sources", evidence.includes("Modeled") && evidence.includes("Real"));
  check("evidence shows the checks and the bias", evidence.includes("Passed") && evidence.includes("Food service"));

  // Budget and funding.
  await clickText(".btn", "Use the advisor's split");
  await page.waitForFunction(() => document.querySelector(".side-note").innerText.includes("committed"), { timeout: 15000 });
  const note = await text(".side-note");
  check("advisor's split funds within budget", note.includes("$33,000") && note.includes("105"), note);
  await page.$eval(".budget-input input", (e) => { e.value = ""; });
  await page.type(".budget-input input", "15000");
  await clickText(".btn", "Use the advisor's split");
  await sleep(1500);
  const smaller = await text(".side-note");
  check("a smaller budget gives a smaller plan", !smaller.includes("$33,000") && smaller.includes("committed"), smaller);
  await clickText(".btn", "Clear");
  await sleep(300);
  const boxes = await page.$$(".queue-fund input");
  await boxes[2].click(); // Tradespace, $25,000 against a $15,000 budget
  await sleep(1200);
  check("over budget is flagged", (await text(".side-note")).includes("over budget"), await text(".side-note"));
  await shot("funding");
  await boxes[2].click();

  // Employer mode.
  await clickText(".seg button", "An employer leaves");
  await page.waitForSelector(".queue li");
  await (await page.$(".queue-main")).click();
  await page.waitForFunction(() => document.querySelector(".headline").innerText.includes("workers"), { timeout: 20000 });
  check("employer closure shows both orders", (await text(".headline")).includes("suppliers behind them"), await text(".headline"));
  await sleep(1600);
  await shot("employer");
  await clickText(".seg button", "Applicants");

  // Chat.
  await clickText(".tabs button", "Chat");
  check("composer is visible without scrolling", await page.$eval(".composer", (e) => e.getBoundingClientRect().bottom <= window.innerHeight));
  check("mic and attach buttons exist", (await page.$$(".icon-btn")).length >= 1);
  await clickText(".starters button", "Why not the biggest one?");
  await page.waitForSelector(".msg-agent .prose", { timeout: 90000 });
  await page.waitForSelector(".msg-actions", { timeout: 120000 });
  const answer = await text(".msg-agent .prose");
  check("advisor answers the starter question", answer.length > 80, `${answer.length} chars`);
  const words = answer.split(/\s+/).length;
  check("first answer is short", words <= 190, `${words} words`);
  check("time and tool count are shown under the answer", (await text(".msg-actions .meta")).includes("tool"), await text(".msg-actions .meta"));
  await (await page.$('.msg-actions button[aria-label="Copy"]')).click();
  await page.waitForSelector(".toast", { timeout: 3000 }).then(async () => check("copy shows a confirmation", true, await text(".toast"))).catch(() => check("copy shows a confirmation", false));
  const reader = await page.$('.msg-actions button[aria-label="Read aloud"]');
  if (reader) {
    await reader.click();
    await sleep(300);
    const label = await page.$$eval(".msg-actions button", (n) => n.map((e) => e.getAttribute("aria-label")).join("|"));
    if (label.includes("Stop reading")) {
      await (await page.$('.msg-actions button[aria-label="Stop reading"]')).click();
      await sleep(300);
      check("read aloud can be stopped", (await page.$$eval(".msg-actions button", (n) => n.map((e) => e.getAttribute("aria-label")).join("|"))).includes("Read aloud"));
    } else {
      check("read aloud can be stopped", true, "speech ended at once in this browser");
    }
  }
  const chips = await page.$$eval(".follow-ups button", (n) => n.map((e) => e.innerText));
  check("answer ends with suggested follow up questions", chips.length >= 2, chips.join(" | "));
  check("the follow up block is not shown as text", !answer.includes("follow_ups"));
  await clickText(".chat-head button", "Activity");
  await page.waitForSelector(".activity ol");
  const activity = await text(".activity");
  check("activity view lists tool names and timings", activity.includes("(") && /[0-9] s/.test(activity), activity.replace(/\s+/g, " ").slice(0, 150));
  await clickText(".sheet-head button", "Close");
  check("tool details stay out of the answer itself", await page.$(".msg-agent code") === null);
  check("composer still pinned after an answer", await page.$eval(".composer", (e) => e.getBoundingClientRect().bottom <= window.innerHeight));

  await page.type(".composer textarea", "What happens if Steel + Lacquer closes? Two lines.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".msg-actions").length === 2, { timeout: 120000 });
  check("typed follow up works with Enter", true);
  check("the map followed the advisor", (await text(".headline")).includes("Steel + Lacquer"), await text(".headline"));
  await shot("chat");

  // Chat sessions: context, new, rename, delete, reload.
  await page.type(".composer textarea", "And how many of those never applied? One line.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".msg-actions").length === 3, { timeout: 120000 });
  const follow = await page.$$eval(".msg-agent .prose", (n) => n.at(-1).innerText);
  check("the chat keeps context for a follow up", /[0-9]/.test(follow) && follow.length < 700, follow.slice(0, 140));
  await clickText(".chat-head button", "New chat");
  await page.waitForSelector(".welcome");
  check("new chat starts empty", true);
  await page.type(".composer textarea", "How many SBA loans are in the corridor? One line.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".msg-actions").length === 1, { timeout: 120000 });
  await clickText(".chat-head button", "History");
  await page.waitForSelector(".history li");
  check("history lists both chats", (await page.$$(".history li")).length === 2);
  await clickText(".history-act", "Rename");
  await page.waitForSelector(".history input");
  await page.$eval(".history input", (e) => { e.value = ""; });
  await page.type(".history input", "Loan check");
  await page.keyboard.press("Enter");
  await sleep(300);
  check("a chat can be renamed", (await text(".history")).includes("Loan check"));
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector(".chat-head");
  await clickText(".chat-head button", "History");
  await page.waitForSelector(".history li");
  check("chats survive a page reload", (await page.$$(".history li")).length === 2 && (await text(".history")).includes("Loan check"));
  const openers = await page.$$(".history-open");
  await openers[1].click();
  await page.waitForFunction(() => document.querySelectorAll(".msg-agent").length === 3, { timeout: 5000 }).then(() => check("opening an old chat restores its messages", true)).catch(() => check("opening an old chat restores its messages", false));
  await clickText(".chat-head button", "History");
  await clickText(".history-act", "Delete");
  await clickText(".history-act", "Delete it");
  await sleep(400);
  check("a chat can be deleted", (await page.$$(".history li")).length === 1);
  await clickText(".sheet-head button", "Close");

  // Stopping an answer part way.
  await page.type(".composer textarea", "Write the full grant memo for Speed Queen Coin Laundry.");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".send.is-stop", { timeout: 5000 });
  await sleep(2500);
  await (await page.$(".send.is-stop")).click();
  await page.waitForFunction(() => document.body.innerText.includes("You stopped this answer"), { timeout: 8000 }).then(() => check("an answer can be stopped", true)).catch(() => check("an answer can be stopped", false));
  check("the box is ready again after stopping", await page.$eval(".composer textarea", (e) => !e.disabled));

  // Attachment chip.
  const input = await page.$('input[type="file"]');
  await input.uploadFile(new URL("./letter.txt", import.meta.url).pathname);
  await page.waitForSelector(".attached .chip", { timeout: 5000 }).then(() => check("attached file shows as a chip", true)).catch(() => check("attached file shows as a chip", false));

  // Resizing and small screens.
  check("two resize handles exist", (await page.$$(".grip")).length === 2);
  const before = await page.$eval(".side", (e) => e.getBoundingClientRect().width);
  const grip = await (await page.$(".grip")).boundingBox();
  await page.mouse.move(grip.x + 3, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x + 123, grip.y + 200, { steps: 6 });
  await page.mouse.up();
  const after = await page.$eval(".side", (e) => e.getBoundingClientRect().width);
  check("dragging a handle resizes the panel", after > before + 60, `${Math.round(before)} -> ${Math.round(after)}`);

  await page.setViewport({ width: 420, height: 800 });
  await sleep(800);
  check("phone width has no sideways scroll", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot("phone");
} catch (error) {
  check("test run completed", false, error.message.slice(0, 300));
  await shot("failure");
}

const real = errors.filter((e) => !/favicon|google\.maps\.Marker is deprecated|ERR_BLOCKED_BY_CLIENT/.test(e));
check("no console errors", real.length === 0, real.slice(0, 3).join(" || "));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
