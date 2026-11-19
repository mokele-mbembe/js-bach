import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname } from "node:path";
import { currentCorpus } from "./corpus-output.js";
import type { WorkSource } from "./corpus.js";

const corpus = currentCorpus();
if (!corpus) {
  console.error("Build the corpus first with npm run build:corpus, or start with npm run demo.");
  process.exit(1);
}
const catalog = new URL("catalog.json", corpus);
const { works } = JSON.parse(await readFile(catalog, "utf8")) as { works: Pick<WorkSource, "bwv">[] };

const assets = new Map<string, URL>([
  ["/", new URL("../../demo/index.html", import.meta.url)],
  ["/demo.css", new URL("../../demo/demo.css", import.meta.url)],
  ["/corpus/catalog.json", catalog],
]);

for (const path of [
  "/demo/main.js", "/src/oscillator-player.js", "/src/performance.js", "/src/rhythm-templates.js", "/src/score-ir.js",
  "/src/transposed-fragments.js",
]) {
  assets.set(path, new URL(`..${path}`, import.meta.url));
}

for (const { bwv } of works) {
  const directory = new URL(`bwv${bwv}/`, corpus);
  const { movements } = JSON.parse(await readFile(new URL("sources.json", directory), "utf8")) as WorkSource;
  const files = ["sources.json", "compression.json", ...movements.flatMap(({ id }) => [
    `${id}.json`, `${id}.rhythm.json`, `${id}.transposed.json`,
  ])];
  for (const file of files) {
    assets.set(`/corpus/bwv${bwv}/${file}`, new URL(file, directory));
  }
}

const types = new Map([
  [".html", "text/html"], [".css", "text/css"], [".js", "text/javascript"], [".json", "application/json"],
]);

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const path = request.url?.split("?", 1)[0] ?? "";
  const asset = assets.get(path);
  if (!asset) {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const contents = await readFile(asset);
    response.writeHead(200, {
      "Content-Type": `${types.get(extname(asset.pathname))}; charset=utf-8`,
      "Content-Length": contents.length,
      "Cache-Control": "no-store",
    }).end(request.method === "HEAD" ? undefined : contents);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end("Demo assets unavailable");
  }
});

server.listen(Number(process.env.PORT ?? 4173), "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(`Demo at http://127.0.0.1:${address.port}/`);
});
