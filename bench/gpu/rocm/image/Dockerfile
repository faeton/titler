# Thin runtime for the ROCm PyTorch venv kept on scratch (torch wheels bundle the ROCm user-space).
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      libatomic1 libnuma1 libelf1 libdrm2 libgomp1 libsndfile1 git \
    && rm -rf /var/lib/apt/lists/*
