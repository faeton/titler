#!/bin/bash
. "$(dirname "$0")/env.sh"
for m in ${MODELS:-htdemucs htdemucs_ft}; do $ENVS/enh-demucs/bin/python $B/enhance/run_demucs.py $m; done
