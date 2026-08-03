import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("limits automatic viewport scaling only on iOS devices", () => {
  assert.match(index, /content="width=device-width, initial-scale=1\.0"/);
  assert.match(main, /\/iPad\|iPhone\|iPod\/\.test\(navigator\.userAgent\)/);
  assert.match(main, /navigator\.platform === "MacIntel" && navigator\.maxTouchPoints > 1/);
  assert.match(main, /directives\.push\("maximum-scale=1"\)/);
  assert.match(main, /limitIosViewportScale\(\);/);
});
