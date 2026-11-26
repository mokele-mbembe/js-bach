import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Request } from "playwright";

declare global {
  interface Window { jsBachPagesPitches: number[] }
}

const staticRoot = fileURLToPath(new URL("../pages", import.meta.url));
const projectPath = "/js-bach-test/";
const types = new Map([
  [".html", "text/html"],
  [".css", "text/css"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  ["", "text/plain"],
]);

async function serveStaticPages() {
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const file = resolve(staticRoot, pathname.slice(projectPath.length) || "index.html");
    const type = types.get(extname(file));
    if (!pathname.startsWith(projectPath) || !file.startsWith(`${staticRoot}${sep}`) || !type) {
      response.writeHead(404).end();
      return;
    }

    try {
      const contents = await readFile(file);
      response.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" }).end(contents);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      response.writeHead(code === "ENOENT" || code === "EISDIR" ? 404 : 500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: new URL(`http://127.0.0.1:${address.port}${projectPath}`),
    stop: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())),
  };
}

async function play(page: Page, label: string) {
  await page.evaluate(() => { window.jsBachPagesPitches = []; });
  await page.locator("#play").click();
  await page.getByText(`Playing ${label}`, { exact: true }).waitFor();
  await page.waitForFunction(() => window.jsBachPagesPitches.length > 0);
  return page.evaluate(() => window.jsBachPagesPitches[0]);
}

async function stop(page: Page) {
  await page.locator("#stop").click();
  await page.getByText("Stopped", { exact: true }).waitFor();
  assert.ok(await page.locator("#stop").isDisabled());
  assert.ok(await page.locator("#play").isEnabled());
}

async function checkPages(url: URL, local: boolean) {
  const browser = await chromium.launch({ channel: process.env.JS_BACH_BROWSER_CHANNEL });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await page.addInitScript(() => {
      window.jsBachPagesPitches = [];
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (when) {
        start.call(this, when);
        window.jsBachPagesPitches.push(Math.round(69 + 12 * Math.log2(this.frequency.value / 440)));
      };
    });

    const corpusRequests: Request[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.includes("/corpus/")) corpusRequests.push(request);
    });
    const checkCorpus = (paths: string[]) => assert.deepEqual(
      corpusRequests.map((request) => request.url()), paths.map((path) => new URL(`corpus/${path}`, url).href),
    );
    const initial = ["catalog.json", "bwv846/bwv846-prelude.playback.json"];

    const response = await page.goto(url.href);
    assert.ok(response?.ok(), `Could not open ${url.href}`);
    await play(page, "Prelude");
    checkCorpus(initial);
    const sizes = await Promise.all(corpusRequests.map((request) => request.sizes()));
    const firstScoreBytes = sizes.reduce((total, size) => total + size.responseBodySize + size.responseHeadersSize, 0);
    await stop(page);

    await page.getByText("Fugue", { exact: true }).click();
    await page.getByText("Bass", { exact: true }).click();
    assert.equal(await play(page, "Fugue · Bass"), 48, "The BWV 846 fugue bass should begin on MIDI pitch 48");
    await stop(page);

    await page.getByText("Prelude", { exact: true }).click();
    await page.locator("#works").getByText(/^BWV 869 · /).click();
    await play(page, "Prelude");
    await stop(page);
    assert.match(await page.locator("#credits").innerText(), /BWV 869/);
    checkCorpus([...initial, "bwv846/bwv846-fugue.playback.json", "bwv869/bwv869-prelude.playback.json"]);

    const licenseHref = await page.locator("#project-license").getAttribute("href");
    const licenseURL = new URL(licenseHref ?? "", url);
    assert.equal(licenseURL.href, new URL("LICENSE", url).href);
    const license = await page.request.get(licenseURL.href);
    assert.ok(license.ok(), `Could not load ${licenseURL.href}`);
    assert.match(await license.text(), /GNU GENERAL PUBLIC LICENSE/);

    const source = process.env.JS_BACH_PAGES_SOURCE_URL;
    if (source || !local) {
      const sourceHref = await page.locator("#corresponding-source").getAttribute("href");
      assert.ok(sourceHref?.startsWith("https://"), "Missing HTTPS corresponding source link");
      if (source) assert.equal(sourceHref, new URL(source).href);
    }

    if (local) assert.equal((await page.request.get(new URL("/corpus/catalog.json", url).href)).status(), 404);
    console.log(`Pages smoke passed at ${url.href}: ${initial.length} initial corpus requests, ${firstScoreBytes} response bytes with headers, playback, stop, voice solo, work switch, and licensing.`);
  } finally {
    await browser.close();
  }
}

const publishedURL = process.argv[2];
const local = publishedURL ? undefined : await serveStaticPages();
try {
  const url = local?.url ?? new URL(publishedURL);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  await checkPages(url, Boolean(local));
} finally {
  await local?.stop();
}
