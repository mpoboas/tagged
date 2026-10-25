"""Regenerate every icon from assets/logo.svg and assets/logo-small.svg.

    uv run --project backend python scripts/make_icons.py

Needs Chrome/Chromium (headless, to rasterise the SVGs) and Pillow (already a backend dependency).
Set CHROME=/path/to/chrome if it is not the macOS default.
"""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
WEB = ROOT / "backend" / "tagged" / "web"
EXT_ICONS = ROOT / "extension" / "icons"
CHROME = os.environ.get("CHROME") or next(
    (p for p in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", shutil.which("google-chrome") or "",
                 shutil.which("chromium") or "", shutil.which("chromium-browser") or ""] if p and Path(p).exists()), None)


def render(svg: Path, size: int, out: Path) -> Image.Image:
    """Rasterise an SVG at size x size with a transparent background."""
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "r.html"
        page.write_text(f'<!doctype html><body style="margin:0;background:transparent"><img src="{svg.as_uri()}" '
                        f'width="{size}" height="{size}" style="display:block">')
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
                        f"--window-size={size},{size}", f"--screenshot={out}", page.as_uri()],
                       check=True, capture_output=True)
    return Image.open(out).convert("RGBA")


def main():
    if not CHROME:
        raise SystemExit("Chrome/Chromium not found; set CHROME=/path/to/chrome")
    big, small = ASSETS / "logo.svg", ASSETS / "logo-small.svg"
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # iOS rounds the corners itself, so its icon is full-bleed and opaque
        square = tmp / "square.svg"
        square.write_text(big.read_text().replace('rx="116"', 'rx="0"'))

        shutil.copyfile(small, WEB / "favicon.svg")                                   # modern browsers: scalable
        ico = render(small, 256, tmp / "s256.png")
        ico.save(WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])           # fallback / Safari
        render(square, 180, tmp / "apple.png").convert("RGB").save(WEB / "apple-touch-icon.png", optimize=True)

        EXT_ICONS.mkdir(parents=True, exist_ok=True)
        for n in (16, 32, 48):                                                        # extension toolbar/list: the bold variant
            render(small, n, EXT_ICONS / f"icon-{n}.png")
        render(big, 128, EXT_ICONS / "icon-128.png")
    for f in [WEB / "favicon.svg", WEB / "favicon.ico", WEB / "apple-touch-icon.png",
              *sorted(EXT_ICONS.glob("*.png"))]:
        print(f"{f.relative_to(ROOT)}  {f.stat().st_size} bytes")


if __name__ == "__main__":
    main()
