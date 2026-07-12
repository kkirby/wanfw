#!/bin/sh
# Runs as root briefly to join the host's docker.sock group (its GID is not
# knowable at image-build time -- it varies per host/Docker install), then
# drops to the unprivileged `wanfw` user for the rest of the process
# lifetime via gosu (real setuid+setgid+exec, not just permission dropping
# in appearance). This is EXECUTE's (T3.8) only reason the container ever
# runs as root at all.
set -e

if [ -S /var/run/docker.sock ]; then
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
  if ! getent group "$DOCKER_GID" >/dev/null 2>&1; then
    groupadd -g "$DOCKER_GID" dockersock
  fi
  DOCKER_GROUP_NAME=$(getent group "$DOCKER_GID" | cut -d: -f1)
  usermod -aG "$DOCKER_GROUP_NAME" wanfw
fi

exec gosu wanfw "$@"
