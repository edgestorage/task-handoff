#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command } from "commander";
import { runtimePackages } from "../runtime-packages.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const program = new Command()
  .name("prepare-runtime-packages")
  .description("Assemble built TaskHandoff runtime npm package directories.")
  .addArgument(new Argument("[target]", "prepare one runtime package").choices(Object.keys(runtimePackages)))
  .parse(process.argv);
const [requestedTarget] = program.processedArgs;
const selected = requestedTarget
  ? Object.entries(runtimePackages).filter(([name]) => name === requestedTarget)
  : Object.entries(runtimePackages);

function exactDependencies(dependencies) {
  return Object.fromEntries(
    Object.keys(dependencies).map((name) => {
      const manifestPath = path.join(root, "node_modules", ...name.split("/"), "package.json");
      const installed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!installed.version) {
        throw new Error(`Installed runtime dependency has no version: ${name}`);
      }
      return [name, String(installed.version).replace(/^v(?=\d)/, "")];
    }),
  );
}

for (const [name, definition] of selected) {
  const packageDir = path.join(root, "release", "npm", name);
  fs.mkdirSync(packageDir, { recursive: true });
  if (definition.input) {
    const builtDist = path.join(root, "dist", "runtime-packages", name);
    fs.cpSync(builtDist, path.join(packageDir, "dist"), { recursive: true });
    const entryPath = path.join(packageDir, "dist", definition.entryFile);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Runtime entry was not built: ${path.relative(root, entryPath)}`);
    }
  }

  if (definition.uiDir) {
    const uiSource = path.join(root, definition.uiDir);
    if (!fs.existsSync(path.join(uiSource, "index.html"))) {
      throw new Error(`Runtime UI was not built: ${definition.uiDir}`);
    }
    fs.cpSync(uiSource, path.join(packageDir, "ui"), { recursive: true });
  }

  const binDir = path.join(packageDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = {};
  if (definition.aggregateDependencies) {
    const runtimeCliPath = path.join(binDir, definition.binName);
    fs.writeFileSync(runtimeCliPath, `#!/usr/bin/env node\nrequire("../dist/${definition.entryFile}");\n`, { mode: 0o755 });
    bin[definition.binName] = `bin/${definition.binName}`;
    const wrapperPath = path.join(binDir, "task-handoff-install-server");
    fs.copyFileSync(path.join(root, "scripts", "install-server-package.cjs"), wrapperPath);
    fs.chmodSync(wrapperPath, 0o755);
    const serviceInstallerPath = path.join(binDir, "task-handoff-install-server-services");
    fs.copyFileSync(path.join(root, "scripts", "install-server-services.sh"), serviceInstallerPath);
    fs.chmodSync(serviceInstallerPath, 0o755);
  } else {
    const wrapperPath = path.join(binDir, definition.binName);
    const bundledRuntimeBootstrap = name === "node-agent"
      ? 'process.env.TASK_HANDOFF_BUNDLED_RUNTIME_DIR ||= require("node:path").join(__dirname, "..", "runtime-artifacts");\n'
      : "";
    fs.writeFileSync(wrapperPath, `#!/usr/bin/env node\n${bundledRuntimeBootstrap}require("../dist/${definition.entryFile}");\n`, { mode: 0o755 });
    bin[definition.binName] = `bin/${definition.binName}`;
  }
  if (name === "node-agent") {
    const updateWorkerPath = path.join(binDir, "task-handoff-node-update-worker");
    fs.copyFileSync(path.join(root, "scripts", "node-update-worker.cjs"), updateWorkerPath);
    fs.chmodSync(updateWorkerPath, 0o755);
    const dockerAssetsDir = path.join(packageDir, "docker");
    fs.mkdirSync(dockerAssetsDir, { recursive: true });
    for (const asset of ["entrypoint.sh", "instance-launcher.sh", "runtime-installer.mjs"]) {
      fs.copyFileSync(path.join(root, "docker", asset), path.join(dockerAssetsDir, asset));
      fs.chmodSync(path.join(dockerAssetsDir, asset), 0o755);
    }
    const bundledRuntimeDir = path.join(packageDir, "runtime-artifacts");
    fs.rmSync(bundledRuntimeDir, { recursive: true, force: true });
    const runtimeArtifactSource = path.join(root, "release", "runtime-artifacts");
    const runtimeVersion = process.env.TASK_HANDOFF_VERSION || rootPackage.version;
    const runtimeStem = `controlled-instance-runtime-${runtimeVersion}-linux-universal`;
    const runtimeFiles = [`${runtimeStem}.tar.gz`, `${runtimeStem}.manifest.json`, `${runtimeStem}.tar.gz.sha256`];
    if (runtimeFiles.every((file) => fs.existsSync(path.join(runtimeArtifactSource, file)))) {
      fs.mkdirSync(bundledRuntimeDir, { recursive: true });
      for (const file of runtimeFiles) fs.copyFileSync(path.join(runtimeArtifactSource, file), path.join(bundledRuntimeDir, file));
    }
  }
  const manifest = {
    name: definition.packageName,
    version: process.env.TASK_HANDOFF_VERSION || rootPackage.version,
    description: definition.description,
    license: rootPackage.license,
    type: "commonjs",
    bin,
    files: [
      "bin",
      ...(definition.input ? ["dist"] : []),
      ...(definition.uiDir ? ["ui"] : []),
      ...(name === "node-agent" ? ["docker"] : []),
      ...(name === "node-agent" && fs.existsSync(path.join(packageDir, "runtime-artifacts")) ? ["runtime-artifacts"] : []),
      "README.md",
      "LICENSE",
      "NOTICE",
    ],
    engines: rootPackage.engines,
    dependencies: definition.aggregateDependencies
      ? Object.fromEntries(definition.aggregateDependencies.map((dependency) => [dependency, process.env.TASK_HANDOFF_VERSION || rootPackage.version]))
      : exactDependencies(definition.dependencies),
    publishConfig: { access: "public" },
  };
  fs.writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(packageDir, "README.md"),
    definition.aggregateDependencies
      ? `# ${definition.packageName}\n\nComplete TaskHandoff server package. Installing it installs the control plane, node agent, and controlled instance runtimes at the same version. Run \`task-handoff install\` as root to create and start the systemd services.\n`
      : `# ${definition.packageName}\n\nPrebuilt ${name} runtime for TaskHandoff. This package contains compiled JavaScript${definition.uiDir ? " and built Web UI assets" : ""}; it does not contain monorepo source code.\n`,
  );
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(packageDir, "LICENSE"));
  fs.copyFileSync(path.join(root, "NOTICE"), path.join(packageDir, "NOTICE"));
}
