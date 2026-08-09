import { Text, type TextProps } from 'react-native';

type UITextViewProps = TextProps & { uiTextView?: boolean };

export function UITextView(props: UITextViewProps) {
  return <Text {...props} />;
}
