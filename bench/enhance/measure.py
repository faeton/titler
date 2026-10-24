#!/usr/bin/env python3
"""Run a command, record wall time and peak child RSS into a JSON file.
usage: measure.py OUT.json AUDIO_SECONDS -- cmd args...
"""
import json, resource, subprocess, sys, time
out, audio_s = sys.argv[1], float(sys.argv[2])
cmd = sys.argv[sys.argv.index("--") + 1:]
t = time.perf_counter()
r = subprocess.run(cmd)
wall = time.perf_counter() - t
rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
json.dump({"wall_s": wall, "audio_s": audio_s, "rtf": wall / audio_s, "load_s": None,
           "peak_rss_mb": rss, "rc": r.returncode, "cmd": cmd}, open(out, "w"), indent=1)
sys.exit(r.returncode)
