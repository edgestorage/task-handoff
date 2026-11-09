#!/bin/sh
# Disposable local G1 acceptance only; no artifact publication/notarization.
set -eu
if [ "$#" -ne 3 ]; then
  echo 'usage: sign-macos-fixture.sh BIN_DIRECTORY NEW_OUTPUT_DIRECTORY SIGNING_IDENTITY' >&2
  exit 2
fi
source_directory=$1
output_directory=$2
signing_identity=$3
test ! -e "$output_directory"
mkdir -m 700 "$output_directory"
for binary in desktop-test-host task-handoff-desktop-streaming; do
  cp "$source_directory/$binary" "$output_directory/$binary"
  case "$binary" in
    desktop-test-host) identifier=com.taskhandoff.g1.desktop-host ;;
    task-handoff-desktop-streaming) identifier=com.taskhandoff.desktop-streaming ;;
  esac
  codesign --force --sign "$signing_identity" --timestamp=none --options runtime --identifier "$identifier" "$output_directory/$binary"
  codesign --verify --strict "$output_directory/$binary"
done
# No private material exported. This is the public designated requirement;
# unlike ad-hoc cdhash requirements it remains stable across code updates.
codesign -d -r- "$output_directory/task-handoff-desktop-streaming" 2> "$output_directory/designated-requirement.txt"
printf 'signed G1 fixture: %s\n' "$output_directory"
