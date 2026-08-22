# Dependency patches

## `expo-paste-input@0.2.2`

`expo-paste-input@0.2.2.patch` adds opt-in, pre-insertion interception for large text pastes while retaining the package's existing image-first behavior. The public upstream contribution should expose `interceptTextPasteAbove` and the optional `intercepted` text-event flag with the same iOS and Android semantics.

Remove this patch only after upgrading to an upstream release that provides the equivalent API and after the native paste integration tests pass unchanged on both iOS and Android, including context-menu selection replacement, IME input, image priority, and single-event dispatch.
