#!/bin/sh
# Run the server unprivileged. The image starts as root only long enough to make
# the mounted /config volume writable by the runtime user, then drops privileges
# with gosu. PUID/PGID choose that user: default 1000 (the image's `node` user);
# on Unraid set them to the appdata share's owner (usually 99:100). Started with a
# compose `user:` instead (already unprivileged), it skips the chown.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p /config
  chown "${PUID}:${PGID}" /config 2>/dev/null || true
  mark="/config/.owner-uid"
  if [ "$(cat "$mark" 2>/dev/null)" != "${PUID}:${PGID}" ]; then
    chown -R "${PUID}:${PGID}" /config 2>/dev/null || true
    printf '%s:%s' "$PUID" "$PGID" > "$mark" 2>/dev/null || true
  fi
  exec gosu "${PUID}:${PGID}" "$@"
fi

exec "$@"
