const test = require("node:test");
const {
  assertBackpressure,
  fixture,
  observeNodeEventSocketBackpressure,
} = require("./fixtures/event-socket-backpressure-parity.js");

test("U02.2 real socket backpressure matches the shared close contract", async () => {
  const scenario = fixture().scenario;
  const result = await observeNodeEventSocketBackpressure();
  assertBackpressure(result, scenario);
});
