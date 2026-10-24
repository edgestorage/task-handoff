import type { MobileControlPlaneProfile } from './profile';
import type { CloudAccountState } from './use-cloud-account-state';

export type NativeProfilesScreenProps = {
  activeProfile?: MobileControlPlaneProfile;
  cloudAccount?: CloudAccountState;
  error?: string;
  profiles: MobileControlPlaneProfile[];
  profilesLoaded: boolean;
  testMode: boolean;
  onAdd(): void;
  onOpenCloudAccount(): void;
  onOpen(profile: MobileControlPlaneProfile): void;
};

export function NativeProfilesScreen(_props: NativeProfilesScreenProps) {
  return null;
}
