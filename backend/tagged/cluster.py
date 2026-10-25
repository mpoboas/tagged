"""Cluster every face in a photo folder, name the clusters in a local web UI, export refs/test sets.

    tagged cluster --photos data/raw      # detect + cluster (cached in data/cluster)
    tagged label                          # open http://127.0.0.1:8765 and name people
Export (button in the UI, or `tagged export`) writes data/refs/<name>/ and data/test/<name>/ + data/test/_none/.
"""
import json
import shutil
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage

from .engine import detect_faces

WORK = Path("data/cluster")
MIN_DET, MIN_SIZE, N_REFS = 0.6, 40, 5


def build(photos: Path, distance: float):
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "crops").mkdir(exist_ok=True)
    rows, embs = [], []
    files = sorted(p for p in photos.rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
    for i, f in enumerate(files):
        img, faces = detect_faces(f)
        for face in faces:
            x1, y1, x2, y2 = [int(v) for v in face.bbox]
            if face.det_score < MIN_DET or min(x2 - x1, y2 - y1) < MIN_SIZE:
                continue
            fid = len(rows)
            h, w = img.shape[:2]
            px, py = int((x2 - x1) * 0.3), int((y2 - y1) * 0.3)
            crop = img[max(0, y1 - py):min(h, y2 + py), max(0, x1 - px):min(w, x2 + px)]
            cv2.imwrite(str(WORK / "crops" / f"{fid}.jpg"), cv2.resize(crop, (112, 112)))
            rows.append({"photo": str(f.resolve()), "bbox": [x1, y1, x2, y2]})
            embs.append(face.normed_embedding)
        if (i + 1) % 50 == 0 or i + 1 == len(files):
            print(f"{i + 1}/{len(files)} photos, {len(rows)} faces", flush=True)
    E = np.stack(embs).astype(np.float32)
    labels = fcluster(linkage(E, "average", metric="cosine"), distance, "distance")
    for r, l in zip(rows, labels):
        r["cluster"] = int(l)
    np.save(WORK / "embeddings.npy", E)
    (WORK / "faces.json").write_text(json.dumps(rows))
    sizes = np.bincount(labels)
    print(f"{len(set(labels))} clusters; {(sizes >= 3).sum()} with 3+ faces")


def _load():
    rows = json.loads((WORK / "faces.json").read_text())
    names_p = WORK / "names.json"
    names = json.loads(names_p.read_text()) if names_p.exists() else {}
    return rows, names


def export():
    rows, names = _load()
    E = np.load(WORK / "embeddings.npy")
    by_name: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        n = names.get(str(r["cluster"]), "").strip()
        if n:
            by_name.setdefault(n, []).append(i)
    for d in (Path("data/refs"), Path("data/test")):
        shutil.rmtree(d, ignore_errors=True)
    named_photos = set()
    for name, idx in by_name.items():
        cen = E[idx].mean(0)
        order = [idx[j] for j in np.argsort(-(E[idx] @ cen))]
        refs, rest = order[:N_REFS], order[N_REFS:]
        rd = Path("data/refs") / name
        rd.mkdir(parents=True, exist_ok=True)
        for k, fi in enumerate(refs):
            r = rows[fi]
            img = cv2.imread(r["photo"])
            x1, y1, x2, y2 = r["bbox"]
            h, w = img.shape[:2]
            px, py = int((x2 - x1) * 0.25), int((y2 - y1) * 0.25)
            cv2.imwrite(str(rd / f"{k}.jpg"), img[max(0, y1 - py):min(h, y2 + py), max(0, x1 - px):min(w, x2 + px)])
        np.save(rd / "embeddings.npy", E[refs])  # exact labelled faces; crops are only for viewing
        td = Path("data/test") / name
        td.mkdir(parents=True, exist_ok=True)
        ref_photos = {rows[fi]["photo"] for fi in refs}
        for photo in sorted({rows[fi]["photo"] for fi in rest} - ref_photos):
            shutil.copy2(photo, td / Path(photo).name)
        named_photos |= {rows[fi]["photo"] for fi in idx}
    nd = Path("data/test/_none")
    nd.mkdir(parents=True, exist_ok=True)
    for photo in sorted({r["photo"] for r in rows} - named_photos):
        shutil.copy2(photo, nd / Path(photo).name)
    return {n: len(i) for n, i in by_name.items()}


PAGE = """<!doctype html><meta charset=utf-8><title>tagged</title>
<style>body{font:14px system-ui;margin:16px;background:#111;color:#eee}
.c{display:inline-block;vertical-align:top;width:380px;margin:6px;padding:10px;background:#1d1d1d;border-radius:8px}
.c.named{outline:2px solid #3b82f6}.c img{width:56px;height:56px;object-fit:cover;margin:1px;border-radius:4px}
input{width:100%;box-sizing:border-box;margin-top:6px;padding:6px;background:#000;color:#eee;border:1px solid #444;border-radius:4px}
button{padding:8px 14px;margin-right:8px}#bar{position:sticky;top:0;background:#111;padding:8px 0}</style>
<div id=bar><button onclick=exp()>Export refs/test</button><span id=msg></span>
<label><input type=checkbox id=hide> hide named</label></div><div id=app></div><datalist id=dl></datalist>
<script>
let names={},cl=[];
const q=async(u,o)=>(await fetch(u,o)).json();
async function load(){const d=await q('/api/clusters');names=d.names;cl=d.clusters;draw()}
function dl(){document.getElementById('dl').innerHTML=[...new Set(Object.values(names).filter(x=>x))].map(n=>`<option value="${n}">`).join('')}
function draw(){const hide=document.getElementById('hide').checked;dl();
 document.getElementById('app').innerHTML=cl.filter(c=>!(hide&&names[c.id])).map(c=>`<div class="c ${names[c.id]?'named':''}">
 ${c.sample.map(i=>`<img src="/crop/${i}.jpg">`).join('')}<div>${c.size} faces · ${c.photos} photos</div>
 <input list=dl placeholder="name (blank = skip)" value="${names[c.id]||''}" onchange="setName(${c.id},this)"></div>`).join('')}
async function setName(id,el){names[id]=el.value.trim();el.closest('.c').classList.toggle('named',!!names[id]);dl();
 await q('/api/names',{method:'POST',body:JSON.stringify(names)})}
async function exp(){document.getElementById('msg').textContent=' exporting…';
 const r=await q('/api/export',{method:'POST'});document.getElementById('msg').textContent=' exported: '+JSON.stringify(r)}
document.getElementById('hide').onchange=draw;load()
</script>"""


def serve(port: int, min_size: int):
    rows, _ = _load()
    E = np.load(WORK / "embeddings.npy")
    groups: dict[int, list[int]] = {}
    for i, r in enumerate(rows):
        groups.setdefault(r["cluster"], []).append(i)
    clusters = []
    for cid, idx in groups.items():
        if len(idx) < min_size:
            continue
        cen = E[idx].mean(0)
        top = [idx[j] for j in np.argsort(-(E[idx] @ cen))[:24]]
        clusters.append({"id": cid, "size": len(idx), "photos": len({rows[i]["photo"] for i in idx}), "sample": top})
    clusters.sort(key=lambda c: -c["size"])

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, body, ctype="application/json"):
            b = body if isinstance(body, bytes) else body.encode()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if self.path == "/":
                self._send(PAGE, "text/html; charset=utf-8")
            elif self.path == "/api/clusters":
                self._send(json.dumps({"clusters": clusters, "names": _load()[1]}))
            elif self.path.startswith("/crop/"):
                self._send((WORK / "crops" / Path(self.path).name).read_bytes(), "image/jpeg")
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path == "/api/names":
                n = int(self.headers.get("Content-Length", 0))
                (WORK / "names.json").write_text(self.rfile.read(n).decode())
                self._send("{}")
            elif self.path == "/api/export":
                self._send(json.dumps(export()))
            else:
                self.send_error(404)

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    url = f"http://127.0.0.1:{port}"
    print(f"label UI at {url}  ({len(clusters)} clusters with >= {min_size} faces)")
    webbrowser.open(url)
    srv.serve_forever()
