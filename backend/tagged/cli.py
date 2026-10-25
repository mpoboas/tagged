"""tagged CLI.

Reference photos:  refs/<person>/*.jpg   (3-5 each)
Eval photos:       test/<person>/*.jpg   (photos that contain <person>), test/_none/*.jpg (contain none of them)
"""
import argparse
import shutil
from pathlib import Path

import numpy as np

from . import api, cluster
from .engine import embed_image, list_images
from .triage import CERTAIN, REVIEW, best_scores, classify


def load_people(refs: Path) -> dict[str, np.ndarray]:
    people = {}
    for d in sorted(p for p in refs.iterdir() if p.is_dir()):
        embs = []
        if (d / "embeddings.npy").exists():
            people[d.name] = np.load(d / "embeddings.npy")
            print(f"{d.name}: {len(people[d.name])} refs")
            continue
        for img in list_images(d):
            e = embed_image(img)
            if len(e) == 0:
                print(f"  ! no face in {img}")
            elif len(e) > 1:
                print(f"  ! {len(e)} faces in {img}, use a photo with only {d.name}")
            else:
                embs.append(e[0])
        if embs:
            people[d.name] = np.stack(embs)
            print(f"{d.name}: {len(embs)} refs")
    return people


def cmd_match(a):
    people = load_people(Path(a.refs))
    out = Path(a.out)
    for img in list_images(Path(a.photos)):
        scores = best_scores(embed_image(img), people)
        if not scores:
            label, who = "sem match", None
        else:
            who, s = max(scores.items(), key=lambda kv: kv[1])
            label = classify(s, a.certain, a.review)
        dest = out / label
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(img, dest / img.name)
        print(f"{img.name}: {label}" + (f" ({who}, {s:.2f})" if who and label != "sem match" else ""))


def cmd_eval(a):
    people = load_people(Path(a.refs))
    truth: dict[str, set[str]] = {}  # photos can sit in several folders: one per person they contain
    paths: dict[str, Path] = {}
    for d in sorted(p for p in Path(a.test).iterdir() if p.is_dir()):
        for img in list_images(d):
            paths[img.name] = img
            truth.setdefault(img.name, set())
            if d.name != "_none":
                truth[img.name].add(d.name)
    scores = {n: best_scores(embed_image(p), people) for n, p in paths.items()}
    if a.fp is not None:
        fps = sorted(((s, n, name) for name, sc in scores.items() for n, s in sc.items() if s >= a.fp and n not in truth[name]), reverse=True)
        rows = "".join(
            f"<div class=c><img src='test/{next(d.name for d in Path(a.test).iterdir() if (d / name).exists())}/{name}'>"
            f"<img class=r src='refs/{n}/0.jpg'><b>{n}</b> {s:.2f}<br><small>{name}</small></div>" for s, n, name in fps)
        Path(a.test).parent.joinpath("fp.html").write_text(
            "<meta charset=utf-8><style>body{background:#111;color:#eee;font:13px system-ui}.c{display:inline-block;margin:6px;width:420px}"
            ".c img{height:260px;max-width:300px;object-fit:contain}.c .r{height:110px}</style>" + rows)
        for s, n, name in fps:
            print(f"{s:.2f}  {n:12s} {name}")
        print(f"{len(fps)} false positives at >= {a.fp}; see data/fp.html")
        return
    print(f"\n{len(scores)} test photos. threshold sweep over (photo, person) pairs:")
    print("  t     precision  recall")
    for t in np.arange(0.25, 0.71, 0.05):
        tp = fp = fn = 0
        for name, sc in scores.items():
            hits = {n for n, s in sc.items() if s >= t}
            tp += len(hits & truth[name])
            fp += len(hits - truth[name])
            fn += len(truth[name] - hits)
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        print(f"  {t:.2f}  {p:8.2f}  {r:7.2f}")


def main():
    ap = argparse.ArgumentParser(prog="tagged")
    sub = ap.add_subparsers(required=True)
    m = sub.add_parser("match", help="triage a folder of photos into certeza/rever/sem match")
    m.add_argument("--refs", default="data/refs")
    m.add_argument("--photos", required=True)
    m.add_argument("--out", default="data/out")
    m.add_argument("--certain", type=float, default=CERTAIN)
    m.add_argument("--review", type=float, default=REVIEW)
    m.set_defaults(fn=cmd_match)
    e = sub.add_parser("eval", help="precision/recall by threshold on labelled photos")
    e.add_argument("--refs", default="data/refs")
    e.add_argument("--test", default="data/test")
    e.add_argument("--fp", type=float, help="list false positives at this threshold and write data/fp.html")
    e.set_defaults(fn=cmd_eval)
    c = sub.add_parser("cluster", help="detect + cluster all faces in a photo folder")
    c.add_argument("--photos", default="data/raw")
    c.add_argument("--distance", type=float, default=0.6, help="cosine distance cut (lower = stricter, more clusters)")
    c.set_defaults(fn=lambda a: cluster.build(Path(a.photos), a.distance))
    l = sub.add_parser("label", help="web UI to name clusters and export refs/test")
    l.add_argument("--port", type=int, default=8765)
    l.add_argument("--min-size", type=int, default=3)
    l.set_defaults(fn=lambda a: cluster.serve(a.port, a.min_size))
    x = sub.add_parser("export", help="write data/refs and data/test from saved names")
    x.set_defaults(fn=lambda a: print(cluster.export()))
    v = sub.add_parser("serve", help="webapp + API (open the printed URL)")
    v.add_argument("--refs", default="data/refs")
    v.add_argument("--port", type=int, default=8768)
    v.set_defaults(fn=lambda a: api.serve(Path(a.refs), a.port))
    a = ap.parse_args()
    a.fn(a)
