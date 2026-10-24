// The SwiftUI menu host shrinks its trigger to the content's intrinsic width, which
// centers each Story row inside the remaining space. Use the native UIKit menu so
// the trigger participates in normal Yoga layout and stretches with the row.
export { MenuView } from '@react-native-menu/menu';
export type { MenuAction } from '@react-native-menu/menu';
