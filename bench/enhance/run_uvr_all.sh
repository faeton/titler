#!/bin/bash
. "$(dirname "$0")/env.sh"
P="$ENVS/enh-demucs/bin/python $B/enhance/run_uvr.py"
$P vocals_mel_band_roformer.ckpt melroformer-kim Vocals
$P model_bs_roformer_ep_317_sdr_12.9755.ckpt bsroformer-1297 Vocals
# VR arch needs system libsamplerate (absent on TrueNAS) -> skipped
# $P UVR-DeNoise.pth uvr-denoise "No Noise"
