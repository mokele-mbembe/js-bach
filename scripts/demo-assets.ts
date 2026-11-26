export const demoAssets = {
  "/": "demo/index.html",
  "/demo.css": "demo/demo.css",
  "/demo/main.js": "dist/demo/main.js",
  "/src/oscillator-player.js": "dist/src/oscillator-player.js",
  "/src/performance.js": "dist/src/performance.js",
  "/src/playback-asset.js": "dist/src/playback-asset.js",
  "/src/score-ir.js": "dist/src/score-ir.js",
  "/src/score-repeats.js": "dist/src/score-repeats.js",
  "/src/score-ties.js": "dist/src/score-ties.js",
};

export function workAssets(bwv: string): string[] {
  return [`bwv${bwv}-prelude.playback.json`, `bwv${bwv}-fugue.playback.json`];
}
