import type { MobileControlPlaneProfile } from './profile';

export type NativeProfilesScreenProps = {
  activeId?: string;
  error?: string;
  profiles: MobileControlPlaneProfile[];
  profilesLoaded: boolean;
  testMode: boolean;
  onAdd(): void;
  onOpen(controlPlaneId: string): void;
};

export function NativeProfilesScreen(_props: NativeProfilesScreenProps) {
  return null;
}
