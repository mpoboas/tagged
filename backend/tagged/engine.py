import os
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


@lru_cache(maxsize=1)
def _app():
    from insightface.app import FaceAnalysis

    import onnxruntime as ort

    have = ort.get_available_providers()
    providers = [p for p in ("CoreMLExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider") if p in have]
    # INSIGHTFACE_HOME lets a container keep the (non-commercial licence) models in a volume instead of in the image.
    app = FaceAnalysis(name="buffalo_l", root=os.environ.get("INSIGHTFACE_HOME", "~/.insightface"), providers=providers)
    app.prepare(ctx_id=0, det_size=(960, 960))
    return app


def list_images(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXTS)


def embed_image(path: Path) -> np.ndarray:
    """Return an (n_faces, 512) array of L2-normalised embeddings."""
    img = cv2.imread(str(path))
    if img is None:
        return np.zeros((0, 512), dtype=np.float32)
    faces = _app().get(img)
    if not faces:
        return np.zeros((0, 512), dtype=np.float32)
    return np.stack([f.normed_embedding for f in faces]).astype(np.float32)


def detect_faces(path: Path):
    """Return (image, faces) where each face has .bbox, .det_score and .normed_embedding; image is None if unreadable."""
    img = cv2.imread(str(path))
    if img is None:
        return None, []
    return img, _app().get(img)
