const fs = require('node:fs');
const path = require('node:path');
const { IOSConfig, withXcodeProject } = require('expo/config-plugins');

const PACKAGES = [
  {
    name: 'BeautifulMermaidSwift',
    url: 'https://github.com/lukilabs/beautiful-mermaid-swift',
    version: '1.0.4',
    products: ['BeautifulMermaid'],
  },
  {
    name: 'HighlighterSwift',
    url: 'https://github.com/smittytone/HighlighterSwift',
    version: '3.1.0',
    products: ['Highlighter'],
  },
];

function appendReference(references, value, comment) {
  if (!references.some((reference) => reference.value === value)) references.push({ value, comment });
}

function unquote(value) {
  return typeof value === 'string' && value.startsWith('"') ? value.slice(1, -1) : value;
}

function addPackage(project, targetUuid, spec) {
  const objects = project.hash.project.objects;
  const packageReferences = objects.XCRemoteSwiftPackageReference ??= {};
  const productDependencies = objects.XCSwiftPackageProductDependency ??= {};
  const buildFiles = objects.PBXBuildFile ??= {};
  const target = objects.PBXNativeTarget[targetUuid];
  const frameworks = project.pbxFrameworksBuildPhaseObj(targetUuid);
  if (!target || !frameworks) throw new Error('Native Markdown app target has no Frameworks build phase.');

  let packageUuid = Object.keys(packageReferences).find((key) => !key.endsWith('_comment') && unquote(packageReferences[key]?.repositoryURL) === spec.url);
  const packageComment = `XCRemoteSwiftPackageReference "${spec.name}"`;
  if (!packageUuid) {
    packageUuid = project.generateUuid();
    packageReferences[packageUuid] = {
      isa: 'XCRemoteSwiftPackageReference',
      repositoryURL: JSON.stringify(spec.url),
      requirement: { kind: 'exactVersion', version: spec.version },
    };
    packageReferences[`${packageUuid}_comment`] = packageComment;
  }
  const pbxProject = project.getFirstProject().firstProject;
  pbxProject.packageReferences ??= [];
  appendReference(pbxProject.packageReferences, packageUuid, packageComment);
  target.packageProductDependencies ??= [];
  frameworks.files ??= [];

  for (const product of spec.products) {
    let dependencyUuid = target.packageProductDependencies
      .map((reference) => reference.value)
      .find((uuid) => productDependencies[uuid]?.productName === product);
    if (!dependencyUuid) {
      dependencyUuid = project.generateUuid();
      productDependencies[dependencyUuid] = {
        isa: 'XCSwiftPackageProductDependency',
        package: packageUuid,
        package_comment: packageComment,
        productName: product,
      };
      productDependencies[`${dependencyUuid}_comment`] = product;
      appendReference(target.packageProductDependencies, dependencyUuid, product);
    }
    let buildFileUuid = Object.keys(buildFiles).find((key) => !key.endsWith('_comment') && buildFiles[key]?.productRef === dependencyUuid);
    if (!buildFileUuid) {
      buildFileUuid = project.generateUuid();
      buildFiles[buildFileUuid] = { isa: 'PBXBuildFile', productRef: dependencyUuid, productRef_comment: product };
      buildFiles[`${buildFileUuid}_comment`] = `${product} in Frameworks`;
    }
    appendReference(frameworks.files, buildFileUuid, `${product} in Frameworks`);
  }
}

module.exports = function withTaskHandoffNativeMarkdown(config) {
  return withXcodeProject(config, (next) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(next.modRequest.projectRoot);
    const sourceName = 'TaskHandoffNativeMarkdownBlocks.swift';
    const relativePath = path.join(projectName, sourceName);
    fs.copyFileSync(path.join(__dirname, 'native-markdown', sourceName), path.join(next.modRequest.platformProjectRoot, relativePath));
    if (!next.modResults.hasFile(relativePath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath: relativePath, groupName: projectName, project: next.modResults });
    }
    const targetUuid = next.modResults.getFirstTarget().uuid;
    for (const spec of PACKAGES) addPackage(next.modResults, targetUuid, spec);
    return next;
  });
};

module.exports.PACKAGES = PACKAGES;
module.exports.addPackage = addPackage;
