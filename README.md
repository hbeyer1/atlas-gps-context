# Atlas map studio

Plan World Labs Atlas cameras over a photo **and the real terrain around where it was taken**, then generate them in
one `atlasGenerate` request.

Based on [Atlas Camera Studio](https://github.com/worldlabsai/atlas-camera-studio) by World Labs (MIT), whose editor,
drawing tools and trajectory math come from the original camera-trajectory app by
[Gowthami Somepalli (@somepago)](https://github.com/somepago). This fork keeps the upstream history. The layout follows
World Labs' Atlas Preview (viewgen) page: the 3D view, a Spatial Context strip, Add frame, Frame and Video modes, and
an API view of the request.

## What it does

1. **Place**: upload a photo. Its GPS point (and compass heading, if the phone wrote one) come from EXIF; correct
   both on a small USGS imagery map. Pose the photo with `images2PosedRGBD` (spends credits; cached, never re-run),
   fetch USGS elevation and imagery around the point at full detail (imagery 0.6–1 m, elevation 1–2 m), and pick the 16:9 strips of a portrait photo (the middle one,
   plus strips tilted down so the ground and people at the bottom stay in). The photo is then placed in a local
   metric frame on the terrain (ground plane, heading, eye at 1.5 m, far depth traced against the terrain), with
   aerial context frames rendered over the terrain at 520 and 600 m. A registration check shows the photo next to
   the same view rendered from the terrain, so you can correct the heading.
2. **Frame / Video**: all context frames are shown as one point cloud (the photo strips and the terrain). Add a
   camera where you are looking from (**Add frame**), add ready-made parts (a **descent** from 450 m onto the photo's
   view, an eye-level **circle**, a **walk** around the spot), and draw, aim, smooth and reshape paths with Camera
   Studio's tools. Click any context frame, camera or generated frame to look through it. Video mode samples the
   path into frames (default 48, 4 s at 12 fps); Frame mode asks for one view per camera.
3. **Generate**: the API view shows the exact request (all context frames in use and the target cameras, 1280 × 720
   with a centred principal point, a fixed seed, an optional prompt, `returnDepth: true`), its cost (~50 credits per
   view; 1,000 credits = $1) and warnings (cameras under the terrain, more than 600 m up, too many context frames,
   pure rotation). Nothing is sent until you tick the cost and press Generate. The frames come back with depth and
   confidence, are shown along the path (also as dots), are fused into a dot cloud (`cloud.ply`), and the request is
   exported as a package you can resubmit by hand.

Projects are plain folders in `projects/` (git-ignored), laid out like the October pipeline's folder: `places.json`
(the place: GPS point, heading, strips), `project.json` (the editor: camera path and settings), `source/aerial/`,
`work/pose/`, `work/scene/`, `work/gen/<place>-<take>/`, `export/`.

## Run it

You need Node 22.12+, the shared Python env at `../.venv` (torch, opencv, numpy) and the World Labs CLI logged in
(`worldlabs auth login`). The app never handles an API key: the Python tools use the CLI login.

```sh
npm ci
npm start            # builds, then serves http://127.0.0.1:8790
```

For development, run `npm run dev` and `npx vite` side by side (Vite proxies `/api` and `/files` to port 8790).

To bring in a place from the October journey without spending credits (the Big Sur project was made this way):

```sh
cd ../october && PLACE_ROOT=../atlas-studio/projects/big-sur ../.venv/bin/python -I ../atlas-studio/tools/studio.py import-october big-sur --gen joint2
```

`big-sur-coast` is the same place imported `--as big-sur-coast`, with one more aerial context frame so the coast and
the sea are in the scene: in its `places.json`, `"aerial-coast": [1600, 600, -680, 590]` (1.6 km wide, 600 m up,
centred 680 m west and 590 m south of the spot; an aerial view's optional third and fourth values move its centre).
Then **Rebuild** the context frames.

## How it fits together

- `server/index.ts`: a small Express server. It keeps projects on disk and runs the Python steps from the `october`
  folder with `PLACE_ROOT=<project>`, so `../october/tools` (pose, fetch_aerial, build_place, place_cloud,
  export_request) work on a project unchanged. Pose and generate refuse to run without an explicit confirmation.
- `tools/studio.py`: EXIF, the October import, the dry-run request (with a terrain check) and the submit, on top of
  `october/tools/wl.py` (uploads, runs, downloads with retry).
- `src/`: the editor. `scene.ts` loads every context frame as its own point cloud; `trajectory/` is Camera Studio's
  editor (paths, aiming, smoothing, undo) adapted to the terrain and a ~1 km scene.

## Data sources and credits

- Elevation: [USGS 3DEP](https://www.usgs.gov/3d-elevation-program); imagery: [USGS NAIP](https://naip-usdaonline.hub.arcgis.com/),
  both public domain, US only. Map tiles: USGS The National Map.
- World Labs API usage is billed to your account: `images2PosedRGBD` when posing, `atlasGenerate` (~50 credits per
  generated view) when generating.

## License

MIT, see [LICENSE](LICENSE) (World Labs' copyright notice is kept).
