#!/bin/bash
# Render-path encode benchmark: HEVC 1376x1840 .mov -> crop 9:16, scale 1080x1920,
# burn ASS subtitles (CPU libass), encode. Compares libx264 vs VAAPI on the 890M.
# Usage: bench_encode.sh <input.mov> <outdir>
set -u
IN=${1:?input}; OUT=${2:?outdir}; mkdir -p "${OUT}"
HERE=$(cd "$(dirname "$0")" && pwd)
FF=$HOME/.local/bin/ffmpeg-hw
ASS="${HERE}/test.ass"
DEV=/dev/dri/renderD128
VF="crop=1035:1840,scale=1080:1920:flags=bicubic,ass=${ASS}"
THREADS=${THREADS:-8}   # match the contended CPU agents' cap
CSV="${OUT}/encode.csv"
[ -f "${CSV}" ] || echo "variant,wall_s,user_s,sys_s,maxrss_kb,size_bytes,fps" > "${CSV}"

run() {  # name, args...
  local name=$1; shift
  local o="${OUT}/${name}.mp4"
  local t="${OUT}/${name}.time"
  "${HERE}/../timeit.py" "${t}" "${FF}" -hide_banner -y -nostats -loglevel error "$@" -an "${o}"
  local rc=$?
  read -r wall user sys rss < "${t}"
  local size; size=$(stat -c %s "${o}" 2>/dev/null || echo 0)
  local frames; frames=$(~/.local/bin/ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 "${o}" 2>/dev/null)
  local fps; fps=$(awk -v f="${frames:-0}" -v w="${wall}" 'BEGIN{printf "%.1f", f/w}')
  echo "${name},${wall},${user},${sys},${rss},${size},${fps}" | tee -a "${CSV}"
  [ ${rc} -eq 0 ] || echo "  !! ${name} exited ${rc}"
}

# 1) current Titler: CPU decode, libx264 medium crf18
[ -n "${SKIP_X264:-}" ] || run x264_medium_crf18 -threads ${THREADS} -i "${IN}" -vf "${VF}" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p
# 2) libx264 veryfast crf18
[ -n "${SKIP_X264:-}" ] || run x264_veryfast_crf18 -threads ${THREADS} -i "${IN}" -vf "${VF}" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p
# 3) CPU decode + CPU filters, h264_vaapi encode (CQP 20)
run vaapi_h264_qp20_cpudec -threads ${THREADS} -vaapi_device ${DEV} -i "${IN}" \
    -vf "${VF},format=nv12,hwupload" -c:v h264_vaapi -rc_mode CQP -qp 20 -profile:v high
# 4) VAAPI HEVC decode -> download -> CPU crop/scale/ass -> upload -> h264_vaapi
run vaapi_h264_qp20_gpudec -threads ${THREADS} -init_hw_device vaapi=va:${DEV} -filter_hw_device va -hwaccel vaapi -hwaccel_device va -hwaccel_output_format vaapi -i "${IN}" \
    -vf "hwdownload,format=nv12,${VF},format=nv12,hwupload" -c:v h264_vaapi -rc_mode CQP -qp 20 -profile:v high
# 5) scale_vaapi is NOT used: on gfx1150 + Mesa 25.0.4 it goes through the VPE block and
#    spams "SIVPE ERROR si_vpe_construct_blt ... (9)" per frame. Scale on CPU instead.
# 6) VBR at a fixed bitrate (closer to what a phone upload wants)
run vaapi_h264_vbr12M -threads ${THREADS} -init_hw_device vaapi=va:${DEV} -filter_hw_device va -hwaccel vaapi -hwaccel_device va -hwaccel_output_format vaapi -i "${IN}" \
    -vf "hwdownload,format=nv12,${VF},format=nv12,hwupload" -c:v h264_vaapi -rc_mode VBR -b:v 12M -maxrate 16M -profile:v high
# 7) hevc_vaapi CQP 22. Mesa 25.0.4/VCN on gfx1150 writes in-band SPS with width padded to 1088 and NO
#    conformance window (hvcC says 1080) -> decoders show 1088 px with 8 px of junk. Fix: hevc_metadata bsf.
run vaapi_hevc_qp22 -threads ${THREADS} -init_hw_device vaapi=va:${DEV} -filter_hw_device va -hwaccel vaapi -hwaccel_device va -hwaccel_output_format vaapi -i "${IN}" \
    -vf "hwdownload,format=nv12,${VF},format=nv12,hwupload" -c:v hevc_vaapi -rc_mode CQP -qp 22 -bsf:v hevc_metadata=crop_right=8
# 8) decode-only throughput: CPU vs VAAPI
"${HERE}/../timeit.py" "${OUT}/decode_cpu.time" "${FF}" -hide_banner -loglevel error -threads ${THREADS} -i "${IN}" -an -f null -
"${HERE}/../timeit.py" "${OUT}/decode_vaapi.time" "${FF}" -hide_banner -loglevel error -init_hw_device vaapi=va:${DEV} -filter_hw_device va -hwaccel vaapi -hwaccel_device va -hwaccel_output_format vaapi -i "${IN}" -an -f null -
echo "decode_cpu (wall user sys rss): $(cat "${OUT}/decode_cpu.time")"; echo "decode_vaapi: $(cat "${OUT}/decode_vaapi.time")"
