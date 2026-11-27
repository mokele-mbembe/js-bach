export const demoAssets = {
  "/": "demo/index.html",
  "/demo.css": "demo/demo.css",
  "/demo/main.js": "dist/demo/main.js",
  "/demo/polyphony.js": "dist/demo/polyphony.js",
  "/demo/piano-roll.js": "dist/demo/piano-roll.js",
  "/demo/fugue-entrances.js": "dist/demo/fugue-entrances.js",
  "/src/oscillator-player.js": "dist/src/oscillator-player.js",
  "/src/playback-asset.js": "dist/src/playback-asset.js",
};

export function workAssets(bwv: string): string[] {
  return [`bwv${bwv}-prelude.playback.json`, `bwv${bwv}-fugue.playback.json`];
}
