# Shared by backup and restore. One checkout, one Compose app, no external writers.
# An orphaned lock is never stolen. Inspect it manually after interrupted maintenance.
maintenance_lock=.cubby-system-maintenance.lock
maintenance_owned=false
maintenance_stopped=false
maintenance_was_running=false
work=""
partial=""
maintenance_cleanup() {
  result=$?
  trap - EXIT INT TERM
  [ -z "$work" ] || rm -rf -- "$work"
  [ -z "$partial" ] || rm -f -- "$partial"
  if [ "$maintenance_owned" = true ]; then
    rmdir "$maintenance_lock" || result=1
  fi
  if [ "$result" -ne 0 ] && [ "$maintenance_stopped" = true ]; then
    printf 'system_maintenance: app left stopped; inspect the failure before manually restarting
' >&2
  fi
  exit "$result"
}
maintenance_acquire() {
  mkdir "$maintenance_lock" 2>/dev/null || fail "backup/restore maintenance lock is held; do not remove it while another operator is working"
  maintenance_owned=true
  trap maintenance_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}
maintenance_stop() {
  services=$(docker compose ps --status running --services) || fail "app state could not be read"
  case "
$services
" in *'
app
'*) maintenance_was_running=true ;; esac
  # Stop even a starting/restarting instance. No app or scheduler runs in helper containers.
  docker compose stop app > /dev/null || fail "Cubby could not be stopped"
  maintenance_stopped=true
  services=$(docker compose ps --status running --services) || fail "stopped app state could not be verified"
  case "
$services
" in *'
app
'*) fail "Cubby is still running" ;; esac
}
maintenance_resume() {
  if [ "$maintenance_was_running" = true ]; then
    docker compose up -d --wait app > /dev/null || {
      docker compose stop app > /dev/null 2>&1 || :
      fail "Cubby did not resume; inspect it before manually restarting"
    }
  fi
  maintenance_stopped=false
}
