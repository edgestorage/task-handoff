const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("runtime releases map stable to latest and isolate prerelease dist-tags", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "runtime-release.yml"), "utf8");

  assert.match(workflow, /npm_tag="latest"/);
  assert.match(workflow, /npm_tag="\$\{prerelease%%\.\*\}"/);
  assert.match(workflow, /"\$npm_tag" != "alpha" && "\$npm_tag" != "beta"/);
  assert.match(workflow, /NPM_DIST_TAG: \$\{\{ steps\.version\.outputs\.npm_tag \}\}/);
  assert.equal((workflow.match(/npm publish .* --tag "\$NPM_DIST_TAG"/g) || []).length, 4);
  assert.match(workflow, /Keep prereleases out of the latest dist-tag/);
  assert.match(workflow, /if \[\[ "\$latest" == "\$RELEASE_VERSION" \]\]/);
  assert.match(workflow, /npm dist-tag rm "\$package" latest/);
  assert.doesNotMatch(workflow, /npm_tag="stable"/);
  assert.doesNotMatch(workflow, /npm dist-tag add/);
});
