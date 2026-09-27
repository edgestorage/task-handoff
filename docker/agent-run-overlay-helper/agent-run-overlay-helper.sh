#!/bin/sh
set -eu

overlay_root=/run/task-handoff/agent-runs/overlay
workspace_root=/run/task-handoff/agent-runs/workspaces
shared_root=/run/task-handoff/agent-runs/shared

fail() {
  printf '%s\n' "agent-run-overlay-helper: $*" >&2
  exit 1
}

require_absolute() {
  case "$2" in
    /*) ;;
    *) fail "$1 must be an absolute runtime path" ;;
  esac
  sanitized=$(printf '%s' "$2" | tr '\r\n' '__')
  [ "$sanitized" = "$2" ] || fail "$1 contains an invalid line break"
}

require_below() {
  require_absolute "$1" "$2"
  case "$2" in
    "$3"/*) ;;
    *) fail "$1 is outside $3" ;;
  esac
}

target_sh() {
  script=$1
  shift
  nsenter --target 1 --mount --root=/proc/1/root --wd=/ \
    /bin/sh -eu -c "$script" task-handoff-agent-run-overlay-helper "$@"
}

# Docker entrypoints may keep PID 1 as a root sudo wrapper while the
# controlled-instance server runs as an unprivileged user. Resolve ownership
# from that server process so an injected workspace is usable by the provider.
runtime_owner() {
  for status in /proc/[0-9]*/status; do
    pid=${status%/status}
    cmd=$(tr '\0' ' ' < "$pid/cmdline" 2>/dev/null || true)
    case "$cmd" in
      *"/opt/task-handoff/instance-runtime/current"*)
        uid=$(awk '/^Uid:/{print $2; exit}' "$status" 2>/dev/null || true)
        gid=$(awk '/^Gid:/{print $2; exit}' "$status" 2>/dev/null || true)
        case "$uid:$gid" in
          *[!0-9:]*|:) continue ;;
          *) printf '%s:%s' "$uid" "$gid"; return 0 ;;
        esac
        ;;
    esac
  done
  stat -c "%u:%g" /proc/1
}

take_option() {
  [ "$#" -ge 2 ] || fail "missing value for $1"
}

operation=${1:-}
[ -n "$operation" ] || fail "an operation is required"
shift

lower= upper= work= merged= shared= other_shared= marker= generation= path=
while [ "$#" -gt 0 ]; do
  take_option "$@"
  case "$1" in
    --lower) lower=$2 ;;
    --upper) upper=$2 ;;
    --work) work=$2 ;;
    --merged) merged=$2 ;;
    --shared) shared=$2 ;;
    --other-shared) other_shared=$2 ;;
    --marker) marker=$2 ;;
    --generation) generation=$2 ;;
    --path) path=$2 ;;
    *) fail "unknown option $1" ;;
  esac
  shift 2
done

case "$operation" in
  inject)
    [ -n "$lower" ] && [ -n "$upper" ] && [ -n "$work" ] && [ -n "$merged" ] \
      && [ -n "$shared" ] && [ -n "$marker" ] || fail "inject options are incomplete"
    require_absolute lower "$lower"
    require_below upper "$upper" "$overlay_root"
    require_below work "$work" "$overlay_root"
    require_below merged "$merged" "$workspace_root"
    require_below shared "$shared" "$shared_root"
    target_sh '
      lower=$1; upper=$2; work=$3; merged=$4; shared=$5; marker=$6
      marker_path=${merged%/merged}/.task-handoff-agent-run.json
      if findmnt --noheadings --mountpoint "$merged" >/dev/null 2>&1; then
        [ -f "$marker_path" ] && [ "$(cat "$marker_path")" = "$marker" ] \
          || { echo "mounted workspace has a foreign marker" >&2; exit 1; }
        exit 0
      fi
      [ -d "$lower" ] || { echo "lower workspace does not exist" >&2; exit 1; }
      [ -d "$shared" ] || { echo "run shared directory does not exist" >&2; exit 1; }
      mkdir -p "$upper" "$work" "$merged"
      printf "%s" "$marker" > "$marker_path"
      runtime_owner() {
        for status in /proc/[0-9]*/status; do
          pid=${status%/status}
          cmd=$(tr "\\0" " " < "$pid/cmdline" 2>/dev/null || true)
          case "$cmd" in
            *"/opt/task-handoff/instance-runtime/current"*)
              uid=$(grep "^Uid:" "$status" 2>/dev/null | cut -f2)
              gid=$(grep "^Gid:" "$status" 2>/dev/null | cut -f2)
              case "$uid:$gid" in
                *[!0-9:]*|:) continue ;;
                *) printf '%s:%s' "$uid" "$gid"; return 0 ;;
              esac
              ;;
          esac
        done
        stat -c "%u:%g" /proc/1
      }
      owner=$(runtime_owner)
      chown "$owner" "$upper" "$merged"
      escape_overlay_path() { printf "%s" "$1" | sed "s/\\\\/\\\\\\\\/g; s/:/\\\\:/g; s/,/\\\\,/g"; }
      lower_option=$(escape_overlay_path "$lower")
      upper_option=$(escape_overlay_path "$upper")
      work_option=$(escape_overlay_path "$work")
      if ! mount -t overlay overlay -o "lowerdir=$lower_option" -o "upperdir=$upper_option" -o "workdir=$work_option" "$merged"; then
        rm -f "$marker_path"
        exit 1
      fi
      chown "$owner" "$upper" "$merged"
    ' "$lower" "$upper" "$work" "$merged" "$shared" "$marker"
    ;;
  inspect)
    [ -n "$merged" ] || fail "inspect requires --merged"
    require_below merged "$merged" "$workspace_root"
    target_sh '
      merged=$1; marker_path=${merged%/merged}/.task-handoff-agent-run.json
      if findmnt --noheadings --mountpoint "$merged" >/dev/null 2>&1; then
        [ -f "$marker_path" ] || { printf "{\"mounted\":true}\n"; exit 0; }
        printf "{\"mounted\":true,\"marker\":"; cat "$marker_path"; printf "}\n"
      else
        printf "{\"mounted\":false}\n"
      fi
    ' "$merged"
    ;;
  dispose|rollback)
    [ -n "$upper" ] && [ -n "$work" ] && [ -n "$merged" ] || fail "$operation options are incomplete"
    require_below upper "$upper" "$overlay_root"
    require_below work "$work" "$overlay_root"
    require_below merged "$merged" "$workspace_root"
    target_sh '
      upper=$1; work=$2; merged=$3
      member_root=${merged%/merged}
      if findmnt --noheadings --mountpoint "$merged" >/dev/null 2>&1; then umount "$merged"; fi
      rm -rf -- "$upper" "$work" "$merged"
      rm -f -- "$member_root/.task-handoff-agent-run.json"
      rmdir -- "$member_root" 2>/dev/null || true
      rmdir -- "${upper%/upper}" 2>/dev/null || true
    ' "$upper" "$work" "$merged"
    ;;
  shared-ensure)
    [ -n "$path" ] && [ -n "$generation" ] || fail "shared-ensure options are incomplete"
    require_below path "$path" "$shared_root"
    target_sh '
      path=$1; generation=$2
      mkdir -p "$path"
      marker_path="${path}.task-handoff-agent-run-shared"
      if [ -f "$marker_path" ] && [ "$(cat "$marker_path")" != "$generation" ]; then
        echo "shared directory has a foreign generation" >&2
        exit 1
      fi
      printf "%s" "$generation" > "$marker_path"
      runtime_owner() {
        for status in /proc/[0-9]*/status; do
          pid=${status%/status}
          cmd=$(tr "\\0" " " < "$pid/cmdline" 2>/dev/null || true)
          case "$cmd" in
            *"/opt/task-handoff/instance-runtime/current"*)
              uid=$(grep "^Uid:" "$status" 2>/dev/null | cut -f2)
              gid=$(grep "^Gid:" "$status" 2>/dev/null | cut -f2)
              case "$uid:$gid" in
                *[!0-9:]*|:) continue ;;
                *) printf '%s:%s' "$uid" "$gid"; return 0 ;;
              esac
              ;;
          esac
        done
        stat -c "%u:%g" /proc/1
      }
      chown "$(runtime_owner)" "$path" "$marker_path"
    ' "$path" "$generation"
    ;;
  shared-expire)
    [ -n "$path" ] && [ -n "$generation" ] || fail "shared-expire options are incomplete"
    require_below path "$path" "$shared_root"
    target_sh '
      path=$1; generation=$2
      marker_path="${path}.task-handoff-agent-run-shared"
      [ -f "$marker_path" ] || { echo "shared directory marker is missing" >&2; exit 1; }
      [ "$(cat "$marker_path")" = "$generation" ] || { echo "shared directory has a foreign generation" >&2; exit 1; }
      rm -rf -- "$path" "$marker_path"
    ' "$path" "$generation"
    ;;
  shared-inspect)
    [ -n "$path" ] && [ -n "$generation" ] || fail "shared-inspect options are incomplete"
    require_below path "$path" "$shared_root"
    target_sh '
      path=$1; generation=$2
      marker_path="${path}.task-handoff-agent-run-shared"
      [ -f "$marker_path" ] || { echo "shared directory marker is missing" >&2; exit 1; }
      [ "$(cat "$marker_path")" = "$generation" ] || { echo "shared directory has a foreign generation" >&2; exit 1; }
      [ ! -e "$path/work" ] || { echo "shared directory contains an overlay work directory" >&2; exit 1; }
      if find "$path" -name ".wh.*" -print -quit | grep -q .; then
        echo "shared directory contains an overlay whiteout" >&2
        exit 1
      fi
      if getfattr --absolute-names -R -d -m "^trusted\\.overlay\\." "$path" 2>/dev/null | grep -q "trusted.overlay."; then
        echo "shared directory contains overlay xattrs" >&2
        exit 1
      fi
      usage=$(du -sb -- "$path" | cut -f1)
      case "$usage" in *[!0-9]*|"") echo "invalid shared directory usage" >&2; exit 1 ;; esac
      printf "{\"usageBytes\":%s}\n" "$usage"
    ' "$path" "$generation"
    ;;
  probe-verify)
    [ -n "$lower" ] && [ -n "$merged" ] && [ -n "$shared" ] \
      && [ -n "$other_shared" ] && [ -n "$generation" ] || fail "probe-verify options are incomplete"
    require_absolute lower "$lower"
    require_below merged "$merged" "$workspace_root"
    require_below shared "$shared" "$shared_root"
    require_below other-shared "$other_shared" "$shared_root"
    case "$generation" in *[!a-zA-Z0-9_.:-]*|"") fail "generation is not a safe path segment" ;; esac
    target_sh '
      lower=$1; merged=$2; shared=$3; other_shared=$4; generation=$5
      marker=".task-handoff-agent-run-probe-$generation"
      workspace_file="$merged/$marker"
      shared_file="$shared/$marker"
      source_file="$lower/$marker"
      other_file="$other_shared/$marker"
      workspace_ok=false; shared_ok=false; source_blocked=false; other_blocked=false
      [ -f "$workspace_file" ] && [ "$(cat "$workspace_file")" = workspace-ok ] && workspace_ok=true
      [ -f "$shared_file" ] && [ "$(cat "$shared_file")" = shared-ok ] && shared_ok=true
      [ ! -e "$source_file" ] && source_blocked=true
      [ ! -e "$other_file" ] && other_blocked=true
      rm -f -- "$workspace_file" "$shared_file" "$source_file" "$other_file"
      printf "{\"workspaceWritable\":%s,\"sharedWritable\":%s,\"sourceWriteRejected\":%s,\"otherRunWriteRejected\":%s}\n" \
        "$workspace_ok" "$shared_ok" "$source_blocked" "$other_blocked"
      [ "$workspace_ok" = true ] && [ "$shared_ok" = true ] \
        && [ "$source_blocked" = true ] && [ "$other_blocked" = true ]
    ' "$lower" "$merged" "$shared" "$other_shared" "$generation"
    ;;
  *) fail "unsupported operation $operation" ;;
esac
