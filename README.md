# Atlas GPS context

Generate World Labs Atlas views from a photo **and the real landscape around where it was taken**. The photo's GPS
point pulls in USGS elevation and aerial imagery, which become extra context frames next to the photo, so the views
beyond the photo stay true to the real terrain, roads and coastline. You plan the cameras over the photo and the
terrain together, and everything goes out in one `atlasGenerate` request.

Based on [Atlas Camera Studio](https://github.com/worldlabsai/atlas-camera-studio) by World Labs (MIT licence), whose
editor, drawing tools and trajectory math come from the original camera-trajectory app by
[Gowthami Somepalli (@somepago)](https://github.com/somepago). The layout follows World Labs' Atlas Preview page.

## How it works

1. **Place**: upload a photo. Its GPS point (and compass heading, if the phone wrote one) come from EXIF; correct
   both on a small USGS imagery map. Pose the photo with `images2PosedRGBD` (spends credits once; the result is
   cached), fetch USGS elevation and imagery around the point (imagery 0.6–1 m, elevation 1–2 m), and pick the 16:9
   strips of a portrait photo (the middle one, plus strips tilted down so the ground and people at the bottom stay
   in). The photo is placed in a local metric frame on the terrain (ground plane, heading, eye at 1.5 m, far depth
   traced against the terrain), and aerial context frames are rendered straight down over the terrain from 520–600 m
   (higher contexts gave noise). A registration check shows the photo next to the same view rendered from the
   terrain, so you can correct the heading.
2. **Frame / Video**: every context frame is shown as dots (the photo strips and the terrain). Add a camera where
   you are looking from (**Add frame**), add ready-made parts (a **descent** from 450 m onto the photo's view, an
   eye-level **circle**, a **walk** around the spot), and draw, aim, smooth and reshape paths. Click any context
   frame, camera or generated frame to look through it. Video mode samples the path into frames (default 48, 4 s at
   12 fps); Frame mode asks for one view per camera.
3. **Generate**: the API view shows the exact request (the context frames in use and the target cameras, 1280 × 720
   with a centred principal point, a fixed seed, an optional prompt, `returnDepth: true`), its cost (~50 credits per
   view) and warnings (cameras under the terrain, more than 600 m up, too many context frames, pure rotation).
   Nothing is sent until you confirm the cost. The views come back with depth and confidence, are shown along the
   path (also as dots), are fused into a dot cloud (`cloud.ply`), and the request is exported as a package you can
   resubmit by hand.

An aerial view can also be moved off the photo spot, e.g. to bring a nearby coast into the context: in a project's
`places.json`, `"aerial-coast": [1600, 600, -680, 590]` is 1.6 km of ground seen from 600 m, centred 680 m west and
590 m south of the spot.

## Setup

You need Node 22.12+, Python 3.10+, `curl`, and the [World Labs CLI](https://atlas-beta.worldlabs.ai/docs/quickstart)
logged in to an account with API access. The app never handles an API key: the Python steps use the CLI login.

```sh
npm ci
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm i -g @worldlabsai/cli && worldlabs auth login
npm start            # builds, then serves http://127.0.0.1:8790
```

The server uses `.venv/bin/python` (or `PYTHON=...`) and `worldlabs` on the PATH (or `WORLDLABS_CLI=...`). For
development, run `npm run dev` and `npx vite` side by side (Vite proxies `/api` and `/files` to port 8790).

## Layout

- `server/index.ts`: a small Express server. It keeps each project as a plain folder in `projects/` (git-ignored) and
  runs the Python steps on it. Posing and generating refuse to run without an explicit confirmation.
- `pipeline/`: the Python steps (USGS fetch, pose, placing the photo and rendering the aerial context, fusing dots,
  exporting a request); see [pipeline/README.md](pipeline/README.md).
- `tools/studio.py`: EXIF, the dry-run request (with a terrain check), the submit, and fetching results.
- `src/`: the editor. `scene.ts` loads every context frame as its own point cloud; `trajectory/` is Camera Studio's
  editor (paths, aiming, smoothing, undo) adapted to the terrain and a ~1 km scene.

A project folder holds `places.json` (GPS point, heading, photo strips, aerial views), `project.json` (the camera
path and settings), `source/` (photo, USGS tiles), `work/pose/`, `work/scene/` (the context frames),
`work/gen/<place>-<take>/` (requests and results) and `export/`.

## Data and credits

- Elevation: [USGS 3DEP](https://www.usgs.gov/3d-elevation-program); imagery: [USGS NAIP](https://naip-usdaonline.hub.arcgis.com/),
  both public domain, US only. Map tiles: USGS The National Map.
- World Labs API usage is billed to your account: `images2PosedRGBD` when posing, `atlasGenerate` (~50 credits per
  generated view) when generating.

## License

MIT, see [LICENSE](LICENSE) (World Labs' copyright notice is kept).
