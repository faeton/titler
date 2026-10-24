#!/bin/bash
# Start Titler v2 on n5 (TrueNAS POSTINIT script; also safe to run by hand as root).
# Server binds 127.0.0.1:8772; phone access via `tailscale serve --https=8772` (persisted by tailscaled).
set -uo pipefail
repo=/mnt/flash/home/faeton/work/titler
node=/mnt/flash/home/faeton/.nvm/versions/node/v24.18.0/bin/node
# VAAPI render/proxy needs the render node; the ACL doesn't survive reboot.
setfacl -m u:faeton:rw /dev/dri/renderD128 2>/dev/null || true
systemctl stop titler 2>/dev/null
systemctl reset-failed titler 2>/dev/null
systemd-run --unit=titler --uid=faeton --gid=faeton \
    --working-directory="$repo/apps/server" --property=Restart=on-failure --property=RestartSec=5 \
    --setenv=HOME=/mnt/flash/home/faeton --setenv=PATH="$(dirname "$node"):/usr/bin:/bin" \
    --setenv=NODE_ENV=production \
    "$node" "$repo/apps/server/node_modules/tsx/dist/cli.mjs" src/main.ts
