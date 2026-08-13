import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const tooltip = fs.readFileSync(new URL("../src/components/ui/tooltip/TooltipContent.vue", import.meta.url), "utf8");

test("shared tooltips use the neutral popover surface instead of the brand action color", () => {
  assert.match(tooltip, /border border-border bg-popover[\s\S]*text-popover-foreground shadow-md/);
  assert.doesNotMatch(tooltip, /bg-primary|text-primary-foreground/);
});
