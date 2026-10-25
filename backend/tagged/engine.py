import math
import os
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from .triage import usable

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def cpu_budget() -> int:
    """CPUs this process may really use. onnxruntime sizes its thread pool from the host's core count and ignores a
    container's CPU quota (docker --cpus), then thrashes: 4 allowed cores on a 10-core host ran 4x slower than needed.
    TAGGED_THREADS overrides (useful on a shared server)."""
    if os.environ.get("TAGGED_THREADS"):
        return max(1, int(os.environ["TAGGED_THREADS"]))
    n = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)
    for fn in (_cgroup2_cpus, _cgroup1_cpus):
        q = fn()
        if q:
            n = min(n, q)
    return max(1, n)


def _cgroup2_cpus() -> int | None:
    try:
        quota, period = open("/sys/fs/cgroup/cpu.max").read().split()
        return None if quota == "max" else max(1, math.ceil(int(quota) / int(period)))
    except Exception:
        return None


def _cgroup1_cpus() -> int | None:
    try:
        q = int(open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read())
        p = int(open("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read())
        return max(1, math.ceil(q / p)) if q > 0 else None
    except Exception:
        return None


@lru_cache(maxsize=1)
def _app():
    import onnxruntime as ort
    from insightface.app import FaceAnalysis

    threads = cpu_budget()
    real_session = ort.InferenceSession

    def limited(path, sess_options=None, *args, **kw):          # insightface builds its sessions without options
        so = sess_options or ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        return real_session(path, so, *args, **kw)

    ort.InferenceSession = limited
    print(f"inference threads: {threads}", flush=True)

    have = ort.get_available_providers()
    providers = [p for p in ("CoreMLExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider") if p in have]
    # INSIGHTFACE_HOME lets a container keep the (non-commercial licence) models in a volume instead of in the image.
    # Only detection + recognition: buffalo_l also ships landmark and gender/age models we never use (~20% faster).
    app = FaceAnalysis(
        name="buffalo_l", root=os.environ.get("INSIGHTFACE_HOME", "~/.insightface"), providers=providers,
        allowed_modules=["detection", "recognition"],
    )
    size = int(os.environ.get("TAGGED_DET_SIZE", "960"))   # 640 is ~2x faster on CPU, small faces are found a bit less
    app.prepare(ctx_id=0, det_size=(size, size))
    return app


def list_images(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXTS)


def shrink(img: np.ndarray, max_side: int | None) -> np.ndarray:
    """Downscale so the longest side is max_side: lets eval see photos at Facebook-thumbnail size, like the webapp."""
    h, w = img.shape[:2]
    if not max_side or max(h, w) <= max_side:
        return img
    k = max_side / max(h, w)
    return cv2.resize(img, (round(w * k), round(h * k)), interpolation=cv2.INTER_AREA)


def embed_image(path: Path, max_side: int | None = None) -> np.ndarray:
    """Return an (n_faces, 512) array of L2-normalised embeddings of the usable faces (see triage.usable)."""
    img = cv2.imread(str(path))
    if img is None:
        return np.zeros((0, 512), dtype=np.float32)
    faces = [f for f in _app().get(shrink(img, max_side)) if usable(f)]
    if not faces:
        return np.zeros((0, 512), dtype=np.float32)
    return np.stack([f.normed_embedding for f in faces]).astype(np.float32)


def detect_faces(path: Path):
    """Return (image, faces) where each face has .bbox, .det_score and .normed_embedding; image is None if unreadable."""
    img = cv2.imread(str(path))
    if img is None:
        return None, []
    return img, _app().get(img)
