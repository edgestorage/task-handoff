import { licenseSubject, mobileLicenseData } from '../src/licenses/model';

describe('bundled mobile license inventory', () => {
  test('contains one resolvable entry for every production package version', () => {
    expect(mobileLicenseData.packageCount).toBe(mobileLicenseData.packages.length);
    expect(new Set(mobileLicenseData.packages.map((item) => item.id)).size).toBe(mobileLicenseData.packageCount);
    for (const item of mobileLicenseData.packages) {
      expect(item.texts.length).toBeGreaterThan(0);
      expect(item.texts.every((reference) => Boolean(mobileLicenseData.texts[reference.id]))).toBe(true);
    }
  });

  test('includes the application license, notices, and SPDX fallbacks', () => {
    expect(licenseSubject('project')).toMatchObject({ id: 'project', name: 'TaskHandoff', license: 'Apache-2.0' });
    expect(mobileLicenseData.project.texts.some((reference) => reference.kind === 'notice')).toBe(true);
    expect(mobileLicenseData.packages.some((item) => item.texts.some((reference) => reference.source === 'spdx'))).toBe(true);
    expect(mobileLicenseData.packages.some((item) => item.name === 'react-native')).toBe(true);
  });
});
