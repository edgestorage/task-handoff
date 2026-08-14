import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceDetail.css", import.meta.url), "utf8");

test("mobile instance summary uses a compact two-row layout", () => {
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.instance-detail\s*\{[^}]*padding: 8px;/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.instance-detail-layout\s*\{[^}]*height: 100%;[^}]*min-height: 0;/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.detail-head\s*\{[^}]*gap: 8px;[^}]*margin-bottom: 8px;/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.detail-head p\s*\{\s*display: none;/);
  assert.match(styles, /\.detail-name-button,\s*\.detail-name-input\s*\{[^}]*font-size: 20px;/s);
  assert.match(styles, /\.detail-side\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*justify-content: space-between;/s);
});

test("mobile instance actions stay accessible while rendering as icon buttons", () => {
  assert.match(styles, /\.instance-controls > button\s*\{[^}]*width: 32px;[^}]*height: 32px;[^}]*padding: 0;/s);
  assert.match(styles, /\.instance-controls > button > span\s*\{[^}]*width: 1px;[^}]*clip-path: inset\(50%\);[^}]*white-space: nowrap;/s);
});
