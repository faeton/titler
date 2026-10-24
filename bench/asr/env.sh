# source me: common env for ASR bench
export HF_HOME=/mnt/flash/scratch/hf-cache
export UV_CACHE_DIR=/mnt/flash/scratch/uv-cache
export PIP_CACHE_DIR=/mnt/flash/scratch/pip-cache
export XDG_CACHE_HOME=/mnt/flash/scratch/hf-cache/xdg
export TORCH_HOME=/mnt/flash/scratch/hf-cache/torch
export OMP_NUM_THREADS=8 MKL_NUM_THREADS=8 OPENBLAS_NUM_THREADS=8 NUMEXPR_NUM_THREADS=8
export ASR_THREADS=8
export BENCH=/mnt/flash/home/faeton/work/titler/bench
