#!/bin/bash
# Serial GPU ASR batch; records GTT/VRAM peak (incl. any other GPU users) per backend.
cd "$(dirname "$0")"
L=/mnt/flash/home/faeton/work/titler/bench/runs/gpu/asr; mkdir -p ${L}
while [ $# -gt 0 ]; do
  spec=$1; shift; b=${spec%%:*}; ct=${spec#*:}; [ "${ct}" = "${spec}" ] && ct=""
  ../gttpeak.sh ${L}/${b}${ct:+-$ct}.gtt & GP=$!
  ./run.sh asr_gpu.py ${b} ${ct:+--ct $ct} ${DEVICE:+--device $DEVICE} 2>&1 | grep -v '(null)' > ${L}/${b}${ct:+-$ct}.log
  kill ${GP}; sleep 0.5
  echo "== ${spec} gtt_peak=$(cat ${L}/${b}${ct:+-$ct}.gtt)MiB"; grep '^\[' ${L}/${b}${ct:+-$ct}.log || tail -5 ${L}/${b}${ct:+-$ct}.log
  [ $# -eq 0 ] && break
done
