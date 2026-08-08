import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useMobileTheme } from '../src/components/theme';
import { mobileProfileStore } from '../src/control-plane/runtime';
import { useI18n } from '../src/i18n';

export default function IndexRoute() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [destination, setDestination] = useState<'/(tabs)/(main)/inbox' | '/profiles'>();
  useEffect(() => {
    let live = true;
    void mobileProfileStore.active().then((profile) => {
      if (live) setDestination(profile ? '/(tabs)/(main)/inbox' : '/profiles');
    });
    return () => { live = false; };
  }, []);
  if (!destination) return <View style={{ alignItems: 'center', backgroundColor: colors.background, flex: 1, justifyContent: 'center' }}><ActivityIndicator accessibilityLabel={t('common.loading')} color={colors.primary} /></View>;
  return <Redirect href={destination} />;
}
