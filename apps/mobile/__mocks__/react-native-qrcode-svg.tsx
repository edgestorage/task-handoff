import { View } from 'react-native';

export default function QRCode({ testID, value }: { testID?: string; value?: string }) {
  return <View accessibilityLabel={value} testID={testID}/>;
}
