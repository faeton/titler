#!/bin/bash
# Run a python script inside a throwaway container with the ROCm 7.2 PyTorch venv on the 890M.
# The venv lives on scratch (/mnt/flash/scratch/titler-gpu/venv-rocm72, mounted at /venv), so the
# image is just python:3.12-slim — no 30 GB rocm/pytorch image needed (torch wheels bundle ROCm).
# usage: run.sh script.py [args...]      env: GPU=0 to hide the GPU, EXTRA_ENV="-e K=V ..."
set -u
REPO=/mnt/flash/home/faeton/work/titler
S=/mnt/flash/scratch
DEV="--device /dev/kfd --device /dev/dri --group-add $(getent group render | cut -d: -f3) --group-add $(getent group video | cut -d: -f3)"
[ "${GPU:-1}" = 0 ] && DEV=""
exec sudo docker run --rm ${DEV} --name "titler-gpu-$$" \
  --security-opt seccomp=unconfined --ipc=host \
  -v ${S}/titler-gpu/venv-rocm72:/venv -v ${S}/titler-gpu/venv-cv:/venvcv \
  -v ${S}/titler-gpu:/scratch \
  -v ${S}/hf-cache:/hf:ro -v /mnt/flash/whisper-models:/whisper-models:ro \
  -v ${REPO}/bench:/bench \
  -e HF_HOME=/scratch/hf-home -e HF_HUB_CACHE=/scratch/hf-home/hub -e HF_RO_CACHE=/hf/hub \
  -e TORCH_HOME=/scratch/torch-home -e XDG_CACHE_HOME=/scratch/xdg \
  -e OMP_NUM_THREADS=8 -e MIOPEN_USER_DB_PATH=/scratch/miopen -e MIOPEN_CUSTOM_CACHE_DIR=/scratch/miopen \
  -e LD_LIBRARY_PATH=/venv/rocm-sonames:/venv/lib/python3.12/site-packages/torch/lib ${EXTRA_ENV:-} \
  -w /bench/gpu/rocm titler-gpu-rocm:py312 ${PY:-/venv/bin/python} "$@"
