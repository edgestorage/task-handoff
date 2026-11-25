import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { SwipeActions } from './SwipeActions';

export function SwipeToClose({ children, containerStyle, disabled = false, label, onClose }: {
  children: ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  disabled?: boolean;
  label: string;
  onClose(): void;
}) {
  return <SwipeActions
    actions={[{ disabled, icon: 'close', label, onPress: onClose, tone: 'destructive' }]}
    containerStyle={containerStyle}
  >{children}</SwipeActions>;
}
