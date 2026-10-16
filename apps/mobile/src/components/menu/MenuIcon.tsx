import { Icon, type IconName } from '../Icon';

/** Icon used inside the Android floating menus. */
export function MenuIcon({ color, name, size = 20 }: { color: string; name: IconName; size?: number }) {
  return <Icon color={color} name={name} size={size} />;
}
