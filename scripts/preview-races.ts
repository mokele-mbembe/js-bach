import assert from "node:assert/strict";
import type { Browser } from "playwright";

export async function checkPreviewRaces(browser: Browser, address: string): Promise<void> {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const ready = () => page.getByText("Ready", { exact: true }).waitFor();
  const work848 = page.locator("#works").getByText(/^BWV 848 · /);
  const work847 = page.locator("#works").getByText(/^BWV 847 · /);
  const work846 = page.locator("#works").getByText(/^BWV 846 · /);
  const panel = page.locator("#polyphony");
  const fugue847 = "**/bwv847-fugue.playback.json";
  const fugue848 = "/corpus/bwv848/bwv848-fugue.playback.json";
  const polyphonyModule = "**/demo/polyphony.js";
  let closing = false;
  let releaseCatalog!: () => void;
  const pendingCatalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  let releasePolyphony!: () => void;
  const pendingPolyphony = new Promise<void>((resolve) => { releasePolyphony = resolve; });
  let releaseFugue847!: () => void;
  const pendingFugue847 = new Promise<void>((resolve) => { releaseFugue847 = resolve; });

  try {
    await page.route("**/corpus/catalog.json", async (route) => {
      await pendingCatalog;
      if (!closing) await route.continue();
    }, { times: 1 });
    await page.route(polyphonyModule, async (route) => {
      await pendingPolyphony;
      if (!closing) await route.continue();
    }, { times: 1 });
    await page.route(fugue847, async (route) => {
      await pendingFugue847;
      if (!closing) await route.continue();
    });
    await page.goto(address, { waitUntil: "domcontentloaded" });
    await page.getByText("Fugue", { exact: true }).click();
    const polyphonyRequested = page.waitForRequest(polyphonyModule);
    releaseCatalog();
    const moduleRequest = await polyphonyRequested;
    await Promise.all([page.waitForRequest(fugue847), work847.click()]);
    releasePolyphony();
    await page.evaluate(async (url) => { await import(url); }, moduleRequest.url());
    assert.ok(!await panel.isVisible(), "The old piano roll must stay hidden after its import completes");
    releaseFugue847();
    await ready();
    assert.equal(await page.locator('input[name="movement"]:checked').inputValue(), "fugue",
      "A late catalog should preserve the selected movement");
    assert.match(await panel.getByRole("heading").textContent() ?? "", /BWV 847 fugue/i,
      "A late piano roll import should show the selected work");
    assert.equal(await panel.getByRole("checkbox").count(), 3);
    assert.equal(await panel.locator("#fugue-entrances li").count(), 3);

    // Leave the first two downloads pending until the page aborts them.
    await page.route(`**${fugue848}`, () => {}, { times: 2 });
    const [first] = await Promise.all([page.waitForRequest(`**${fugue848}`), work848.click()]);
    const [canceled, replacement] = await Promise.all([
      page.waitForEvent("requestfailed", (request) => request === first),
      page.waitForRequest((request) => request !== first && request.url().endsWith(fugue848)),
      page.evaluate(() => {
        document.querySelector<HTMLInputElement>('input[name="work"][value="846"]')!.click();
        document.querySelector<HTMLInputElement>('input[name="work"][value="848"]')!.click();
      }),
    ]);
    assert.equal(canceled.failure()?.errorText, "net::ERR_ABORTED");

    const [canceledReplacement] = await Promise.all([
      page.waitForEvent("requestfailed", (request) => request === replacement),
      work846.click(),
    ]);
    assert.equal(canceledReplacement.failure()?.errorText, "net::ERR_ABORTED");
    await ready();
    assert.match(await panel.getByRole("heading").textContent() ?? "", /BWV 846 fugue/i);
    assert.equal(await panel.getByRole("checkbox").count(), 4);

    await work848.click();
    await ready();
    assert.match(await page.locator("#catalogue").textContent() ?? "", /^BWV 848 \/ /);
    assert.match(await panel.getByRole("heading").textContent() ?? "", /BWV 848 fugue/i);
    assert.equal(await panel.getByRole("checkbox").count(), 3);
    assert.equal(await panel.locator("#fugue-entrances li").count(), 3);
    assert.equal(await page.locator("#retry").isVisible(), false);
  } finally {
    closing = true;
    releaseCatalog();
    releasePolyphony();
    releaseFugue847();
    await page.close();
  }

  await checkMissingPianoRoll(browser, address);
}

async function checkMissingPianoRoll(browser: Browser, address: string): Promise<void> {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const fallbackReady = page.getByText("Ready. Piano roll unavailable.", { exact: true });
  const fugue = page.getByText("Fugue", { exact: true });
  let scoreRequests = 0;
  let moduleRequests = 0;

  try {
    page.on("request", (request) => {
      if (request.url().endsWith("/bwv846-fugue.playback.json")) scoreRequests++;
    });
    await page.route("**/demo/polyphony.js", async (route) => {
      moduleRequests++;
      await route.abort();
    });
    await page.goto(address);
    await fugue.click();
    await fallbackReady.waitFor();
    assert.equal(moduleRequests, 1);
    assert.ok(!await page.locator("#polyphony").isVisible());
    assert.ok(!await page.locator("#retry").isVisible());

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByText("Playing Fugue", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLProgressElement>("#progress")!.value > 0.45);

    await page.getByText("Prelude", { exact: true }).click();
    await page.getByText("Ready", { exact: true }).waitFor();
    await fugue.click();
    await fallbackReady.waitFor();
    assert.equal(scoreRequests, 1, "A piano roll load failure must not evict the fugue's playback data");
  } finally {
    await page.close();
  }
}
