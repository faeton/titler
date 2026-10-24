#!/bin/bash
# usage: batch_enh.sh spec...   (cv:* specs run in the numpy<2 venv)
cd "$(dirname "$0")"; L=/mnt/flash/home/faeton/work/titler/bench/runs/gpu/enhance; mkdir -p ${L}
for spec in "$@"; do
  t=${spec/:/-}; py=/venv/bin/python; [[ ${spec} == cv:* ]] && py=/venvcv/bin/python
  ../gttpeak.sh ${L}/${t}.gtt & GP=$!
  PY=${py} ./run.sh enh_gpu.py ${spec} ${DEVICE:+--device $DEVICE} 2>&1 | grep -v '(null)' > ${L}/${t}${DEVICE:+-$DEVICE}.log
  kill ${GP}; sleep 0.5
  echo "== ${spec} gtt_peak=$(cat ${L}/${t}.gtt)MiB"; grep -E "^\{|use_cuda" ${L}/${t}${DEVICE:+-$DEVICE}.log || tail -5 ${L}/${t}${DEVICE:+-$DEVICE}.log
done
