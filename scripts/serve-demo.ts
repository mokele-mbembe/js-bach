#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname } from "node:path";
import { gzipSync } from "node:zlib";
import { currentCorpus } from "./corpus-output.js";
import type { WorkSource } from "./corpus.js";
import { demoAssets, workAssets } from "./demo-assets.js";

const corpus = currentCorpus();
if (!corpus) {
  console.error("Build the corpus first with npm run build:corpus, or start with npm run demo.");
  process.exit(1);
}
const catalog = new URL("catalog.json", corpus);
const { works } = JSON.parse(await readFile(catalog, "utf8")) as { works: Pick<WorkSource, "bwv">[] };
const first = works[0];
if (first) {
  const filename = workAssets(first.bwv)[0];
  try {
    await access(new URL(`bwv${first.bwv}/${filename}`, corpus));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.error("The current corpus has no playback files. Rebuild it with npm run build:corpus, or start with npm run demo.");
    process.exit(1);
  }
}

const root = new URL("../../", import.meta.url);
const assets = new Map(Object.entries(demoAssets).map(([route, file]) => [route, new URL(file, root)]));
assets.set("/corpus/catalog.json", catalog);

for (const { bwv } of works) {
  const directory = new URL(`bwv${bwv}/`, corpus);
  for (const file of workAssets(bwv)) {
    assets.set(`/corpus/bwv${bwv}/${file}`, new URL(file, directory));
  }
}

const types = new Map([
  [".html", "text/html"], [".css", "text/css"], [".js", "text/javascript"], [".json", "application/json"],
]);

function scriptEncoding(acceptEncoding: string | undefined): "gzip" | "identity" | undefined {
  const weights = new Map<string, number>();
  for (const entry of acceptEncoding?.split(",") ?? []) {
    const coding = /^\s*([^;\s]+)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/iu.exec(entry);
    if (coding) weights.set(coding[1].toLowerCase(), Number(coding[2] ?? 1));
  }
  const wildcard = weights.get("*");
  const gzip = weights.get("gzip") ?? wildcard ?? 0;
  const identity = weights.get("identity");
  if (gzip > 0 && gzip >= (identity ?? 0)) return "gzip";
  if ((identity ?? (wildcard === 0 ? 0 : 1)) > 0) return "identity";
}

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

  const extension = extname(asset.pathname);
  const script = extension === ".js";
  const encoding = script ? scriptEncoding(request.headers["accept-encoding"]) : "identity";
  if (encoding === undefined) {
    response.writeHead(406, { Vary: "Accept-Encoding" }).end();
    return;
  }

  try {
    const contents = await readFile(asset);
    const compressed = encoding === "gzip";
    const body = compressed ? gzipSync(contents) : contents;
    response.writeHead(200, {
      "Content-Type": `${types.get(extension)}; charset=utf-8`,
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      ...(script ? { Vary: "Accept-Encoding" } : {}),
      ...(compressed ? { "Content-Encoding": "gzip" } : {}),
    }).end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end("Demo assets unavailable");
  }
});

server.listen(Number(process.env.PORT ?? 4173), "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(`Demo at http://127.0.0.1:${address.port}/`);
});
