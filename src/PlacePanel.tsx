import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Check, Loader2, MapPin, Mountain, Plus, Trash2 } from "lucide-react";
import { api, type Job, type Project } from "./api";
import { fileUrl } from "./scene";

// The place: where and which way the photo was taken, its pose, the terrain around it and the context frames built
// from them. Each step runs the October pipeline on the server; only posing spends World Labs credits.
export function PlacePanel({
  project,
  busy,
  runJob,
  onProject,
}: {
  project: Project;
  busy: boolean;
  runJob: (start: () => Promise<Job>) => void;
  onProject: (project: Project) => void;
}) {
  const id = project.id;
  const cfg = project.config;
  const exif = project.editor.exif;
  const [gps, setGps] = useState(cfg.gps);
  const [heading, setHeading] = useState(cfg.heading_deg);
  const [confirmPose, setConfirmPose] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moved =
    gps[0] !== cfg.gps[0] ||
    gps[1] !== cfg.gps[1] ||
    heading !== cfg.heading_deg;
  const posed = Boolean(project.posed);
  const scene = Boolean(project.context);

  async function save() {
    try {
      onProject(await api.setConfig(id, { gps, heading_deg: heading }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const step =
    "flex items-center justify-between gap-3 border-t border-black/10 py-3";
  const button =
    "flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-black/10 px-2.5 text-xs font-medium text-neutral-800 transition hover:bg-black/5 disabled:opacity-35";
  const done = <Check className="h-4 w-4 text-emerald-600" />;

  return (
    <div className="text-xs text-neutral-700">
      <div className="flex items-start gap-3 pb-3">
        <img
          src={fileUrl(id, cfg.photo)}
          alt=""
          className="h-24 w-20 shrink-0 rounded-md object-cover"
        />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-neutral-900">{id}</h2>
          <p className="mt-0.5 text-neutral-500">
            {exif?.taken ?? "no capture time in EXIF"}
          </p>
          <p className="mt-1 text-neutral-500">
            {exif?.lat == null
              ? "No GPS in EXIF: place it on the map."
              : "GPS from EXIF."}{" "}
            {exif?.heading == null
              ? "No compass heading in EXIF: set it below."
              : `Heading ${exif.heading.toFixed(0)}° from EXIF.`}
          </p>
        </div>
      </div>

      <PlaceMap gps={gps} heading={heading} onMove={setGps} />
      <div className="mt-2 grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
          Latitude
          <input
            className="h-8 rounded-md border border-black/10 px-2 text-neutral-900"
            type="number"
            step="0.00001"
            value={gps[0]}
            onChange={(e) => setGps([Number(e.target.value), gps[1]])}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
          Longitude
          <input
            className="h-8 rounded-md border border-black/10 px-2 text-neutral-900"
            type="number"
            step="0.00001"
            value={gps[1]}
            onChange={(e) => setGps([gps[0], Number(e.target.value)])}
          />
        </label>
        <label
          className="flex flex-col gap-1 text-[11px] text-neutral-500"
          title="Compass direction the photo looks, degrees from north"
        >
          Heading °
          <input
            className="h-8 rounded-md border border-black/10 px-2 text-neutral-900"
            type="number"
            step="1"
            value={heading}
            onChange={(e) => setHeading(Number(e.target.value))}
          />
        </label>
      </div>
      {moved && (
        <button
          type="button"
          className={`${button} mt-2 w-full justify-center`}
          onClick={() => void save()}
        >
          Save point and heading
          {gps[0] !== cfg.gps[0] || gps[1] !== cfg.gps[1]
            ? " (the terrain is fetched again)"
            : ""}
        </button>
      )}

      <div className={`${step} mt-3`}>
        <div>
          <p className="font-semibold text-neutral-900">1 · Pose the photo</p>
          <p className="text-neutral-500">
            World Labs images2PosedRGBD: camera + depth. Spends credits; cached
            once done.
          </p>
        </div>
        {posed ? (
          done
        ) : confirmPose ? (
          <div className="flex gap-1">
            <button
              type="button"
              className={`${button} border-amber-300 bg-amber-50 text-amber-900`}
              disabled={busy}
              onClick={() => {
                setConfirmPose(false);
                runJob(() => api.pose(id));
              }}
            >
              Spend credits
            </button>
            <button
              type="button"
              className={button}
              onClick={() => setConfirmPose(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => setConfirmPose(true)}
          >
            Pose…
          </button>
        )}
      </div>

      <div className={step}>
        <div>
          <p className="font-semibold text-neutral-900">2 · Map depth data</p>
          <p className="text-neutral-500">
            USGS 3DEP elevation + NAIP imagery, 600 m and 4 km around the point
            (US only, free).
          </p>
        </div>
        {project.terrain ? (
          done
        ) : (
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => runJob(() => api.terrain(id))}
          >
            <Mountain className="h-3.5 w-3.5" />
            Fetch
          </button>
        )}
      </div>

      {project.posed && <Strips project={project} onProject={onProject} />}

      <div className={step}>
        <div>
          <p className="font-semibold text-neutral-900">3 · Context frames</p>
          <p className="text-neutral-500">
            The photo strips placed on the terrain (heading, ground plane, eye
            at 1.5 m) and aerial renders at 520 and 600 m. Free.
          </p>
        </div>
        <button
          type="button"
          className={button}
          disabled={busy || !posed || !project.terrain || moved}
          onClick={() => runJob(() => api.scene(id))}
        >
          {scene ? "Rebuild" : "Build"}
        </button>
      </div>

      {project.registration && (
        <div className="border-t border-black/10 pt-3">
          <p className="font-semibold text-neutral-900">Registration check</p>
          <p className="mb-2 text-neutral-500">
            Left: the photo. Right: the same view rendered from the aerial and
            terrain. If they do not line up, change the heading, save, and
            rebuild.
          </p>
          <img
            src={`${fileUrl(id, `work/scene/${id}/check-registration.jpg`)}?v=${project.context?.frames[0]?.camera.extrinsics.quaternion.join(",")}`}
            alt="The photo next to the terrain render from the same camera"
            className="w-full rounded-md border border-black/10"
          />
          <div className="mt-2 flex items-center gap-1">
            {[-5, -1, 1, 5].map((d) => (
              <button
                key={d}
                type="button"
                className={button}
                onClick={() => setHeading((h) => (h + d + 360) % 360)}
              >
                {d > 0 ? `+${d}` : d}°
              </button>
            ))}
            <span className="ml-auto tabular-nums text-neutral-500">
              heading {heading}°
            </span>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

// A small map of the point, on USGS imagery, with the heading drawn from it. Drag the marker to move the point.
function PlaceMap({
  gps,
  heading,
  onMove,
}: {
  gps: [number, number];
  heading: number;
  onMove: (gps: [number, number]) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<{ map: L.Map; marker: L.Marker; line: L.Polyline } | null>(
    null,
  );
  const move = useRef(onMove);
  move.current = onMove;

  useEffect(() => {
    if (!element.current) return;
    const m = L.map(element.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView(gps, 17);
    L.tileLayer(
      "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
      {
        maxNativeZoom: 16,
        maxZoom: 19,
        attribution: "USGS The National Map",
      },
    ).addTo(m);
    const marker = L.marker(gps, {
      draggable: true,
      icon: L.divIcon({
        className: "",
        html: '<div class="place-marker"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    }).addTo(m);
    marker.on("dragend", () => {
      const { lat, lng } = marker.getLatLng();
      move.current([Number(lat.toFixed(6)), Number(lng.toFixed(6))]);
    });
    const line = L.polyline([gps, gps], { color: "#f4b860", weight: 3 }).addTo(
      m,
    );
    map.current = { map: m, marker, line };
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const current = map.current;
    if (!current) return;
    current.marker.setLatLng(gps);
    // 120 m along the heading
    const rad = (heading * Math.PI) / 180;
    const dLat = (120 * Math.cos(rad)) / 111320;
    const dLon =
      (120 * Math.sin(rad)) / (111320 * Math.cos((gps[0] * Math.PI) / 180));
    current.line.setLatLngs([gps, [gps[0] + dLat, gps[1] + dLon]]);
  }, [gps, heading]);

  return (
    <div
      ref={element}
      className="h-48 w-full overflow-hidden rounded-md border border-black/10"
    />
  );
}

// The 16:9 strips cut from a portrait photo: the middle band, plus strips tilted down (or up) so that the ground,
// people and cars at the bottom stay in a context frame (build_place.py: to_generated_grid and reframe).
function Strips({
  project,
  onProject,
}: {
  project: Project;
  onProject: (project: Project) => void;
}) {
  const frame = project.posed!.frames[0]!;
  const K = frame.camera.intrinsics;
  const f = (K.fx * 1280) / K.width; // the middle strip's focal length on the 1280 x 720 grid
  const auto =
    (Math.atan((K.height - K.cy) / K.fy) - Math.atan(360 / f)) *
    (180 / Math.PI);
  const saved = project.config.strips_down_deg;
  const [strips, setStrips] = useState<number[]>(
    saved ?? (auto > 3 ? [Number(auto.toFixed(1))] : []),
  );
  const changed =
    JSON.stringify(strips) !==
    JSON.stringify(saved ?? (auto > 3 ? [Number(auto.toFixed(1))] : []));
  const scale = 240 / K.height;

  // A strip's outline on the photo: the border of a 1280 x 720 camera tilted down by `deg`, projected into it.
  const outline = (deg: number) => {
    const th = (-deg * Math.PI) / 180;
    const border: [number, number][] = [];
    for (let i = 0; i <= 8; i++) border.push([(1280 * i) / 8, 0]);
    for (let i = 0; i <= 8; i++) border.push([1280, (720 * i) / 8]);
    for (let i = 8; i >= 0; i--) border.push([(1280 * i) / 8, 720]);
    for (let i = 8; i >= 0; i--) border.push([0, (720 * i) / 8]);
    return border
      .map(([u, v]) => {
        const x = (u - 640) / f,
          y = -(v - 360) / f,
          z = -1;
        const yo = Math.cos(th) * y - Math.sin(th) * z,
          zo = -(Math.sin(th) * y + Math.cos(th) * z);
        return `${((x / zo) * K.fx + K.cx) * scale},${((-yo / zo) * K.fy + K.cy) * scale}`;
      })
      .join(" ");
  };

  return (
    <div className="border-t border-black/10 py-3">
      <p className="font-semibold text-neutral-900">Photo strips (16:9)</p>
      <p className="mb-2 text-neutral-500">
        World Labs needs 1280 × 720 context frames. Blue: the middle strip.
        Amber: strips tilted down, so the bottom of the photo is kept.
      </p>
      <div className="flex gap-3">
        <svg
          width={K.width * scale}
          height={240}
          className="shrink-0 rounded-md border border-black/10"
        >
          <image
            href={fileUrl(project.id, `work/pose/${project.id}/${frame.image}`)}
            width={K.width * scale}
            height={240}
          />
          <polygon
            points={outline(0)}
            fill="rgba(91,95,199,0.12)"
            stroke="#5b5fc7"
            strokeWidth={1.5}
          />
          {strips.map((deg, i) => (
            <polygon
              key={i}
              points={outline(deg)}
              fill="rgba(232,163,61,0.12)"
              stroke="#e8a33d"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          ))}
        </svg>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-neutral-500">Middle · always</span>
          {strips.map((deg, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="number"
                step="0.5"
                value={deg}
                onChange={(e) =>
                  setStrips(
                    strips.map((s, j) =>
                      j === i ? Number(e.target.value) : s,
                    ),
                  )
                }
                className="h-7 w-16 rounded-md border border-black/10 px-1.5 text-neutral-900"
              />
              <span className="text-neutral-500">° down</span>
              <button
                type="button"
                aria-label="Remove strip"
                className="ml-auto grid h-7 w-7 place-items-center rounded-md hover:bg-black/5"
                onClick={() => setStrips(strips.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="flex h-7 items-center gap-1 rounded-md px-1.5 text-neutral-600 hover:bg-black/5"
            onClick={() => setStrips([...strips, Number(auto.toFixed(1))])}
          >
            <Plus className="h-3.5 w-3.5" /> Strip
          </button>
          {changed && (
            <button
              type="button"
              className="flex h-7 items-center justify-center rounded-md bg-neutral-900 px-2 font-medium text-white"
              onClick={() =>
                void api
                  .setConfig(project.id, { strips_down_deg: strips })
                  .then(onProject)
              }
            >
              Save strips (then rebuild)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function JobStatus({ job }: { job: Job | null }) {
  if (!job) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-600">
      {job.status === "running" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <MapPin className="h-3.5 w-3.5" />
      )}
      <span className="font-medium">{job.label}</span>
      <span className="max-w-[32rem] truncate text-neutral-400">
        {job.log.trim().split("\n").at(-1)}
      </span>
    </div>
  );
}
