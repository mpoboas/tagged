import numpy as np

CERTAIN = 0.50
REVIEW = 0.35


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
