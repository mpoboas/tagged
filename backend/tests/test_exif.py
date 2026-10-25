"""setExif lives in the webapp (app.js); run it with node and read the result back with Pillow."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image

APP = Path(__file__).resolve().parents[1] / "tagged" / "web" / "app.js"


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
def test_set_exif(tmp_path):
    src = APP.read_text()
    fn = re.search(r"function setExif\(src, d\) \{.*?\n\}\n", src, re.S).group(0)
    jpg = cv2.imencode(".jpg", np.zeros((8, 8, 3), np.uint8))[1].tobytes()   # OpenCV writes a JFIF APP0
    (tmp_path / "in.jpg").write_bytes(jpg)
    out = tmp_path / "out.jpg"
    script = f"""const fs=require('fs');const pad=n=>String(n).padStart(2,'0');{fn}
const d=new Date(2025,1,14,5,9,3);fs.writeFileSync({json.dumps(str(out))},setExif(new Uint8Array(fs.readFileSync({json.dumps(str(tmp_path / 'in.jpg'))})),d));"""
    subprocess.run(["node", "-e", script], check=True, env={"TZ": "Europe/Lisbon", "PATH": "/usr/bin:/bin:" + str(Path(shutil.which("node")).parent)})
    data = out.read_bytes()
    assert data[2:4] == b"\xff\xe0", "JFIF APP0 stays first"
    img = Image.open(out)
    exif = img.getexif()
    sub = exif.get_ifd(0x8769)
    assert exif[0x0132] == "2025:02:14 05:09:03"
    assert sub[0x9003] == "2025:02:14 05:09:03" and sub[0x9011] == "+00:00"
    img.load()


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
def test_people_export_loads_in_numpy(tmp_path):
    """The webapp's 'exportar people.npz' writes .npy files by hand; numpy must read them back."""
    fn = re.search(r"function npy\(a, k\) \{.*?\n\}\n", APP.read_text(), re.S).group(0)
    out = tmp_path / "x.npy"
    script = f"""const fs=require('fs');{fn}
const a=new Float32Array(3*512).map((_, i)=>i/1000);fs.writeFileSync({json.dumps(str(out))},npy(a,3));"""
    subprocess.run(["node", "-e", script], check=True)
    arr = np.load(out)
    assert arr.shape == (3, 512) and arr.dtype == np.float32 and abs(arr[2, 511] - 1.535) < 1e-6
