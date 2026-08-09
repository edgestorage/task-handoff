import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
const ascAppId = process.argv[3];
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version || '')) {
  throw new Error(`Expected a semantic release version, got: ${version || '<empty>'}`);
}
if (ascAppId !== undefined && !/^[1-9]\d*$/.test(ascAppId)) {
  throw new Error(`Expected a numeric App Store Connect app id, got: ${ascAppId || '<empty>'}`);
}

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJsonPath = process.env.TASK_HANDOFF_MOBILE_APP_JSON || path.join(mobileRoot, 'app.json');
const easJsonPath = process.env.TASK_HANDOFF_MOBILE_EAS_JSON || path.join(mobileRoot, 'eas.json');
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
if (!appJson.expo || typeof appJson.expo !== 'object') {
  throw new Error('apps/mobile/app.json has no Expo configuration.');
}
const easJson = ascAppId === undefined ? undefined : JSON.parse(fs.readFileSync(easJsonPath, 'utf8'));
if (easJson && (!easJson.submit?.production?.ios || typeof easJson.submit.production.ios !== 'object')) {
  throw new Error('apps/mobile/eas.json has no production iOS submit profile.');
}
appJson.expo.version = version;
fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, undefined, 2)}\n`);
if (easJson) {
  easJson.submit.production.ios.ascAppId = ascAppId;
  fs.writeFileSync(easJsonPath, `${JSON.stringify(easJson, undefined, 2)}\n`);
}
console.log(`Configured mobile release version ${version}.`);
