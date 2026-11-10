import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const spdxLicenses = require('spdx-license-list/full');
const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(mobileRoot, '../..');
const outputPath = path.join(mobileRoot, 'src/licenses/generated-license-data.json');
const checkOnly = process.argv.includes('--check');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const licenseFilePattern = /^(?:licen[cs]e|copying|notice)(?:\..+)?$/i;
const deprecatedSpdxIds = new Map([
  ['GPL-2.0', 'GPL-2.0-only'],
  ['GPL-3.0', 'GPL-3.0-only'],
  ['LGPL-2.1', 'LGPL-2.1-only'],
  ['LGPL-3.0', 'LGPL-3.0-only'],
  ['AGPL-3.0', 'AGPL-3.0-only'],
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

function stableId(value) {
  return `license_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function safeHomepage(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function licenseFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
  for (const subdirectory of ['licenses', 'LICENSES']) {
    const nested = path.join(directory, subdirectory);
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) continue;
    for (const entry of fs.readdirSync(nested, { withFileTypes: true })) {
      if (entry.isFile() && (licenseFilePattern.test(entry.name) || /\.txt$/i.test(entry.name))) {
        files.push(path.join(nested, entry.name));
      }
    }
  }
  return files.sort(compareText);
}

function textKind(file) {
  return path.basename(file).toLowerCase().startsWith('notice') ? 'notice' : 'license';
}

function spdxIdentifiers(expression) {
  const matches = expression.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [];
  return [...new Set(matches
    .filter((value) => !['AND', 'OR', 'WITH'].includes(value.toUpperCase()))
    .filter((value) => !value.startsWith('LicenseRef-'))
    .map((value) => deprecatedSpdxIds.get(value) ?? value))];
}

function main() {
  const inventoryJson = execFileSync(pnpm, ['--filter', '@task-handoff/mobile', 'licenses', 'list', '--json', '--prod'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const jsonStart = inventoryJson.indexOf('{');
  if (jsonStart < 0) throw new Error('pnpm licenses did not return a JSON inventory.');
  const inventory = JSON.parse(inventoryJson.slice(jsonStart));
  const packages = Object.entries(inventory).flatMap(([declaredLicense, entries]) => entries.flatMap((entry) => entry.versions.map((version, index) => ({
    name: entry.name,
    version,
    license: declaredLicense,
    author: typeof entry.author === 'string' ? entry.author : undefined,
    homepage: safeHomepage(entry.homepage),
    directory: entry.paths[index] ?? entry.paths[0],
  })))).sort((left, right) => compareText(left.name, right.name) || compareText(left.version, right.version));

  const texts = new Map();
  const spdxFallbackPackages = [];
  const usedIds = new Map();

  function addText(value, kind, source) {
    const normalized = normalizeText(value);
    if (!normalized) return undefined;
    const id = stableId(normalized);
    texts.set(id, normalized);
    return { id, kind, source };
  }

  function resolvePackageTexts(pkg) {
    const files = licenseFiles(pkg.directory);
    const references = files.map((file) => addText(fs.readFileSync(file, 'utf8'), textKind(file), 'package')).filter(Boolean);
    if (files.some((file) => textKind(file) === 'license')) return references;

    const fallback = spdxIdentifiers(pkg.license).map((identifier) => {
      const spdx = spdxLicenses[identifier];
      return spdx?.licenseText ? addText(spdx.licenseText, 'license', 'spdx') : undefined;
    }).filter(Boolean);
    if (!fallback.length) throw new Error(`No license text or SPDX fallback found for ${pkg.name}@${pkg.version} (${pkg.license}).`);
    spdxFallbackPackages.push(`${pkg.name}@${pkg.version}`);
    return [...fallback, ...references];
  }

  const rootLicense = addText(fs.readFileSync(path.join(repositoryRoot, 'LICENSE'), 'utf8'), 'license', 'package');
  const rootNoticePath = path.join(repositoryRoot, 'NOTICE');
  const rootNotice = fs.existsSync(rootNoticePath) ? addText(fs.readFileSync(rootNoticePath, 'utf8'), 'notice', 'package') : undefined;
  if (!rootLicense) throw new Error('The repository LICENSE file is empty.');

  const generatedPackages = packages.map((pkg) => {
    const id = stableId(`${pkg.name}@${pkg.version}`);
    const previous = usedIds.get(id);
    if (previous) throw new Error(`License entry ID collision between ${previous} and ${pkg.name}@${pkg.version}.`);
    usedIds.set(id, `${pkg.name}@${pkg.version}`);
    return {
      id,
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      ...(pkg.author ? { author: pkg.author } : {}),
      ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
      texts: resolvePackageTexts(pkg),
    };
  });

  const data = {
    schemaVersion: 1,
    packageCount: generatedPackages.length,
    project: {
      id: 'project',
      name: 'TaskHandoff',
      license: 'Apache-2.0',
      texts: [rootLicense, rootNotice].filter(Boolean),
    },
    packages: generatedPackages,
    texts: Object.fromEntries([...texts.entries()].sort(([left], [right]) => compareText(left, right))),
  };
  const serialized = `${JSON.stringify(data, undefined, 2)}\n`;

  if (checkOnly) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : undefined;
    if (existing !== serialized) {
      throw new Error('Generated license inventory is stale. Run `pnpm --filter @task-handoff/mobile licenses:generate`.');
    }
    console.log(`License inventory is current: ${data.packageCount} packages, ${Object.keys(data.texts).length} unique texts.`);
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized);
  console.log(`Wrote ${data.packageCount} packages and ${Object.keys(data.texts).length} unique license texts to ${path.relative(repositoryRoot, outputPath)}.`);
  if (spdxFallbackPackages.length) {
    console.log(`Used SPDX standard text for ${spdxFallbackPackages.length} packages without bundled license files.`);
  }
}

main();
