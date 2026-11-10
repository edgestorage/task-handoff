import generatedLicenseData from './generated-license-data.json';

export type LicenseTextKind = 'license' | 'notice';
export type LicenseTextSource = 'package' | 'spdx';

export type LicenseTextReference = {
  id: string;
  kind: LicenseTextKind;
  source: LicenseTextSource;
};

export type LicensePackage = {
  id: string;
  name: string;
  version: string;
  license: string;
  author?: string;
  homepage?: string;
  texts: LicenseTextReference[];
};

export type LicenseProject = {
  id: 'project';
  name: string;
  license: string;
  texts: LicenseTextReference[];
};

export type MobileLicenseData = {
  schemaVersion: 1;
  packageCount: number;
  project: LicenseProject;
  packages: LicensePackage[];
  texts: Record<string, string>;
};

export const mobileLicenseData = generatedLicenseData as MobileLicenseData;

export function licenseSubject(id: string, data: MobileLicenseData = mobileLicenseData) {
  return id === data.project.id ? data.project : data.packages.find((item) => item.id === id);
}
