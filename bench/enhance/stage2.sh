#!/bin/bash
# stage 2: UVR separators + fixed DSP baselines, then postproc for the new variants
. "$(dirname "$0")/env.sh"
L=$B/runs/enhance/logs
$B/enhance/run_uvr_all.sh > $L/uvr.log 2>&1
SKIP_DFN=1 $B/enhance/run_cli.sh > $L/dsp2.log 2>&1
NEW=$(cd $B/runs/enhance/raw && ls -d melroformer-kim-* bsroformer-1297-* uvr-denoise-* dsp-* 2>/dev/null | tr '\n' ',')
ONLY=$NEW $ENVS/enh-metrics/bin/python $B/enhance/postproc.py > $L/postproc2.log 2>&1
echo stage2 done
