import type { CloudAccountSecurityController } from './use-cloud-account-security';

export type NativeCloudAccountSecurityScreenProps = {
  controller: CloudAccountSecurityController;
  onOpenControlPlanes(): void;
};

export function NativeCloudAccountSecurityScreen(_props: NativeCloudAccountSecurityScreenProps) {
  return null;
}
