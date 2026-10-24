#!/bin/bash
. "$(dirname "$0")/env.sh"
for m in ${MODELS:-FRCRN_SE_16K MossFormerGAN_SE_16K MossFormer2_SE_48K}; do
  $ENVS/enh-cv/bin/python $B/enhance/run_clearvoice.py $m
done
