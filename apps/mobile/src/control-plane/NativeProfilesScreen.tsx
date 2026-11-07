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
  onOpenMarkdownDemo(): void;
  onOpen(profile: MobileControlPlaneProfile): void;
  showMarkdownDemo: boolean;
};

export function NativeProfilesScreen(_props: NativeProfilesScreenProps) {
  return null;
}
