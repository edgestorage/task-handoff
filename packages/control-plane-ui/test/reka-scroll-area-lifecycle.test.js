import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const rekaPackagePath = require.resolve("reka-ui/package.json");
const rekaPackage = JSON.parse(fs.readFileSync(rekaPackagePath, "utf8"));
const scrollAreaThumb = fs.readFileSync(
  path.join(path.dirname(rekaPackagePath), "dist/ScrollArea/ScrollAreaThumb.js"),
  "utf8",
);

test("Reka ScrollAreaThumb cancels its polling animation frame when unmounted", () => {
  assert.equal(rekaPackage.version, "2.10.1");
  assert.match(
    scrollAreaThumb,
    /onUnmounted\(\(\) => \{[\s\S]*?removeUnlinkedScrollListenerRef\.value\?\.\(\);[\s\S]*?\}\);/,
  );
});
