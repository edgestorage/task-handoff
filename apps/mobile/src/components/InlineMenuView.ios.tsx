// The SwiftUI menu host shrinks its trigger to the content's intrinsic width and
// breaks row layout. Use the native UIKit menu so the trigger participates in
// normal Yoga layout and stretches with its list row.
export { MenuView } from '@react-native-menu/menu';
export type { MenuAction } from '@react-native-menu/menu';
