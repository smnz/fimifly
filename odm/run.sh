#!/usr/bin/env bash
# Run OpenDroneMap (GPU build) on odm/<project>/images. Outputs land next to
# the images: odm_orthophoto/odm_orthophoto.tif (+ .kmz for Google Earth),
# odm_dem/dsm.tif, odm_georeferencing/odm_georeferenced_model.laz,
# odm_texturing/ (textured mesh), and opensfm/ (camera poses, camera_models.json).
#   ./odm/run.sh <project> [extra ODM options]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${1:?usage: run.sh <project> [odm options]}"; shift || true
[ -d "$HERE/$PROJECT/images" ] || { echo "no images in $HERE/$PROJECT/images (run stage.py first)"; exit 1; }
# GPU if the NVIDIA container runtime is installed (nvidia-container-toolkit), else CPU
GPU=(); IMAGE=opendronemap/odm; FEATURES=()
if command -v nvidia-container-runtime >/dev/null 2>&1; then
  # The image ships CUDA 12.9 with a forward-compatibility libcuda that shadows the host driver's and
  # refuses GeForce cards; hiding that directory makes the container use the host driver instead.
  mkdir -p "$HERE/.nocompat"
  GPU=(--runtime=nvidia -e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=compute,utility
       -v "$HERE/.nocompat:/usr/local/cuda-12.9/compat:ro"); IMAGE=opendronemap/odm:gpu
  # only the classic SIFT extractor runs on the GPU (the default dspsift is CPU-only); dense matching uses CUDA either way
  FEATURES=(--feature-type sift)
else
  echo "nvidia-container-runtime not installed: running the CPU image (sudo apt install nvidia-container-toolkit to use the GPU)"
fi
# a name, so the editor's Cancel can stop it (docker kill)
NAME=(); [ -n "${ODM_CONTAINER:-}" ] && NAME=(--name "$ODM_CONTAINER")
exec docker run --rm "${NAME[@]}" "${GPU[@]}" \
  -v "$HERE:/datasets" \
  "$IMAGE" \
  --project-path /datasets "$PROJECT" \
  "${FEATURES[@]}" \
  --camera-lens brown \
  --feature-quality high \
  --matcher-neighbors 12 \
  --pc-quality medium \
  --dsm \
  --orthophoto-resolution 2 \
  --orthophoto-kmz \
  --auto-boundary \
  "$@"
