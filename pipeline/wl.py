"""Small World Labs CLI wrapper: cached uploads, task runs that keep their idempotency key, downloads.

Uses the CLI login on this machine (never handles the key itself).
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

CLI = os.environ.get("WORLDLABS_CLI", "worldlabs")   # the World Labs CLI (npm i -g @worldlabsai/cli), logged in
MIME = {".exr": "image/x-exr", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
ROOT = Path(os.environ.get("PLACE_ROOT") or Path(__file__).resolve().parents[1])   # as in build_place.py
CACHE = ROOT / "work" / "uploads.json"


def cli(*args, timeout=None):
    r = subprocess.run([CLI, "--json", *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def upload(path):
    path = Path(path).resolve()
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    st = path.stat()
    hit = cache.get(str(path))
    if hit and hit["size"] == st.st_size and hit["mtime"] == int(st.st_mtime):
        return hit["id"]
    for attempt in range(4):   # uploads occasionally fail with a transient "fetch failed"
        code, out, err = cli("assets", "upload", str(path), "--mime", MIME[path.suffix.lower()])
        if not code:
            break
        time.sleep(5 * (attempt + 1))
    else:
        sys.exit(f"upload failed for {path}: {err.strip() or out.strip()}")
    cache[str(path)] = dict(id=json.loads(out)["id"], size=st.st_size, mtime=int(st.st_mtime))
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, indent=1))
    return cache[str(path)]["id"]


def run(task, request, workdir, timeout=3600):
    """Submit (or resume, with the saved idempotency key) and wait. Writes request/submission/result json."""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    body = json.dumps(request, indent=1)
    sub_path = workdir / "submission.json"
    sub = json.loads(sub_path.read_text()) if sub_path.exists() else {}
    if sub.get("request") != request:
        sub = {"request": request}
    (workdir / "request.json").write_text(body)
    for attempt in range(3):
        args = ["tasks", "run", task, "--request", str(workdir / "request.json"), "--wait", "--timeout", str(timeout)]
        if sub.get("idempotencyKey"):
            args += ["--idempotency-key", sub["idempotencyKey"]]
        code, out, err = cli(*args, timeout=timeout + 120)
        key = re.search(r"[Ii]dempotency[- ][Kk]ey[^A-Za-z0-9]*([A-Za-z0-9_-]{8,})", err)
        if key:
            sub["idempotencyKey"] = key.group(1)
        sub_path.write_text(json.dumps(sub, indent=1))
        if not code:
            break
        # a task that World Labs itself failed as transient ("upstream dependency temporarily unavailable") is
        # resubmitted after a minute, under a fresh key (the old key would only return the failed operation)
        op = re.search(r"Operation: ([a-f0-9]{16,})", err)
        if op and attempt < 2 and "TRANSIENT_UPSTREAM" in cli("operations", "get", op.group(1))[1]:
            print(f"{task}: transient failure at World Labs (operation {op.group(1)}), retrying in 60 s", file=sys.stderr)
            sub.pop("idempotencyKey", None)
            time.sleep(60)
            continue
        sys.exit(f"{task} failed: {err.strip()[-1500:] or out.strip()[-1500:]}")
    result = json.loads(out)
    (workdir / "result.json").write_text(json.dumps(result, indent=1))
    if result.get("error"):
        sys.exit(f"{task} returned an error: {json.dumps(result['error'])[:1500]}")
    return result


def download(asset_id, out):
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and out.stat().st_size > 0:
        return out
    code, o, err = cli("assets", "download", asset_id, "--out", str(out))
    if code:
        sys.exit(f"download failed for {asset_id}: {err.strip() or o.strip()}")
    return out


def response(result):
    """The task's response body, whichever wrapper the CLI returned."""
    for k in ("response", "result"):
        if isinstance(result.get(k), dict):
            return result[k]
    if isinstance(result.get("operation"), dict):
        return response(result["operation"])
    return result
