# Runs mokuro (https://github.com/kha-white/mokuro) against volumes in the
# self-hosted server library. See docker-compose.yml (service "mokuro-worker")
# and README.md ("Mokuro processing").
#
# CPU-only by design for this deployment (see README) — GPU support would mean
# swapping the torch install line below for a CUDA wheel and adding GPU
# passthrough (nvidia-container-toolkit + `deploy.resources` in compose).
#
# build-essential is included because manga-ocr's dependency chain (fugashi/
# MeCab bindings, etc.) doesn't publish prebuilt wheels for every CPU
# architecture — without it, pip install would fail outright on a platform
# with no matching wheel (e.g. some arm64 hosts) instead of compiling from
# source. This does make the image larger and the first build slower.
#
# mokuro declares a direct dependency on `opencv-python` (the GUI/X11-linked
# build) even though nothing here ever opens a window — its `import cv2`
# then fails on a slim base image with e.g. "libxcb.so.1: cannot open shared
# object file" (Debian's minimal image has none of the X11/GTK libraries
# that build links against). Rather than chase that dependency chain one
# apt package at a time, swap it for opencv-python-headless — identical cv2
# API, zero GUI dependencies — right after mokuro installs it. This is a
# well-established pattern for opencv-python in headless/server containers.
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch first, from its dedicated index, so the much larger
# default (CUDA-enabled) build is never pulled in — mokuro's own torch
# dependency is then satisfied by this already-installed version.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir mokuro \
    && pip uninstall -y opencv-python \
    && pip install --no-cache-dir opencv-python-headless

COPY app ./app

# Where manga-ocr's model weights land on first run (see docker-compose.yml,
# which mounts a named volume here so they aren't re-downloaded on restart).
ENV HF_HOME=/root/.cache/huggingface

EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
