import { runCli } from "./program.ts";

void runCli(process.argv).then((code) => {
  process.exitCode = code;
});
