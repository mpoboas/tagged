"""One local server: the webapp at / and its API. Binds to 127.0.0.1 only.

POST /api/score?name=<key>  body = image bytes -> {w, h, faces:[{bbox, emb:[512 floats]}]}
GET  /extension.zip, /api/version, /api/ping

No people live on the server: the browser keeps them (IndexedDB) and does the matching.
"""
import base64
import hmac
import io
import json
import os
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

from .engine import _app
from .page import PAGE


def score_image(data: bytes) -> dict:
    """Detect faces and return each face's box and 512-d embedding; the browser matches them against the people it holds."""
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not an image")
    h, w = img.shape[:2]
    faces = [{"bbox": [int(v) for v in f.bbox], "emb": [round(float(x), 4) for x in f.normed_embedding]} for f in _app().get(img)]
    return {"w": w, "h": h, "faces": faces}


def origin_ok(origin: str | None, host: str | None) -> bool:
    # Any web page can reach a local server, so only our own UI (same origin) may call the API.
    if origin is None:
        return True
    netloc = origin.split("://", 1)[-1]
    return netloc == host or origin.startswith(("http://127.0.0.1", "http://localhost"))


def extension_dir() -> Path:
    env = os.environ.get("TAGGED_EXTENSION_DIR")
    return Path(env) if env else Path(__file__).resolve().parents[2] / "extension"


def extension_zip(origin_pattern: str | None) -> bytes:
    """The extension as a zip, with this server's address added to the pages where the bridge runs."""
    root = extension_dir()
    manifest = json.loads((root / "manifest.json").read_text())
    if origin_pattern:
        for cs in manifest["content_scripts"]:
            if "bridge.js" in cs["js"] and origin_pattern not in cs["matches"]:
                cs["matches"].append(origin_pattern)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(root.rglob("*")):
            if f.is_file() and f.name != "manifest.json" and not f.name.startswith("."):
                z.write(f, "tagged-extension/" + f.relative_to(root).as_posix())
        z.writestr("tagged-extension/manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
    return buf.getvalue()


def serve(port: int, host: str = "127.0.0.1"):
    password = os.environ.get("TAGGED_PASSWORD", "")
    if host not in ("127.0.0.1", "localhost") and not password:
        print("WARNING: listening on a non-local address without TAGGED_PASSWORD; anyone who can reach it can use it.")
    print("loading model (first run downloads ~280 MB)...")
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
            if not origin_ok(self.headers.get("Origin"), self.headers.get("Host")):
                self._send(json.dumps({"error": "origin not allowed"}), code=403)
                return False
            if password and urlparse(self.path).path != "/api/ping":
                given = self.headers.get("Authorization", "")
                want = "Basic " + base64.b64encode(f"{os.environ.get('TAGGED_USER', 'tagged')}:{password}".encode()).decode()
                if not hmac.compare_digest(given.encode(), want.encode()):
                    self.send_response(401)
                    self.send_header("WWW-Authenticate", 'Basic realm="tagged"')
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return False
            return True

        def _origin_pattern(self):
            proto = self.headers.get("X-Forwarded-Proto") or "http"
            h = (self.headers.get("Host") or "").split(":")[0]
            return f"{proto}://{h}/*" if h and h not in ("127.0.0.1", "localhost") else None

        def do_GET(self):
            if not self._guard():
                return
            path = urlparse(self.path).path
            if path == "/":
                self._send(PAGE, "text/html; charset=utf-8")
            elif path == "/api/ping":
                self._send(json.dumps({"ok": True}))
            elif path == "/extension.zip":
                b = extension_zip(self._origin_pattern())
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Disposition", 'attachment; filename="tagged-extension.zip"')
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
            elif path == "/api/version":
                self._send(json.dumps({"extension": json.loads((extension_dir() / "manifest.json").read_text())["version"]}))
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
                self._send(json.dumps(score_image(body)))
            except ValueError as e:
                self._send(json.dumps({"error": str(e)}), code=400)

    print(f"tagged on http://{host}:{port}")
    ThreadingHTTPServer((host, port), H).serve_forever()
