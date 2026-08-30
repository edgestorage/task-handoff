# Dependency patches

## `@react-native-menu/menu@2.0.0`

`@react-native-menu__menu@2.0.0.patch` preserves the declared `subtitle` on nested iOS `UIMenu` elements and extends the Fabric codegen boundary to carry one additional action level. The package already forwards subtitles to leaf `UIAction` elements but drops them when the same action has `subactions`, even though UIKit supports `UIMenuElement.subtitle` on iOS 15 and later. Its Fabric schema also truncates `section -> submenu -> action`, while the legacy dictionary path already handles that structure recursively.

Remove this patch after upgrading to an upstream release that assigns the subtitle for both leaf actions and nested menus and carries at least three action levels through Fabric, after verifying provider subtitles, section separators, nested model selection, and reasoning selection on iOS.

## `expo-paste-input@0.2.2`

`expo-paste-input@0.2.2.patch` adds opt-in, pre-insertion interception for large text pastes while retaining the package's existing image-first behavior. The public upstream contribution should expose `interceptTextPasteAbove` and the optional `intercepted` text-event flag with the same iOS and Android semantics.

Remove this patch only after upgrading to an upstream release that provides the equivalent API and after the native paste integration tests pass unchanged on both iOS and Android, including context-menu selection replacement, IME input, image priority, and single-event dispatch.
