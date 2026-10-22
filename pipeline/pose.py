"""Pose photos with World Labs images2PosedRGBD (camera + depth + confidence per photo).

  python3 pose.py <place> <photo> [<photo> ...] [--res W H]   -> work/pose/<place>/
Photos of one place taken together are posed jointly (one request).
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import wl

args = sys.argv[1:]
res = None
if "--res" in args:
    i = args.index("--res"); res = [int(args[i + 1]), int(args[i + 2])]; del args[i:i + 3]
place, photos = args[0], [Path(p) for p in args[1:]]
out = wl.ROOT / "work" / "pose" / place
request = {"frames": [{"imageAsset": {"assetId": wl.upload(p)}} for p in photos], "refinePoses": len(photos) > 1}
if res:
    request["targetResolution"] = res
result = wl.run("images2PosedRGBD", request, out)
resp = wl.response(result)
frames = []
for p, f in zip(photos, resp["frames"]):
    stem = p.stem
    rec = {"photo": str(p), "camera": f["camera"]}
    rec["image"] = str(wl.download(f["imageAsset"]["assetId"], out / f"{stem}.png").name)
    if f.get("depth"):
        rec["depth"] = str(wl.download(f["depth"]["depthAsset"]["assetId"], out / f"{stem}-depth.exr").name)
        if f["depth"].get("confidenceAsset"):
            rec["confidence"] = str(wl.download(f["depth"]["confidenceAsset"]["assetId"], out / f"{stem}-confidence.png").name)
    frames.append(rec)
(out / "posed.json").write_text(json.dumps({"place": place, "frames": frames, "poseRefinementAccepted": resp.get("poseRefinementAccepted")}, indent=1))
print(json.dumps(frames, indent=1))
