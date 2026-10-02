#!/usr/bin/env python3
"""Run a deep-research job from the CLI — same engine as the web UI.

Usage:
    python3 standalone/run.py "your research question" [options]

Options:
    --rounds N     depth hint, 1-8 (default 3)
    --model M      provider:model or profile:provider:model (default: Hermes default)
    --json         print the full result JSON instead of the report
    --out FILE     also write the report (markdown) to FILE
    --quiet        suppress progress lines on stderr

The job runs through the local `hermes` agent (see README, "Research engine"):
progress goes to stderr, the final report goes to stdout. The result is also
saved to HERMES_HOME/plugins/deep-research/<id>.json, so the web UI lists it.
Exit code 0 on success, 1 on error.
"""
import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # repo root
API = ROOT / "dashboard" / "plugin_api.py"


def load_api():
    spec = importlib.util.spec_from_file_location("dr_plugin_api", API)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load plugin API from {API}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    ap = argparse.ArgumentParser(description="Run a deep-research job via Hermes")
    ap.add_argument("query", help="research question")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--model", default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out", default=None)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    api = load_api()
    body = {"query": args.query, "rounds": max(1, min(8, args.rounds))}
    if args.model:
        body["model"] = args.model

    res = api.start_research(body)
    jid = res.get("id")
    if not jid:
        print(f"failed to start: {res}", file=sys.stderr)
        return 1
    print(f"job {jid} started (engine: {res.get('engine')})", file=sys.stderr)

    last = ""
    while True:
        st = api.get_status(jid)
        status = st.get("status")
        step = str(st.get("current_step") or "")
        if not args.quiet and step and step != last:
            print(f"  \u00b7 {step}", file=sys.stderr)
            last = step
        if status in ("completed", "error"):
            break
        time.sleep(4)

    out = api.get_results(jid)
    if status == "error" or out.get("error"):
        print(f"error: {out.get('error')}", file=sys.stderr)
        return 1
    report = out.get("report") or ""
    if args.out:
        Path(args.out).write_text(report)
        print(f"report written: {args.out}", file=sys.stderr)
    if args.json:
        json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    else:
        print(report)
    print(f"done: {len(out.get('sources', []))} sources, id={jid}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
