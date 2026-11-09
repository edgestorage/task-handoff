import type { CloudAccountSecurityController } from './use-cloud-account-security';

export type NativeCloudAccountSecurityActionsScreenProps = {
  controller: CloudAccountSecurityController;
  onOpenDelete(): void;
  onOpenTwoStep(): void;
};

export function NativeCloudAccountSecurityActionsScreen(_props: NativeCloudAccountSecurityActionsScreenProps) {
  return null;
}
