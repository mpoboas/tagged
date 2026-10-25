"""One server: the webapp at / and its API. Binds to 127.0.0.1 unless told otherwise.

POST /api/score?name=<key>  body = image bytes -> {w, h, faces:[{bbox, det, emb:[512 floats]}]}   (503 while the model loads)
GET  /extension.zip, /api/version, /api/ping, /api/config
POST /api/gphotos/{uploads,albums,mediaItems:batchCreate}   proxy to the Google Photos Library API (token from the browser)

No people live on the server: the browser keeps them (IndexedDB) and does the matching.
"""
import base64
import hashlib
import hmac
import io
import ipaddress
import json
import os
import threading
import urllib.error
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import cv2
import numpy as np

from .engine import _app
from .triage import CERTAIN, MIN_DET, MIN_FACE_PX, REVIEW, usable

WEB = Path(__file__).parent / "web"
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/app.css": ("app.css", "text/css; charset=utf-8"), "/fflate.js": ("fflate.js", "text/javascript; charset=utf-8"),
          "/favicon.svg": ("favicon.svg", "image/svg+xml"), "/favicon.ico": ("favicon.ico", "image/x-icon"),
          "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png")}
MAX_BODY = 30 * 1024 * 1024
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
GPHOTOS = "https://photoslibrary.googleapis.com/v1/"
GPHOTOS_PATHS = {"uploads", "albums", "mediaItems:batchCreate"}
# 'self' only, plus Google Identity Services for the optional Google Photos upload. Inline style attributes stay
# allowed (colours per score); no inline scripts or handlers.
CSP = ("default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https://accounts.google.com/gsi/; "
       "frame-src https://accounts.google.com/gsi/; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

model = {"state": "loading", "error": None}


def load_model():
    try:
        _app()
        model["state"] = "ready"
    except Exception as e:  # noqa: BLE001 - surfaced to the webapp through /api/ping
        model["state"], model["error"] = "error", f"{type(e).__name__}: {e}"


# One inference at a time: each one already uses every allowed core, so parallel requests would only fight over them.
_infer = threading.Lock()


def _detect(img):
    with _infer:
        return _app().get(img)


def score_image(data: bytes) -> dict:
    """Detect faces and return each usable face's box, detection score and 512-d embedding."""
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not an image")
    h, w = img.shape[:2]
    faces = [{"bbox": [int(v) for v in f.bbox], "det": round(float(f.det_score), 3),
              "emb": [round(float(x), 4) for x in f.normed_embedding]} for f in _detect(img) if usable(f)]
    return {"w": w, "h": h, "faces": faces}


def hostname(netloc: str) -> str:
    """'[::1]:8768' -> '::1', 'a.b:80' -> 'a.b'."""
    return urlparse("//" + netloc).hostname or ""


def origin_ok(origin: str | None, host: str | None) -> bool:
    # Any web page can reach a local server, so only our own UI (same origin) may call the API.
    if origin is None:
        return True
    u = urlparse(origin)
    return u.netloc == host or (u.scheme == "http" and (u.hostname or "") in LOOPBACK)


def host_ok(host: str | None, allowed: set[str]) -> bool:
    """DNS-rebinding guard: a hostile page can point its own domain at 127.0.0.1, but cannot fake an IP literal or
    localhost as the Host. Domain names must be listed in TAGGED_ALLOWED_HOSTS (or a password must be set)."""
    name = hostname(host or "")
    if name in LOOPBACK or name in allowed:
        return True
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


def extension_dir() -> Path:
    env = os.environ.get("TAGGED_EXTENSION_DIR")
    return Path(env) if env else Path(__file__).resolve().parents[2] / "extension"


def extension_version() -> str:
    return json.loads((extension_dir() / "manifest.json").read_text())["version"]


def extension_zip(host: str | None) -> bytes:
    """The extension as a zip, with this server's address added to the pages where the bridge runs (both http and https:
    the scheme a proxy or tunnel reports is not reliable, and listing both is harmless)."""
    root = extension_dir()
    manifest = json.loads((root / "manifest.json").read_text())
    if host:
        for cs in manifest["content_scripts"]:
            if "bridge.js" in cs["js"]:
                cs["matches"] += [m for m in (f"https://{host}/*", f"http://{host}/*") if m not in cs["matches"]]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(root.rglob("*")):
            if f.is_file() and f.name != "manifest.json" and not f.name.startswith("."):
                z.write(f, "tagged-extension/" + f.relative_to(root).as_posix())
        z.writestr("tagged-extension/manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
    return buf.getvalue()


def gphotos(path: str, token: str, body: bytes, ctype: str, extra: dict[str, str]) -> tuple[int, bytes, str]:
    """Forward one call to the Google Photos Library API (appendonly scope); the browser holds the OAuth token."""
    req = urllib.request.Request(GPHOTOS + path, data=body, method="POST",
                                 headers={"Authorization": "Bearer " + token, "Content-Type": ctype, **extra})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "application/json")


def serve(port: int, host: str = "127.0.0.1"):
    password = os.environ.get("TAGGED_PASSWORD", "")
    user = os.environ.get("TAGGED_USER", "tagged")
    allowed = {h.strip() for h in os.environ.get("TAGGED_ALLOWED_HOSTS", "").split(",") if h.strip()}
    google_client = os.environ.get("TAGGED_GOOGLE_CLIENT_ID", "")
    if host not in LOOPBACK and not password:
        print("WARNING: listening on a non-local address without TAGGED_PASSWORD; anyone who can reach it can use it.")
    print("loading model in the background (first run downloads ~280 MB)...")
    threading.Thread(target=load_model, daemon=True).start()
    want_auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
    etags = {}

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"  # keep-alive: the webapp sends hundreds of /api/score calls

        def log_message(self, fmt, *a):
            pass

        def _send(self, body, ctype="application/json", code=200, headers=None):
            b = body if isinstance(body, bytes) else body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(b)

        def _json(self, obj, code=200, headers=None):
            self._send(json.dumps(obj), code=code, headers=headers)

        def _guard(self):
            if not (password or host_ok(self.headers.get("Host"), allowed)):
                self._json({"error": "host not allowed; add it to TAGGED_ALLOWED_HOSTS or set TAGGED_PASSWORD"}, 403)
                return False
            if not origin_ok(self.headers.get("Origin"), self.headers.get("Host")):
                self._json({"error": "origin not allowed"}, 403)
                return False
            if password and urlparse(self.path).path != "/api/ping":
                if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), want_auth.encode()):
                    self._send(b"", "text/plain", 401, {"WWW-Authenticate": 'Basic realm="tagged"'})
                    return False
            return True

        def _public_host(self):
            h = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(",")[0].strip()
            name = hostname(h)
            return name if name and name not in LOOPBACK else None

        def _static(self, path):
            name, ctype = STATIC[path]
            body = (WEB / name).read_bytes()
            tag = etags.get(name)
            if tag is None or tag[0] != body:
                etags[name] = tag = (body, '"' + hashlib.sha256(body).hexdigest()[:16] + '"')
            if self.headers.get("If-None-Match") == tag[1]:
                self.send_response(304)
                self.send_header("ETag", tag[1])
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            headers = {"ETag": tag[1], "Cache-Control": "no-cache"}
            if name == "index.html":
                headers |= {"Content-Security-Policy": CSP, "X-Frame-Options": "DENY"}
            self._send(body, ctype, headers=headers)

        def do_GET(self):
            if not self._guard():
                return
            path = urlparse(self.path).path
            if path in STATIC:
                self._static(path)
            elif path == "/api/ping":
                self._json({"ok": True, "model": model["state"], "error": model["error"]})
            elif path == "/api/config":
                self._json({"certain": CERTAIN, "review": REVIEW, "minDet": MIN_DET, "minFace": MIN_FACE_PX,
                            "extension": extension_version(), "googleClientId": google_client or None})
            elif path == "/extension.zip":
                self._send(extension_zip(self._public_host()), "application/zip",
                           headers={"Content-Disposition": 'attachment; filename="tagged-extension.zip"'})
            elif path == "/api/version":
                self._json({"extension": extension_version()})
            else:
                self._json({"error": "not found"}, 404)

        def do_POST(self):
            if not self._guard():
                return
            u = urlparse(self.path)
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                self.close_connection = True
                return self._json({"error": f"body over {MAX_BODY // 2**20} MB"}, 413)
            body = self.rfile.read(n)
            if u.path == "/api/score":
                if model["state"] != "ready":
                    return self._json({"error": model["error"] or "model loading", "model": model["state"]},
                                      503, {"Retry-After": "5"})
                try:
                    self._json(score_image(body))
                except ValueError as e:
                    self._json({"error": str(e)}, 400)
                except Exception as e:  # noqa: BLE001 - the webapp shows it on the photo and offers a retry
                    self._json({"error": f"{type(e).__name__}: {e}"}, 500)
            elif u.path.startswith("/api/gphotos/") and u.path.removeprefix("/api/gphotos/") in GPHOTOS_PATHS:
                token = self.headers.get("X-Google-Token", "")
                if not token:
                    return self._json({"error": "missing X-Google-Token"}, 400)
                extra = {k: self.headers[k] for k in ("X-Goog-Upload-Content-Type", "X-Goog-Upload-Protocol") if k in self.headers}
                code, out, ctype = gphotos(u.path.removeprefix("/api/gphotos/"), token, body,
                                           self.headers.get("Content-Type", "application/json"), extra)
                self._send(out, ctype, code)
            else:
                self._json({"error": "not found"}, 404)

    print(f"tagged on http://{host}:{port}")
    ThreadingHTTPServer((host, port), H).serve_forever()
