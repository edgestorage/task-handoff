import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const expoConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const failures = [];

const forbiddenDependencies = [
  /^@task-handoff\/(?!protocol$|control-plane-client$)/,
  /^@auth0\//,
  /^@clerk\//,
  /^@supabase\//,
  /^firebase(?:\/|$)/,
];
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
  if (forbiddenDependencies.some((pattern) => pattern.test(name))) {
    failures.push(`forbidden dependency: ${name}`);
  }
}

const imagePickerPlugin = expoConfig.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker');
if (!imagePickerPlugin || imagePickerPlugin[1]?.cameraPermission !== false || imagePickerPlugin[1]?.microphonePermission !== false) {
  failures.push('expo-image-picker must remove unused camera and microphone permissions');
}

const productionFiles = sourceFiles(path.join(root, 'app')).concat(sourceFiles(path.join(root, 'src')));
const networkOwners = new Set([
  path.join(root, 'src', 'control-plane', 'direct-enrollment.ts'),
  path.join(root, 'src', 'control-plane', 'direct-transport.ts'),
]);
const forbiddenSourcePatterns = [
  [/\bNodeAgentTransport\b/, 'NodeAgentTransport'],
  [/\bnodeCredential\b/, 'Node credential'],
  [/\brelayEndpoint\b/, 'relay endpoint'],
  [/\baccessTicket\b/, 'access ticket'],
  [/from\s+['"][^'"]*(?:node-agent|relay|official-account)[^'"]*['"]/, 'forbidden transport import'],
];
for (const file of productionFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [pattern, label] of forbiddenSourcePatterns) {
    if (pattern.test(source)) failures.push(`${relative(file)} contains ${label}`);
  }
  if (!networkOwners.has(file) && /\bfetch\s*\(|\bnew\s+WebSocket\s*\(/.test(source)) {
    failures.push(`${relative(file)} creates a network connection outside the Direct transport boundary`);
  }
  const apiRoutes = source.match(/["'`]\/api\/[^"'`\s]*/g) ?? [];
  const allowedPlatformRoutes = file === path.join(root, 'src', 'control-plane', 'direct-transport.ts')
    ? new Set(["'/api/events", '"/api/events', '`/api/events'])
    : new Set();
  for (const route of apiRoutes) {
    if (!allowedPlatformRoutes.has(route)) {
      failures.push(`${relative(file)} owns Control Plane user API route ${route}; move it to @task-handoff/control-plane-client`);
    }
  }
}

const bundleIndex = process.argv.indexOf('--bundle-dir');
if (bundleIndex >= 0) {
  const bundleDir = path.resolve(process.cwd(), process.argv[bundleIndex + 1] || '');
  if (!fs.existsSync(bundleDir)) failures.push(`bundle directory does not exist: ${bundleDir}`);
  else {
    const forbiddenBundleTokens = [
      'NodeAgentTransport', 'nodeCredential', 'relayEndpoint', 'accessTicket',
      '/api/controlled-instances/:id/start', '/api/controlled-instances/:id/stop',
      '/api/controlled-instances/:id/restart', '/api/nodes/:id/pairing',
      '/api/nodes/:id/updates/apply', '/api/triggers', '/api/models',
    ];
    for (const file of sourceFiles(bundleDir, new Set(['.js', '.json', '.map', '.hbc']))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const token of forbiddenBundleTokens) {
        if (source.includes(token)) failures.push(`${relative(file)} contains forbidden bundle token ${token}`);
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Mobile dependency, network, and bundle boundaries are valid.');
}

function sourceFiles(directory, extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target, extensions);
    return extensions.has(path.extname(entry.name)) ? [target] : [];
  });
}

function relative(file) {
  return path.relative(root, file);
}
