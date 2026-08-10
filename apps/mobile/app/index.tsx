import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';

import { mobileProfileStore } from '../src/control-plane/runtime';

export default function IndexRoute() {
  const [destination, setDestination] = useState<'/(tabs)/(main)/inbox' | '/profiles'>();
  useEffect(() => {
    let live = true;
    void mobileProfileStore.active().then((profile) => {
      if (live) setDestination(profile ? '/(tabs)/(main)/inbox' : '/profiles');
    }).catch(() => {
      if (live) setDestination('/profiles');
    });
    return () => { live = false; };
  }, []);

  if (!destination) return null;
  return <Redirect href={destination} />;
}
