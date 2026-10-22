"""Bundle what was sent to World Labs for one generation into a self-contained folder, to inspect, edit or resubmit
by hand (CLI or the API playground).

  python export_request.py <place> <gen tag>      e.g. export_request.py big-sur joint2
  -> export/<place>-<tag>/
       context/<name>.png, <name>-depth.exr, <name>-confidence.png   the posed context frames, as uploaded
       context.json        each context frame's camera
       targets.json        the cameras World Labs generated views for (kind, heading, and the camera)
       prompt.txt          the prompt sent;  prompt-used.txt  World Labs' expanded version of it
       request.json        the exact request (asset ids of the uploads on this World Labs account)
       request-local.json  the same request with local file paths in place of asset ids
       results/            what came back (views, depth, confidence, contact sheet)
       README.md           how to resubmit
"""
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_place import ROOT  # noqa: E402

README = """# {place} · {tag}: the World Labs request, by hand

One `atlasGenerate` request ({n_ctx} context frames in, {n_tgt} views out, ~{credits} credits).

## What is here
- `context/`: the posed RGBD frames World Labs got as input: each image with its depth (EXR, metres, planar
  depth along the camera's view axis, NaN where there is no surface) and confidence (PNG, 0 = ignore).
  {ctx_list}
- `context.json`: their cameras. `targets.json`: the cameras of the views to generate.
- Cameras: `coordinateSystem: "rub"` (x right, y up, z back), position in metres, quaternion `[x, y, z, w]`,
  pinhole intrinsics on a 1280x720 grid with a centred principal point (World Labs requires 1280x720 targets).
- Place-local frame: x east, y up, z south; the photo was taken at (0, 1.5, 0), 1.5 m above the ground at the spot.
- `prompt.txt` was sent with `enhancePrompt: true`; `prompt-used.txt` is what World Labs made of it.
- `results/`: what came back.

## Resubmit with the CLI
The asset ids in `request.json` belong to this World Labs account, so it can be sent again as it is (a new
generation, ~{credits} credits):

```sh
worldlabs tasks run atlasGenerate --request request.json --wait --json > result.json
```

To change something (a different photo crop, other cameras, another prompt), edit `request-local.json`, upload
each file that changed and put its id in place of the path:

```sh
worldlabs assets upload context/photo.png --json          # -> {{"id": "asset_..."}}
```

Then run the same `tasks run` command on the edited request. Download a result with
`worldlabs assets download <asset-id> --out view.png`.
"""


def main():
    place, tag = sys.argv[1], sys.argv[2]
    gen = ROOT / "work" / "gen" / f"{place}-{tag}"
    scene = ROOT / "work" / "scene" / place
    out = ROOT / "export" / f"{place}-{tag}"
    (out / "context").mkdir(parents=True, exist_ok=True)
    (out / "results").mkdir(exist_ok=True)
    request = json.loads((gen / "request.json").read_text())
    uploads = json.loads((ROOT / "work" / "uploads.json").read_text())
    by_id = {v["id"]: Path(k) for k, v in uploads.items()}
    local = json.loads(json.dumps(request))
    ctx_names, ctx_cams = [], []
    for f_req, f_loc in zip(request["contextFrames"], local["contextFrames"]):
        for key, holder_req, holder_loc in (("image", f_req["imageAsset"], f_loc["imageAsset"]),
                                            ("depth", f_req["depth"]["depthAsset"], f_loc["depth"]["depthAsset"]),
                                            ("confidence", f_req["depth"]["confidenceAsset"], f_loc["depth"]["confidenceAsset"])):
            src = by_id.get(holder_req["assetId"])
            if src is None or not src.exists():
                sys.exit(f"cannot find the local file for {holder_req['assetId']} ({key}); was it re-uploaded since?")
            shutil.copy(src, out / "context" / src.name)
            holder_loc.pop("assetId", None)
            holder_loc["file"] = f"context/{src.name}"
            if key == "image":
                ctx_names.append(src.stem)
                ctx_cams.append(dict(name=src.stem, camera=f_req["camera"]))
    (out / "request.json").write_text(json.dumps(request, indent=1))
    (out / "request-local.json").write_text(json.dumps(local, indent=1))
    (out / "context.json").write_text(json.dumps(ctx_cams, indent=1))
    shutil.copy(gen / "targets.json", out / "targets.json")
    (out / "prompt.txt").write_text(request.get("prompt") or "")
    if (gen / "prompt-used.txt").exists():
        shutil.copy(gen / "prompt-used.txt", out / "prompt-used.txt")
    for f in sorted(gen.iterdir()):
        if f.is_file() and (f.name.startswith("frame-") or f.name in ("sheet.jpg", "result.json")):
            shutil.copy(f, out / "results" / f.name)
    n_tgt = len(request["targetCameras"])
    (out / "README.md").write_text(README.format(place=place, tag=tag, n_ctx=len(ctx_names), n_tgt=n_tgt, credits=50 * n_tgt,
                                                 ctx_list=", ".join(f"`{n}`" for n in ctx_names)))
    print(f"{out}: {len(ctx_names)} context frames ({', '.join(ctx_names)}), {n_tgt} targets")


if __name__ == "__main__":
    main()
