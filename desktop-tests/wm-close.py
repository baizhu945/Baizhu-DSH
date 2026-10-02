#!/usr/bin/env python3
"""Send genuine WM_DELETE_WINDOW ClientMessages to explicitly supplied test windows."""
import ctypes as C
import os
import sys

x = C.CDLL(os.environ["DSH_TEST_X11_LIBRARY"])
x.XOpenDisplay.argtypes = [C.c_char_p]
x.XOpenDisplay.restype = C.c_void_p
x.XInternAtom.argtypes = [C.c_void_p, C.c_char_p, C.c_int]
x.XInternAtom.restype = C.c_ulong
x.XSendEvent.argtypes = [C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.c_void_p]
x.XFlush.argtypes = [C.c_void_p]
x.XCloseDisplay.argtypes = [C.c_void_p]

class Data(C.Union):
    _fields_ = [("b", C.c_char * 20), ("s", C.c_short * 10), ("l", C.c_long * 5)]

class ClientMessage(C.Structure):
    _fields_ = [("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int),
                ("display", C.c_void_p), ("window", C.c_ulong), ("message_type", C.c_ulong),
                ("format", C.c_int), ("data", Data)]

class Event(C.Union):
    _fields_ = [("client", ClientMessage), ("pad", C.c_long * 24)]

if not os.environ.get("DSH_DESKTOP_TEST_XVFB"):
    raise SystemExit("refusing to send window-close messages outside the isolated Xvfb harness")
display = x.XOpenDisplay(None)
if not display:
    raise SystemExit("cannot open test X display")
try:
    for window in sys.argv[1:]:
        event = Event()
        event.client.type = 33
        event.client.display = display
        event.client.window = int(window, 0)
        event.client.message_type = x.XInternAtom(display, b"WM_PROTOCOLS", 0)
        event.client.format = 32
        event.client.data.l[0] = x.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
        if not x.XSendEvent(display, event.client.window, 0, 0, C.byref(event)):
            raise SystemExit("WM_DELETE_WINDOW send failed")
    x.XFlush(display)
finally:
    x.XCloseDisplay(display)
