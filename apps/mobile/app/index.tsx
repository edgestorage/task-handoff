import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useMobileTheme } from '../src/components/theme';
import { mobileProfileStore } from '../src/control-plane/runtime';

export default function IndexRoute() {
  const { colors } = useMobileTheme();
  const [destination, setDestination] = useState<'/(tabs)/inbox' | '/profiles'>();
  useEffect(() => {
    let live = true;
    void mobileProfileStore.active().then((profile) => {
      if (live) setDestination(profile ? '/(tabs)/inbox' : '/profiles');
    });
    return () => { live = false; };
  }, []);
  if (!destination) return <View style={{ alignItems: 'center', backgroundColor: colors.background, flex: 1, justifyContent: 'center' }}><ActivityIndicator accessibilityLabel="Loading profile" color={colors.primary} /></View>;
  return <Redirect href={destination} />;
}
