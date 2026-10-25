import { useNavigation } from 'expo-router';
import { useEffect, useRef } from 'react';

import { usePrimaryTabHeaderDefaults } from '../components/PrimaryTabStack';

/**
 * The master tab route owns the native header. Restore its list actions when a
 * wide detail pane unmounts so detail-specific options do not leak to the tab.
 */
export function PaneHeaderRestore({ pane }: { pane: boolean }) {
  return pane ? <PaneHeaderRestoreEffect /> : null;
}

function PaneHeaderRestoreEffect() {
  const navigation = useNavigation();
  const defaults = usePrimaryTabHeaderDefaults();
  const defaultsRef = useRef(defaults);

  useEffect(() => {
    defaultsRef.current = defaults;
  }, [defaults]);

  useEffect(() => {
    return () => {
      const fallback = defaultsRef.current;
      if (!fallback) return;
      navigation.setOptions({
        headerRight: fallback.headerRight,
        unstable_headerRightItems: fallback.headerRightItems,
      });
    };
  }, [navigation]);
  return null;
}
