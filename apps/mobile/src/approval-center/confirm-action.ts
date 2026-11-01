import { Alert } from 'react-native';

export function confirmDanger(label: string, cancelLabel: string, action: () => void) {
  Alert.alert(label, undefined, [
    { style: 'cancel', text: cancelLabel },
    { onPress: action, style: 'destructive', text: label },
  ]);
}
