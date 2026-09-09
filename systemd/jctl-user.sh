# Reference copy only -- the live version lives in ~/.bashrc (systemd
# doesn't source shell functions from repo paths, same reasoning as the
# .service files in this directory being reference copies).
#
# `journalctl --user` finds zero journal files on this machine (confirmed
# 2026-09-09 via SYSTEMD_LOG_LEVEL=debug: it opens the right directories but
# its file-glob never matches the real system@*.journal files that plain
# `journalctl` reads fine from the same directories -- a systemd 252.39
# quirk on this Armbian/ramlog setup, not a permissions issue). This gets
# the same result by filtering the regular journal by UID instead; `-u`/
# `--unit` is translated to `_SYSTEMD_USER_UNIT=` (not `_SYSTEMD_UNIT=`,
# which only matches *system* units and would silently find nothing for a
# --user service).
#
# Usage:
#   jctl-user -u wsjtz-backend -n 20
#   jctl-user -u wsjtz-frontend -f
#   jctl-user                       # everything logged under your user
jctl-user() {
  local args=() unit=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -u|--unit)
        unit="$2"; shift 2 ;;
      --unit=*)
        unit="${1#--unit=}"; shift ;;
      *)
        args+=("$1"); shift ;;
    esac
  done
  if [ -n "$unit" ]; then
    case "$unit" in *.*) ;; *) unit="$unit.service" ;; esac
    journalctl "_SYSTEMD_USER_UNIT=$unit" "_UID=$(id -u)" "${args[@]}"
  else
    journalctl "_UID=$(id -u)" "${args[@]}"
  fi
}
