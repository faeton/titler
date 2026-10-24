#!/usr/bin/env python3
"""Minimal /usr/bin/time replacement: timeit.py OUTFILE cmd... -> writes 'wall user sys maxrss_kb'."""
import os, resource, subprocess, sys, time
out = sys.argv[1]; t0 = time.monotonic()
rc = subprocess.call(sys.argv[2:])
w = time.monotonic() - t0
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
open(out, "w").write(f"{w:.2f} {ru.ru_utime:.2f} {ru.ru_stime:.2f} {ru.ru_maxrss}\n")
sys.exit(rc)
