import assert from "node:assert/strict";
import type { Browser } from "playwright";

export async function checkPreviewRaces(browser: Browser, address: string): Promise<void> {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const ready = () => page.getByText("Ready", { exact: true }).waitFor();
  const work848 = page.locator("#works").getByText(/^BWV 848 · /);
  const work846 = page.locator("#works").getByText(/^BWV 846 · /);
  const fugue848 = "/corpus/bwv848/bwv848-fugue.playback.json";
  let releaseCatalog!: () => void;
  const pendingCatalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });

  try {
    await page.route("**/corpus/catalog.json", async (route) => {
      await pendingCatalog;
      await route.continue();
    }, { times: 1 });
    await page.goto(address, { waitUntil: "domcontentloaded" });
    await page.getByText("Fugue", { exact: true }).click();
    releaseCatalog();
    await ready();
    assert.equal(await page.locator('input[name="movement"]:checked').inputValue(), "fugue",
      "A late catalog should preserve the selected movement");
    assert.ok(await page.locator("#voices").isVisible(), "The default work should load its fugue");

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

    await work848.click();
    await ready();
    assert.match(await page.locator("#catalogue").textContent() ?? "", /^BWV 848 \/ /);
    assert.equal(await page.locator("#retry").isVisible(), false);
  } finally {
    releaseCatalog();
    await page.close();
  }
}
