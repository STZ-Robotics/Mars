# -*- coding: utf-8 -*-
"""Generates MARS Simulation Studio's icon set from mss.svg.

    python sim/app/icons/make-icons.py

The source is the repository's `public/icons/mss.svg` --- the same mark
mars-desktop puts on the "Simulation Studio" row of its sidebar --- and out of
it come:

    icons/icon.ico          the one tauri-build embeds in the Windows
                            executable; WITHOUT it, `cargo build` fails
    icons/icon.png          512x512, for the Linux/macOS bundle
    icons/32x32.png
    icons/128x128.png
    icons/128x128@2x.png

Why the SVG and not the PNG: the vector is rasterized at each icon's exact
size, so the 16 px .ico comes out sharp instead of being a reduction of a
reduction. The PNG (`public/mss.png`) is still the source of `ui/mss.png`, the
logo the interface shows on the welcome screen, the About page and the loading
screen: that one is seen large and on a dark background, and there the red
version is the one the team already recognizes. A taskbar icon is a different
problem.

Rasterizing an SVG needs an engine. Instead of adding cairosvg --- which on
Windows drags in cairo's DLLs and fails more often than it works --- the
Chrome that is already installed is used, headless, which is exactly what the
app's webview does when painting the same file.

Why it has to crop: the artwork only takes the central part of the canvas. A
32 px icon generated from that leaves the mark at ~24 real pixels and it looks
tiny on the taskbar. It is cropped to the alpha channel's bounding box and
given back a 6 % margin, which is what lets it breathe without wasting the
square.

Run it again when the logo changes. Nothing automatic does it: it is a
dependency on Pillow plus a Chrome, and that is not worth putting in the
build.
"""
import os
import shutil
import subprocess
import sys
import tempfile

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SOURCE = os.path.join(REPO, "public", "icons", "mss.svg")
UI = os.path.abspath(os.path.join(HERE, "..", "ui"))

# The rasterizing canvas. It is not the size of any icon: it is the original
# all of them come from, large so the crop is not short of pixels.
CANVAS = 2048
MARGIN = 0.06
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# Where Chrome usually lives on Windows. `MARS_CHROME` wins over all of this
# in case the browser lives elsewhere or Edge/Chromium is preferred.
CANDIDATES = [
    os.environ.get("MARS_CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_browser():
    for path in CANDIDATES:
        if path and os.path.isfile(path):
            return path
    for name in ("google-chrome", "chromium", "chrome", "msedge"):
        path = shutil.which(name)
        if path:
            return path
    sys.exit(
        "no Chrome/Edge found to rasterize the SVG.\n"
        "Point MARS_CHROME at the executable, for example:\n"
        '  set MARS_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"'
    )


def rasterize(svg, side):
    """The SVG painted by Chrome in a `side` px square, with a transparent
    background."""
    browser = find_browser()
    work = tempfile.mkdtemp(prefix="mss-icon-")
    try:
        shutil.copyfile(svg, os.path.join(work, "mark.svg"))
        # The <img> gets explicit sizes: the SVG carries its own width/height
        # and without this Chrome paints it at that size and not the canvas's.
        with open(os.path.join(work, "mark.html"), "w", encoding="utf-8") as f:
            f.write(
                "<style>html,body{margin:0;padding:0;background:transparent}"
                "img{display:block;width:%dpx;height:%dpx}</style>"
                '<img src="mark.svg">' % (side, side)
            )
        out = os.path.join(work, "mark.png")
        subprocess.run(
            [
                browser,
                "--headless",
                "--disable-gpu",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                # Without this the screenshot's "background" is opaque white and
                # the icon comes out with a white box around it instead of
                # transparency.
                "--default-background-color=00000000",
                "--window-size=%d,%d" % (side, side),
                "--screenshot=%s" % out,
                "file:///%s" % os.path.join(work, "mark.html").replace("\\", "/"),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if not os.path.isfile(out):
            sys.exit("Chrome did not write the screenshot: %s" % out)
        return Image.open(out).convert("RGBA")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def cropped_square(im):
    """Crops to the content and centers it on a square canvas with a margin."""
    box = im.getchannel("A").getbbox()
    if box is None:
        return im
    mark = im.crop(box)
    side = max(mark.size)
    canvas = int(round(side * (1 + 2 * MARGIN)))
    background = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    background.paste(mark, ((canvas - mark.width) // 2, (canvas - mark.height) // 2))
    return background


def main():
    if not os.path.isfile(SOURCE):
        sys.exit("%s is missing" % SOURCE)

    base = cropped_square(rasterize(SOURCE, CANVAS))
    scale = lambda n: base.resize((n, n), Image.LANCZOS)

    scale(512).save(os.path.join(HERE, "icon.png"))
    scale(32).save(os.path.join(HERE, "32x32.png"))
    scale(128).save(os.path.join(HERE, "128x128.png"))
    scale(256).save(os.path.join(HERE, "128x128@2x.png"))

    # The .ico carries ALL the sizes inside: Windows picks the one it needs
    # for the taskbar, the explorer and Alt+Tab. A single-size one looks
    # blurry everywhere else.
    scale(256).save(
        os.path.join(HERE, "icon.ico"),
        format="ICO",
        sizes=[(n, n) for n in ICO_SIZES],
    )

    print("icons written to %s" % HERE)
    for n in sorted(os.listdir(HERE)):
        if n.endswith((".png", ".ico")):
            print("  %-16s %d KB" % (n, os.path.getsize(os.path.join(HERE, n)) // 1024))
    print("ui/mss.png is left alone: the interface's logo comes from public/mss.png")
    print("(see this file's header) and stays as it is.")


if __name__ == "__main__":
    main()
