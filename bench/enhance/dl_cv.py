# Pre-download ClearerVoice checkpoints into /mnt/flash/scratch/clearvoice/checkpoints
import os, sys
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from huggingface_hub import snapshot_download
for m in sys.argv[1:] or ['FRCRN_SE_16K', 'MossFormerGAN_SE_16K', 'MossFormer2_SE_48K']:
    print(snapshot_download(repo_id='alibabasglab/' + m, local_dir='/mnt/flash/scratch/clearvoice/checkpoints/' + m), flush=True)
