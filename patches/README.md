# Dependency patches

## `@react-native-menu/menu@2.0.0`

`@react-native-menu__menu@2.0.0.patch` preserves the declared `subtitle` on nested iOS `UIMenu` elements and extends the Fabric codegen boundary to carry one additional action level. The package already forwards subtitles to leaf `UIAction` elements but drops them when the same action has `subactions`, even though UIKit supports `UIMenuElement.subtitle` on iOS 15 and later. Its Fabric schema also truncates `section -> submenu -> action`, while the legacy dictionary path already handles that structure recursively.

Remove this patch after upgrading to an upstream release that assigns the subtitle for both leaf actions and nested menus and carries at least three action levels through Fabric, after verifying provider subtitles, section separators, nested model selection, and reasoning selection on iOS.

## `expo-paste-input@0.2.2`

`expo-paste-input@0.2.2.patch` adds opt-in, pre-insertion interception for large text pastes while retaining the package's existing image-first behavior. The public upstream contribution should expose `interceptTextPasteAbove` and the optional `intercepted` text-event flag with the same iOS and Android semantics.

Remove this patch only after upgrading to an upstream release that provides the equivalent API and after the native paste integration tests pass unchanged on both iOS and Android, including context-menu selection replacement, IME input, image priority, and single-event dispatch.

## `react-native-screens@4.26.2`

`react-native-screens@4.26.2.patch` applies the native change from upstream pull request [#5014](https://github.com/software-mansion/react-native-screens/pull/5014). Reattaching a screen or `ScrollViewMarker` to its container resets an explicitly configured scroll-edge effect back to `automatic`; on iOS 27 that renders as a hard edge, so switching tabs or returning from a pushed screen can change the header treatment.

Remove this patch after upgrading to a release that reapplies non-automatic scroll-edge effects from both `RNSScreenView` and `ScrollViewMarker` in `didMoveToWindow`, and after verifying transparent-header soft edges across tab switches, push/pop, and list remounts on iOS 26 and iOS 27.
