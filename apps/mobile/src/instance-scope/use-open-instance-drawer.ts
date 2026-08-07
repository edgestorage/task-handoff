import { useNavigation } from 'expo-router';

export function useOpenInstanceDrawer() {
  const navigation = useNavigation();
  return () => {
    let current: any = navigation;
    while (current) {
      if (typeof current.openDrawer === 'function') {
        current.openDrawer();
        return;
      }
      current = current.getParent?.();
    }
    navigation.dispatch({ type: 'OPEN_DRAWER' });
  };
}
