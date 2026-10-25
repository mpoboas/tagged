import http.client
import io
import json
import socket
import threading
import time
import zipfile

import pytest

from tagged import api
from tagged.triage import classify


def test_origin_ok():
    assert api.origin_ok(None, "127.0.0.1:8768")
    assert api.origin_ok("http://127.0.0.1:8768", "127.0.0.1:8768")
    assert api.origin_ok("http://localhost:3000", "127.0.0.1:8768")
    assert api.origin_ok("https://tagged.example.com", "tagged.example.com")
    assert not api.origin_ok("http://127.0.0.1.evil.example", "127.0.0.1:8768")
    assert not api.origin_ok("https://evil.example", "127.0.0.1:8768")


def test_host_ok():
    assert api.host_ok("127.0.0.1:8768", set())
    assert api.host_ok("localhost", set())
    assert api.host_ok("[::1]:8768", set())
    assert api.host_ok("192.168.1.20:8768", set())
    assert not api.host_ok("rebind.evil.example:8768", set())
    assert api.host_ok("nas.local:8768", {"nas.local"})


def test_extension_zip_adds_host():
    z = zipfile.ZipFile(io.BytesIO(api.extension_zip("tagged.example.com")))
    manifest = json.loads(z.read("tagged-extension/manifest.json"))
    bridge = next(cs for cs in manifest["content_scripts"] if "bridge.js" in cs["js"])
    assert "https://tagged.example.com/*" in bridge["matches"] and "http://tagged.example.com/*" in bridge["matches"]
    assert "tabs" not in manifest["permissions"]


def test_classify():
    assert classify(0.9) == "certeza" and classify(0.4) == "rever" and classify(0.1) == "sem match"


@pytest.fixture(scope="module")
def server(monkeypatch_module):
    monkeypatch_module.setattr(api, "load_model", lambda: None)   # no model in tests: /api/score stays at 503
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    threading.Thread(target=api.serve, args=(port,), daemon=True).start()
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.1).close()
            break
        except OSError:
            time.sleep(0.05)
    return port


@pytest.fixture(scope="module")
def monkeypatch_module():
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()


def req(port, method, path, body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request(method, path, body=body, headers=headers or {})
    r = c.getresponse()
    return r.status, dict(r.getheaders()), r.read()


def test_page_has_csp_and_etag(server):
    code, h, body = req(server, "GET", "/")
    assert code == 200 and b'name="tagged-app"' in body
    assert "default-src 'self'" in h["Content-Security-Policy"]
    assert req(server, "GET", "/", headers={"If-None-Match": h["ETag"]})[0] == 304
    assert req(server, "GET", "/app.css")[0] == 200 and req(server, "GET", "/fflate.js")[0] == 200


def test_score_waits_for_model(server):
    code, h, body = req(server, "POST", "/api/score", body=b"x")
    assert code == 503 and h["Retry-After"] == "5"
    assert json.loads(req(server, "GET", "/api/ping")[2])["model"] == "loading"


def test_guards(server):
    assert req(server, "GET", "/api/config", headers={"Host": "rebind.evil.example"})[0] == 403
    assert req(server, "GET", "/api/config", headers={"Origin": "http://127.0.0.1.evil.example"})[0] == 403
    assert req(server, "POST", "/api/score", headers={"Content-Length": str(api.MAX_BODY + 1)})[0] == 413
    assert json.loads(req(server, "GET", "/api/config")[2])["extension"]
