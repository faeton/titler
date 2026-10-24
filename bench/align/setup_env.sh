#!/bin/bash
# Recreate bench/envs/align-main (CPU-only) on n5 (no apt, no C compiler).
# ctc-forced-aligner needs a C++ build: we use zig (pip "ziglang") as cc/c++ and the
# headers of a uv-managed CPython 3.11 (system python3.11 ships without Python.h).
set -euo pipefail
BENCH=$(cd "$(dirname "$0")/.." && pwd)
export UV_CACHE_DIR=/mnt/flash/scratch/uv-cache UV_PYTHON_INSTALL_DIR=/mnt/flash/scratch/uv-python
UV=~/.local/bin/uv
ENV=$BENCH/envs/align-main
P=$ENV/bin/python
$UV venv --seed -p 3.11 "$ENV"
$UV pip install -p "$P" --index-url https://download.pytorch.org/whl/cpu torch==2.5.1+cpu torchaudio==2.5.1+cpu
$UV pip install -p "$P" faster-whisper transformers==4.46.3 uroman silero-vad soundfile numpy pandas ziglang num2words
$UV pip install -p "$P" --no-deps whisperx==3.8.6
# GigaAM (MIT) without its torch extra; source from GitHub
$UV pip install -p "$P" "git+https://github.com/salute-developers/GigaAM"
# zig as the C/C++ compiler
Z=/mnt/flash/scratch/tmp/zigcc; mkdir -p $Z
for n in cc c++; do cat > $Z/$n <<EOF
#!/bin/bash
args=()
for a in "\$@"; do case "\$a" in -Wl,-Bsymbolic-functions) ;; *) args+=("\$a");; esac; done
exec $P -m ziglang $n "\${args[@]}"
EOF
chmod +x $Z/$n; done
$UV python install 3.11
INC=$(ls -d /mnt/flash/scratch/uv-python/cpython-3.11*/include/python3.11 | head -1)
PATH=$Z:$PATH CC=$Z/cc CXX=$Z/c++ CFLAGS="-I$INC" CPPFLAGS="-I$INC" \
  $UV pip install -p "$P" "git+https://github.com/MahmoudAshraf97/ctc-forced-aligner.git"
echo "done: $P"
