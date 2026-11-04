#!/bin/sh
# Run the server unprivileged. The image starts as root only long enough to make
# the mounted /config volume writable by the runtime user, then drops privileges
# with gosu. PUID/PGID choose that user: default 1000 (the image's `node` user);
# on Unraid set them to the appdata share's owner (usually 99:100). Started with a
# compose `user:` instead (already unprivileged), it skips the chown.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# A GPU passed in (/dev/dri, for converting video: src/hardware.ts) belongs to the
# host's render or video group, whose number differs per host. The runtime user
# joins that group by number, so it can open the device whatever PUID it runs as.
gpu_groups() {
  for node in /dev/dri/renderD*; do
    [ -e "$node" ] || continue
    gid="$(stat -c %g "$node")"
    [ "$gid" = "0" ] && continue
    name="$(getent group "$gid" | cut -d: -f1)"
    if [ -z "$name" ]; then
      name="gpu$gid"
      groupadd -g "$gid" "$name" 2>/dev/null || true
    fi
    printf '%s\n' "$name"
  done
}

if [ "$(id -u)" = "0" ]; then
  mkdir -p /config /transcode
  chown "${PUID}:${PGID}" /transcode 2>/dev/null || true
  chown "${PUID}:${PGID}" /config 2>/dev/null || true
  mark="/config/.owner-uid"
  if [ "$(cat "$mark" 2>/dev/null)" != "${PUID}:${PGID}" ]; then
    chown -R "${PUID}:${PGID}" /config 2>/dev/null || true
    printf '%s:%s' "$PUID" "$PGID" > "$mark" 2>/dev/null || true
  fi
  extra="$(gpu_groups | sort -u)"
  if [ -n "$extra" ]; then
    # gosu takes supplementary groups from /etc/group, by user name: a user for
    # PUID, then membership of each GPU group.
    getent group "$PGID" > /dev/null || groupadd -g "$PGID" isputnik 2>/dev/null || true
    user="$(getent passwd "$PUID" | cut -d: -f1)"
    if [ -z "$user" ]; then
      user="isputnik"
      useradd -u "$PUID" -g "$PGID" -M -d /config -s /usr/sbin/nologin "$user" 2>/dev/null || true
    fi
    for group in $extra; do usermod -aG "$group" "$user" 2>/dev/null || true; done
    exec gosu "$user:${PGID}" "$@"
  fi
  exec gosu "${PUID}:${PGID}" "$@"
fi

exec "$@"
