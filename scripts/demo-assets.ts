import type { WorkSource } from "./corpus.js";

export const demoAssets = {
  "/": "demo/index.html",
  "/demo.css": "demo/demo.css",
  "/demo/main.js": "dist/demo/main.js",
  "/src/oscillator-player.js": "dist/src/oscillator-player.js",
  "/src/performance.js": "dist/src/performance.js",
  "/src/rhythm-templates.js": "dist/src/rhythm-templates.js",
  "/src/score-ir.js": "dist/src/score-ir.js",
  "/src/transposed-fragments.js": "dist/src/transposed-fragments.js",
  "/src/score-repeats.js": "dist/src/score-repeats.js",
  "/src/score-ties.js": "dist/src/score-ties.js",
};

export function workAssets({ movements }: Pick<WorkSource, "movements">): string[] {
  return ["sources.json", "compression.json", ...movements.flatMap(({ id }) => [
    `${id}.json`, `${id}.rhythm.json`, `${id}.transposed.json`,
  ])];
}
