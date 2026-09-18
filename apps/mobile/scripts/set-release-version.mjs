import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version || '')) {
  throw new Error(`Expected a semantic release version, got: ${version || '<empty>'}`);
}

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJsonPath = process.env.TASK_HANDOFF_MOBILE_APP_JSON || path.join(mobileRoot, 'app.json');
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
if (!appJson.expo || typeof appJson.expo !== 'object') {
  throw new Error('apps/mobile/app.json has no Expo configuration.');
}
appJson.expo.version = version;
fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, undefined, 2)}\n`);
console.log(`Configured mobile release version ${version}.`);
