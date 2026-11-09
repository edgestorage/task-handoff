import type { CloudAccountSecurityController } from './use-cloud-account-security';

export type NativeCloudAccountSecuritySection = 'two-step' | 'delete';

export type NativeCloudAccountSecuritySectionScreenProps = {
  controller: CloudAccountSecurityController;
  onDeleted?(): void;
  section: NativeCloudAccountSecuritySection;
};

export function NativeCloudAccountSecuritySectionScreen(_props: NativeCloudAccountSecuritySectionScreenProps) {
  return null;
}
