import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appStyles = fs.readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");

test("the application shell keeps document scrolling inside owned containers", () => {
  assert.match(
    appStyles,
    /html,\s*body,\s*#app\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s,
  );
});
