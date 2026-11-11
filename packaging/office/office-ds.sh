#!/usr/bin/env dash
# ONLYOFFICE Document Server (Community Edition, AGPL-3.0) for the agentrt Office app, in Docker.
#
#   office-ds.sh up            create the JWT secret if needed, start the container, wait until healthy
#   office-ds.sh down          stop and remove the container (volumes with the cache are kept)
#   office-ds.sh status        container state and /healthcheck
#   office-ds.sh logs          follow the container log
#   office-ds.sh save FILE [PLATFORM]  write the pinned image to FILE (.tar.gz) for an offline host;
#                              PLATFORM is the target's, e.g. linux/amd64 (default: this machine's)
#   office-ds.sh load FILE     load an image written by `save`
#
# Environment (defaults in brackets):
#   OFFICE_DS_IMAGE     image, pinned [onlyoffice/documentserver:9.4.0.1]
#   OFFICE_DS_NAME      container name [agentrt-office-ds]
#   OFFICE_DS_PORT      host port, bound to 127.0.0.1 only [8085]; agentrt reads AGENTRT_OFFICE_DS_URL
#   OFFICE_DS_MEMORY    memory limit [4g]
#   OFFICE_DS_CPUS      CPU limit [2]
#   AGENTRT_OFFICE_ENV_FILE  JWT secret file shared with agentrt [${XDG_CONFIG_HOME:-~/.config}/agentos/office/ds.env]
#   ACDE_RUNTIME_DIR   acde's runtime directory; the office bridge socket is in its office/ [${XDG_RUNTIME_DIR}/acde]
#
# The secret is generated locally (mode 0600) and never printed.
# Document Server calls the bridge back at http://127.0.0.1:7979 inside the container: the image's nginx forwards that
# to acde's unix socket (office.sock; only ACDE_RUNTIME_DIR/office is mounted); acde listens on no TCP port. A container made
# by an older version of this script keeps its old settings: `down` then `up` recreates it.
set -eu

IMAGE=${OFFICE_DS_IMAGE:-onlyoffice/documentserver:9.4.0.1}
NAME=${OFFICE_DS_NAME:-agentrt-office-ds}
PORT=${OFFICE_DS_PORT:-8085}
MEMORY=${OFFICE_DS_MEMORY:-4g}
CPUS=${OFFICE_DS_CPUS:-2}
BRIDGE_DIR=${ACDE_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/acde}/office
ENV_FILE=${AGENTRT_OFFICE_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/agentos/office/ds.env}
BRIDGE_CONF=$(dirname "$ENV_FILE")/acde-bridge.conf

die() { echo "office-ds: $*" >&2; exit 1; }

secret() {
  if [ -f "$ENV_FILE" ]; then
    grep -q '^JWT_SECRET=' "$ENV_FILE" || die "$ENV_FILE has no JWT_SECRET line"
    chmod 600 "$ENV_FILE"
    return
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  chmod 700 "$(dirname "$ENV_FILE")"
  (umask 077 && printf 'JWT_SECRET=%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" > "$ENV_FILE")
  echo "office-ds: created JWT secret in $ENV_FILE (mode 600)"
}

save_gz() {
  out=$1
  shift
  rc=$( { { docker save "$@"; echo $? >&3; } | gzip > "$out"; } 3>&1 )
  [ "$rc" = 0 ] || { rm -f -- "$out"; die "docker save $* failed"; }
}

health() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthcheck" 2>/dev/null; }

# the callback address inside the container -> acde's bridge socket. Only the bridge's own directory is mounted; it
# holds nothing but office.sock (0666). nginx's workers run as www-data, which is neither the directory's owner nor
# its group under Docker (host uid) or rootless podman (container root), so the directory is 0711: they may pass
# through it to the socket but not list it. The parent (acde/, inside the 0700 XDG_RUNTIME_DIR) stays 0700, so
# other host users still cannot reach it.
bridge() {
  mkdir -p "$(dirname "$BRIDGE_DIR")"
  chmod 700 "$(dirname "$BRIDGE_DIR")"
  mkdir -p "$BRIDGE_DIR"
  chmod 711 "$BRIDGE_DIR"
  mkdir -p "$(dirname "$BRIDGE_CONF")"
  cat > "$BRIDGE_CONF" <<'CONF'
server {
  listen 127.0.0.1:7979;
  location / {
    proxy_pass http://unix:/run/acde/office.sock;
    client_max_body_size 2m;
  }
}
CONF
}

up() {
  command -v docker >/dev/null || die "docker is not installed"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" || die "cannot pull $IMAGE; on an offline host use: $0 load FILE"
  secret
  bridge
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    mounted=$(docker container inspect -f '{{range .Mounts}}{{if eq .Destination "/run/acde"}}{{.Source}}{{end}}{{end}}' "$NAME")
    if [ "$mounted" != "$BRIDGE_DIR" ]; then
      echo "office-ds: $NAME mounts ${mounted:-nothing} at /run/acde, not $BRIDGE_DIR; recreating it (the data volumes stay)"
      docker rm -f "$NAME" >/dev/null
    fi
  fi
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    docker start "$NAME" >/dev/null
  else
    docker run -d --name "$NAME" --restart unless-stopped \
      -p "127.0.0.1:$PORT:80" \
      --memory "$MEMORY" --cpus "$CPUS" \
      --env-file "$ENV_FILE" \
      -v "$BRIDGE_DIR:/run/acde" \
      -v "$BRIDGE_CONF:/etc/nginx/conf.d/acde-bridge.conf:ro" \
      -e JWT_ENABLED=true -e JWT_HEADER=Authorization -e JWT_IN_BODY=false \
      -e ALLOW_PRIVATE_IP_ADDRESS=true \
      -v agentrt-office-data:/var/lib/onlyoffice \
      -v agentrt-office-db:/var/lib/postgresql \
      "$IMAGE" >/dev/null
  fi
  printf 'office-ds: waiting for Document Server on 127.0.0.1:%s ' "$PORT"
  tries=0
  while [ "$tries" -lt 120 ]; do
    tries=$((tries + 1))
    if [ "$(health)" = "true" ]; then
      echo "ready"
      return
    fi
    printf '.'
    sleep 2
  done
  echo
  die "not healthy after 4 minutes; see: $0 logs"
}

case "${1:-}" in
  up) up ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 && echo "office-ds: removed $NAME" || echo "office-ds: $NAME is not running" ;;
  status)
    docker container inspect -f '{{.Name}} {{.State.Status}} {{.Config.Image}}' "$NAME" 2>/dev/null || echo "office-ds: no container $NAME"
    echo "healthcheck: $(health || echo unreachable)"
    ;;
  logs) docker logs --tail 200 -f "$NAME" ;;
  save)
    [ -n "${2:-}" ] || die "usage: $0 save FILE.tar.gz [linux/amd64|linux/arm64]"
    if [ -n "${3:-}" ]; then
      docker pull --platform "$3" "$IMAGE"
      save_gz "$2" --platform "$3" "$IMAGE"
    else
      docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"
      save_gz "$2" "$IMAGE"
    fi
    echo "office-ds: wrote $IMAGE ${3:-} to $2 ($(du -h "$2" | cut -f1)); on the target: $0 load $(basename "$2")"
    ;;
  load)
    [ -f "${2:-}" ] || die "usage: $0 load FILE.tar.gz"
    docker load -i "$2"
    ;;
  *) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
