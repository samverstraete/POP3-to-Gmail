#!/bin/sh
set -e

# Ensure data and logs exist and are writable by node user. This runs as root
# when the container starts (ENTRYPOINT runs before USER is switched) so it
# fixes bind-mounted volume ownerships that are often owned by root on the host.

ensure_dir() {
  d="$1"
  if [ -d "$d" ]; then
    chown -R node:node "$d" || true
    chmod -R u+rwX,g+rX,o-rwx "$d" || true
  fi
}

ensure_dir /usr/src/app/data || true
ensure_dir /var/log/pop3_to_gmail || true

# Drop privileges and run the command as node user
exec su-exec node "$@"
