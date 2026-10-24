#!/bin/bash
# Samples amdgpu GTT+VRAM use every 0.2s; on SIGTERM writes peak delta (MiB) over the start value.
OUT=$1; D=/sys/class/drm/card0/device
cur() { echo $(( ($(cat ${D}/mem_info_gtt_used) + $(cat ${D}/mem_info_vram_used)) / 1048576 )); }
base=$(cur); peak=${base}
trap 'echo $((peak-base)) > "${OUT}"; exit 0' TERM INT
while true; do c=$(cur); [ ${c} -gt ${peak} ] && peak=${c}; sleep 0.2; done
