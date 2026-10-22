# pipeline/

The Python steps the server runs, copied from the author's October memory-world pipeline (where they were first
written) with three changes: the World Labs CLI is `worldlabs` on the PATH (or `WORLDLABS_CLI`), `write_splats` lives in
`splats.py`, and `fetch_aerial.py` fetches one point only.

| file | step |
|---|---|
| `fetch_aerial.py` | USGS NAIP imagery + 3DEP elevation around a GPS point (free, US only) |
| `pose.py` | World Labs `images2PosedRGBD`: the photo's camera, depth and confidence (spends credits) |
| `build_place.py` | places the photo in a local metric frame (ground plane, heading, eye at 1.5 m, far depth traced against the terrain) and renders the aerial context frames over the terrain |
| `place_cloud.py` (+ `bubble.py`, `splats.py`) | fuses a generation's frames and depth with the photo into one dot cloud (.ply) |
| `export_request.py` | bundles a generation's request, inputs and results into a folder you can resubmit by hand |
| `wl.py` | uploads, task runs (keeping their idempotency key) and downloads through the logged-in CLI |

Each reads and writes a project folder given by `PLACE_ROOT` (`places.json`, `source/aerial/<place>/`,
`work/pose/<place>/`, `work/scene/<place>/`, `work/gen/<place>-<take>/`, `export/`).
