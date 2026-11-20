const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { fileTriggerMatcher } = require("../../packages/controlled-instance/src/triggers/manager.ts");
const fixturePath = path.resolve(
  __dirname,
  "../../controlled-instance-rs/crates/instance/tests/fixtures/trigger-matcher-parity.json",
);

function observe(testCase) {
  const matches = fileTriggerMatcher(testCase.globs, testCase.ignored);
  return Object.fromEntries(Object.keys(testCase.paths).map((relative) => [relative, matches(relative)]));
}

module.exports = { fixturePath, observe };

if (require.main === module) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  for (const testCase of fixture.cases) testCase.expected = observe(testCase);
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
}
