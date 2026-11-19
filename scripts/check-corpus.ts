import { fileURLToPath } from "node:url";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { works } from "./corpus.js";

const requested = process.argv.slice(2);
const unknown = requested.filter((bwv) => !works.some((work) => work.bwv === bwv));
if (unknown.length > 0) {
  console.error(`Unknown BWV number(s): ${unknown.join(", ")}`);
  process.exit(1);
}

const pattern = requested.length === 0 ? /^bwv\d+-/ : new RegExp(`^bwv(${requested.join("|")})-`);
const tests = run({
  files: [fileURLToPath(new URL("../test/import-mxl.test.js", import.meta.url))],
  testNamePatterns: pattern,
});
tests.on("test:fail", () => { process.exitCode = 1; });
tests.compose(spec).pipe(process.stdout);
