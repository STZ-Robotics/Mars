#!/usr/bin/env python3
"""A window's own pixels on X11 with a compositor (XComposite), so whatever
overlaps it on screen does not matter, and how many colors its page has
(1: blank).

    python3 harness/xgrab.py <window id, 0x...> <out.png>
"""
import ctypes as C, sys
from PIL import Image
X = C.CDLL("libX11.so.6"); XC = C.CDLL("libXcomposite.so.1")
X.XOpenDisplay.restype = C.c_void_p; X.XGetImage.restype = C.c_void_p
X.XQueryTree.argtypes = [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.c_void_p), C.POINTER(C.c_uint)]
X.XGetWindowAttributes.argtypes = [C.c_void_p, C.c_ulong, C.c_void_p]
X.XGetImage.argtypes = [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_ulong, C.c_int]
XC.XCompositeNameWindowPixmap.restype = C.c_ulong; XC.XCompositeNameWindowPixmap.argtypes = [C.c_void_p, C.c_ulong]
dpy = X.XOpenDisplay(None)
w = C.c_ulong(int(sys.argv[1], 16))
root, parent, kids, n = C.c_ulong(), C.c_ulong(), C.c_void_p(), C.c_uint()
# Up to the top-level window: the one the compositor redirects.
while True:
    X.XQueryTree(dpy, w, C.byref(root), C.byref(parent), C.byref(kids), C.byref(n))
    if parent.value == root.value: break
    w = C.c_ulong(parent.value)
class Attr(C.Structure):
    _fields_ = [("x", C.c_int), ("y", C.c_int), ("width", C.c_int), ("height", C.c_int), ("bw", C.c_int), ("depth", C.c_int), ("pad", C.c_byte * 200)]
class XImage(C.Structure):
    _fields_ = [("width", C.c_int), ("height", C.c_int), ("xoffset", C.c_int), ("format", C.c_int), ("data", C.c_void_p), ("byte_order", C.c_int),
                ("bitmap_unit", C.c_int), ("bitmap_bit_order", C.c_int), ("bitmap_pad", C.c_int), ("depth", C.c_int), ("bytes_per_line", C.c_int), ("bits_per_pixel", C.c_int)]
a = Attr(); X.XGetWindowAttributes(dpy, w, C.byref(a))
img = XImage.from_address(X.XGetImage(dpy, XC.XCompositeNameWindowPixmap(dpy, w), 0, 0, a.width, a.height, 0xFFFFFFFF, 2))
im = Image.frombytes("RGBX", (img.width, img.height), C.string_at(img.data, img.bytes_per_line * img.height), "raw", "BGRX", img.bytes_per_line).convert("RGB")
im.save(sys.argv[2])
print(sys.argv[2], f"{img.width}x{img.height}", "page colors:", len(set(im.crop((20, 80, im.width - 20, im.height - 20)).resize((80, 50)).getdata())))
