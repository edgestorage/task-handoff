import type { MobileControlPlaneProfile } from './profile';

export type NativeProfilesScreenProps = {
  activeProfile?: MobileControlPlaneProfile;
  error?: string;
  profiles: MobileControlPlaneProfile[];
  profilesLoaded: boolean;
  testMode: boolean;
  onAdd(): void;
  onOpen(profile: MobileControlPlaneProfile): void;
};

export function NativeProfilesScreen(_props: NativeProfilesScreenProps) {
  return null;
}
