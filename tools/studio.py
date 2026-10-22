"""Atlas GPS context's Python side: a few commands the server runs, on top of pipeline/.

Run with PLACE_ROOT pointing at the project folder:

  PLACE_ROOT=projects/<name> .venv/bin/python -I tools/studio.py <command>

  exif <photo>                          GPS point, compass heading, size and time of a photo (JSON)
  import-october <place> [--as <name>] [--gen <tag>]
                                        (the author's own data) copy one place of the October memory-world journey
                                        (../october) into PLACE_ROOT: its places.json entry, photo, aerial tiles, pose,
                                        scene and optionally a generation
  request <place> <tag>                 the atlasGenerate request for work/gen/<place>-<tag>/ (targets.json and
                                        settings.json written by the server), with local files in place of asset ids
                                        -> request-local.json, and a summary with cost and warnings (JSON). Sends nothing.
  submit <place> <tag>                  upload request-local.json's files, run atlasGenerate (spends credits) and
                                        download every frame with its depth and confidence
  download <place> <tag>                fetch whatever is missing of a finished generation (free, from its result.json)

A project folder holds places.json, source/aerial/<place>/, work/pose/<place>/, work/scene/<place>/ and
work/gen/<place>-<tag>/: the layout the pipeline reads and writes.
"""
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
OCTOBER = Path(__file__).resolve().parents[2] / "october"   # the author's October journey, only for import-october
import wl  # noqa: E402
from build_place import ROOT, Terrain  # noqa: E402

CREDITS_PER_VIEW = 50        # what the October generations cost, roughly
MAX_ALTITUDE = 600           # context or targets higher up than this gave noise
MAX_CONTEXT = 15             # 16 context frames gave EXECUTION_FAILED


def exif(photo):
    from PIL import Image
    im = Image.open(photo)
    ex = im.getexif()
    gps = ex.get_ifd(0x8825)
    dms = lambda v: float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
    out = dict(width=im.width, height=im.height, lat=None, lon=None, heading=None,
               taken=ex.get_ifd(0x8769).get(0x9003) or ex.get(0x0132))
    if ex.get(0x0112) in (5, 6, 7, 8):   # rotated a quarter turn on display
        out["width"], out["height"] = im.height, im.width
    if 2 in gps and 4 in gps:
        out["lat"] = dms(gps[2]) * (-1 if gps.get(1) == "S" else 1)
        out["lon"] = dms(gps[4]) * (-1 if gps.get(3) == "W" else 1)
    if 17 in gps:   # GPSImgDirection: the compass direction the camera faced
        out["heading"] = float(gps[17])
    return out


def import_october(place, *options):
    opt = lambda k: options[options.index(k) + 1] if k in options else None
    name, gen_tag = opt("--as") or place, opt("--gen")
    cfg = json.loads((OCTOBER / "places.json").read_text())[place]
    copies = [("source/aerial/" + place + "/" + f) for f in
              ("meta.json", "naip-close.jpg", "naip-wide.jpg", "dem-close.tif", "dem-wide.tif")]
    copies += [cfg["photo"], f"work/pose/{place}", f"work/scene/{place}", f"work/relight/{place}",
               "work/uploads.json"]   # which asset ids its earlier requests used (export_request.py reads it)
    if gen_tag:
        copies.append(f"work/gen/{place}-{gen_tag}")
    for rel in copies:
        src, dst = OCTOBER / rel, ROOT / rel.replace(place, name)
        if not src.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
    cfg["photo"] = cfg["photo"].replace(place, name)
    (ROOT / "places.json").write_text(json.dumps({name: cfg}, indent=1))
    project = ROOT / "project.json"   # the editor's state; keep what is there
    state = json.loads(project.read_text()) if project.exists() else {}
    project.write_text(json.dumps({**state, "exif": exif(ROOT / cfg["photo"])}, indent=1))
    return dict(place=name, copied=copies)


def request(place, tag):
    gen = ROOT / "work" / "gen" / f"{place}-{tag}"
    ctx = json.loads((ROOT / "work" / "scene" / place / "context.json").read_text())
    targets = json.loads((gen / "targets.json").read_text())
    s = json.loads((gen / "settings.json").read_text())
    use = s.get("contexts") or [f["name"] for f in ctx["frames"]]
    d = f"work/scene/{place}/context"
    frames = [{"imageAsset": {"file": f"{d}/{f['name']}.png"},
               "depth": {"depthAsset": {"file": f"{d}/{f['name']}-depth.exr"},
                         "confidenceAsset": {"file": f"{d}/{f['name']}-confidence.png"}},
               "camera": f["camera"]} for f in ctx["frames"] if f["name"] in use]
    req = {"contextFrames": frames, "targetCameras": [t["camera"] for t in targets],
           "modelParameters": {"seed": int(s.get("seed", 42))}, "returnDepth": bool(s.get("returnDepth", True))}
    if s.get("prompt"):
        req["prompt"] = s["prompt"]
    req["enhancePrompt"] = bool(s.get("enhancePrompt", True))
    (gen / "request-local.json").write_text(json.dumps(req, indent=1))

    warnings = []
    T = Terrain(place)
    pos = [t["camera"]["extrinsics"]["position"] for t in targets]
    ground, inside = T.height(np.array([p[0] for p in pos]), np.array([p[2] for p in pos]))
    under = [i + 1 for i, p in enumerate(pos) if inside[i] and p[1] < ground[i] + 0.5]
    if under:
        warnings.append(f"cameras {under} are under the terrain (less than 0.5 m above it)")
    high = [i + 1 for i, p in enumerate(pos) if p[1] - ground[i] > MAX_ALTITUDE]
    if high:
        warnings.append(f"cameras {high} are more than {MAX_ALTITUDE} m up: views that high gave noise")
    if len({tuple(round(v, 3) for v in p) for p in pos}) < 2 and req["returnDepth"]:
        warnings.append("all cameras share one centre: returnDepth fails with HTTP 422 for a pure rotation")
    if len(frames) > MAX_CONTEXT:
        warnings.append(f"{len(frames)} context frames: 16 gave EXECUTION_FAILED before")
    for i, t in enumerate(targets):
        K = t["camera"]["intrinsics"]
        if (K["width"], K["height"], K["cx"], K["cy"]) != (1280, 720, 640, 360):
            warnings.append(f"camera {i + 1} is not 1280x720 with a centred principal point")
            break
    credits = CREDITS_PER_VIEW * len(targets)
    return dict(request=req, contexts=[f["imageAsset"]["file"].split("/")[-1][:-4] for f in frames],
                targets=len(targets), credits=credits, dollars=credits / 1000, warnings=warnings,
                heights=[round(p[1] - float(g), 1) if ok else None for p, g, ok in zip(pos, ground, inside)])


def submit(place, tag):
    gen = ROOT / "work" / "gen" / f"{place}-{tag}"
    local = json.loads((gen / "request-local.json").read_text())

    def uploaded(node):   # {"file": path} -> {"assetId": id}, everywhere in the request
        if isinstance(node, dict):
            if set(node) == {"file"}:
                return {"assetId": wl.upload(ROOT / node["file"])}
            return {k: uploaded(v) for k, v in node.items()}
        return [uploaded(v) for v in node] if isinstance(node, list) else node

    wl.run("atlasGenerate", uploaded(local), gen)
    return download(place, tag)


def download(place, tag):
    """Every frame, depth and confidence of a finished generation (its result.json), retrying transient failures; files
    already here are kept. Free: it only reads what the generation made."""
    gen = ROOT / "work" / "gen" / f"{place}-{tag}"
    resp = wl.response(json.loads((gen / "result.json").read_text()))
    pu = resp.get("promptUsed")
    (gen / "prompt-used.txt").write_text(pu if isinstance(pu, str) else json.dumps(pu, indent=1))
    for i, fr in enumerate(resp["frames"]):
        dep = fr.get("depth") or {}
        for asset, name in ((fr["imageAsset"], f"frame-{i:02d}.png"), (dep.get("depthAsset"), f"frame-{i:02d}-depth.exr"),
                            (dep.get("confidenceAsset"), f"frame-{i:02d}-confidence.png")):
            if not asset or (gen / name).exists():
                continue
            for attempt in range(5):   # downloads occasionally fail with a transient "fetch failed"
                code, out, err = wl.cli("assets", "download", asset["assetId"], "--out", str(gen / name))
                if not code:
                    break
                time.sleep(5 * (attempt + 1))
            else:
                sys.exit(f"download failed for {asset['assetId']} ({name}): {err.strip() or out.strip()}")
    return dict(frames=len(resp["frames"]), dir=str(gen))


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    out = {"exif": exif, "import-october": import_october, "request": request, "submit": submit,
           "download": download}[cmd](*args)
    print(json.dumps(out))
