#!/bin/bash
# VMAF (every 4th frame) + PSNR-Y of each encode vs a lossless (x264 qp0) render of the same filter chain.
IN=${1:?src}; OUT=${2:?outdir}; HERE=$(cd "$(dirname "$0")" && pwd)
VF="crop=1035:1840,scale=1080:1920:flags=bicubic,ass=${HERE}/test.ass"
REF=/mnt/flash/scratch/titler-gpu/ref_lossless.mkv
[ -s "${REF}" ] || ~/.local/bin/ffmpeg -hide_banner -loglevel error -y -threads 8 -i "${IN}" -vf "${VF}" -an -c:v libx264 -qp 0 -preset ultrafast -pix_fmt yuv420p "${REF}"
echo "variant,vmaf_mean,vmaf_p5,psnr_y" > "${OUT}/vmaf.csv"
for f in "${OUT}"/*.mp4; do
  n=$(basename "${f}" .mp4); log="${OUT}/${n}.vmaf.json"
  ~/.local/bin/ffmpeg -hide_banner -loglevel error -i "${f}" -i "${REF}" -lavfi \
    "[0:v]crop=1080:1920:0:0,format=yuv420p,setpts=N/(30*TB)[d];[1:v]format=yuv420p,setpts=N/(30*TB)[r];[d][r]libvmaf=n_threads=8:n_subsample=4:feature=name=psnr:log_fmt=json:log_path=${log}" -f null -
  python3 - "${log}" "${n}" >> "${OUT}/vmaf.csv" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); p=d['pooled_metrics']
v=sorted(fr['metrics']['vmaf'] for fr in d['frames'])
print('%s,%.2f,%.2f,%.2f'%(sys.argv[2],p['vmaf']['mean'],v[len(v)//20],p['psnr_y']['mean']))
PY
done
cat "${OUT}/vmaf.csv"
