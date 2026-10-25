"""One local server: the webapp at / and its API. Binds to 127.0.0.1 only.

POST /api/score?name=<key>  body = image bytes -> {w, h, faces:[{bbox, scores:[[person, score], ...]}]}
GET  /api/people            -> enrolled names
GET  /api/ping
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

from .engine import _app
from .page import PAGE


def load_people(refs: Path) -> dict[str, np.ndarray]:
    return {d.name: np.load(d / "embeddings.npy") for d in sorted(refs.iterdir()) if (d / "embeddings.npy").exists()}


def score_image(data: bytes, people: dict[str, np.ndarray]) -> dict:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not an image")
    h, w = img.shape[:2]
    faces = []
    for f in _app().get(img):
        sc = sorted(((n, round(float((r @ f.normed_embedding).max()), 3)) for n, r in people.items()), key=lambda kv: -kv[1])
        faces.append({"bbox": [int(v) for v in f.bbox], "scores": [list(x) for x in sc if x[1] >= 0.2]})
    return {"w": w, "h": h, "faces": faces}


def origin_ok(origin: str | None) -> bool:
    # Any web page can reach localhost, so only our own UI may call the API.
    return origin is None or origin.startswith(("http://127.0.0.1", "http://localhost"))


def serve(refs: Path, port: int):
    people = load_people(refs)
    print(f"{len(people)} people loaded; warming model...")
    _app()

    class H(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            pass

        def _send(self, body, ctype="application/json", code=200):
            b = body if isinstance(body, bytes) else body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.end_headers()
            self.wfile.write(b)

        def _guard(self):
            if not origin_ok(self.headers.get("Origin")):
                self._send(json.dumps({"error": "origin not allowed"}), code=403)
                return False
            return True

        def do_GET(self):
            if not self._guard():
                return
            path = urlparse(self.path).path
            if path == "/":
                self._send(PAGE, "text/html; charset=utf-8")
            elif path == "/api/ping":
                self._send(json.dumps({"ok": True, "people": len(people)}))
            elif path == "/api/people":
                self._send(json.dumps(sorted(people), ensure_ascii=False))
            else:
                self._send(json.dumps({"error": "not found"}), code=404)

        def do_POST(self):
            if not self._guard():
                return
            u = urlparse(self.path)
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if u.path != "/api/score":
                return self._send(json.dumps({"error": "not found"}), code=404)
            try:
                self._send(json.dumps(score_image(body, people), ensure_ascii=False))
            except ValueError as e:
                self._send(json.dumps({"error": str(e)}), code=400)

    print(f"tagged on http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
