import { Drawer } from 'expo-router/drawer';

import { InstanceDrawerContent } from '../../src/instance-scope/InstanceDrawerContent';

export default function PrimaryDrawerLayout() {
  return (
    <Drawer
      drawerContent={(props) => <InstanceDrawerContent {...props} />}
      screenOptions={{ drawerType: 'slide', headerShown: false, swipeEdgeWidth: 40 }}
    >
      <Drawer.Screen name="(main)" options={{ drawerLabel: 'Instances' }} />
    </Drawer>
  );
}
