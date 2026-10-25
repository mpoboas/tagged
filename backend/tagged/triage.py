import numpy as np

CERTAIN = 0.50
REVIEW = 0.35
# Faces below these are dropped before matching: on Facebook thumbnails (~840 px) no face under 20 px or with
# detection score under 0.6 ever reached REVIEW, they only add noise (measured on 876 faces from 122 photos).
MIN_DET = 0.60
MIN_FACE_PX = 20


def usable(face) -> bool:
    x1, y1, x2, y2 = face.bbox
    return face.det_score >= MIN_DET and min(x2 - x1, y2 - y1) >= MIN_FACE_PX


def best_scores(faces: np.ndarray, people: dict[str, np.ndarray]) -> dict[str, float]:
    """Per person: highest cosine similarity between any face in the photo and any reference."""
    if len(faces) == 0:
        return {}
    return {name: float((faces @ refs.T).max()) for name, refs in people.items()}


def classify(score: float, certain: float = CERTAIN, review: float = REVIEW) -> str:
    if score >= certain:
        return "certeza"
    if score >= review:
        return "rever"
    return "sem match"
