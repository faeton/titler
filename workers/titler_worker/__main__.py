"""python -m titler_worker --role analyze|asr|align|enhance

Long-lived model worker speaking the JSON-lines protocol in docs/worker-protocol.md.
"""
from __future__ import annotations

import argparse
import importlib
import sys

ROLES = ("analyze", "asr", "align", "enhance")


def main():
    ap = argparse.ArgumentParser(prog="titler_worker")
    ap.add_argument("--role", required=True, choices=ROLES)
    ap.add_argument("--preload", action="store_true",
                    help="load the role's default models before printing ready")
    a = ap.parse_args()

    from . import common  # noqa: F401  (env defaults before any heavy import)
    from .protocol import Channel, log, serve

    chan = Channel()  # from here on stdout is protocol-only
    try:
        mod = importlib.import_module(f".{a.role}", __package__)
    except Exception as e:  # report and exit: the server sees a non-ready worker
        chan.send({"ready": False, "role": a.role, "error": f"{type(e).__name__}: {e}"})
        raise
    if a.preload and hasattr(mod, "preload"):
        log(f"[{a.role}] preloading")
        mod.preload()
    serve(a.role, mod.OPS, mod.loaded_models, chan)


if __name__ == "__main__":
    sys.exit(main())
