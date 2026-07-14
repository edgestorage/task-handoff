import path from "node:path";
import { pathToFileURL } from "node:url";

type ReceiverInkModule = {
  runReceiverInk: (options: unknown) => Promise<unknown>;
};

export async function runReceiver(options: unknown) {
  const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<ReceiverInkModule>;
  const { runReceiverInk } = await importModule(pathToFileURL(path.join(__dirname, "receiver-ink.mjs")).href);
  return runReceiverInk(options);
}
