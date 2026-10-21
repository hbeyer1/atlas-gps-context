// Atlas map studio's local server. It serves the editor, keeps each project as a plain folder on disk (laid out like
// ../october, so the October tools work on it), and runs the Python pipeline for everything that touches World Labs
// or the map data. It never sees a World Labs key: the Python tools use the CLI login (october/tools/wl.py).
import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const PORT = Number(process.env.PORT || 8790);
const STUDIO = resolve(import.meta.dirname, "..");
const MEMORY_WORLDS = resolve(STUDIO, "..");
const OCTOBER = join(MEMORY_WORLDS, "october");
const PYTHON = join(MEMORY_WORLDS, ".venv", "bin", "python");
const PROJECTS = resolve(process.env.PROJECTS_DIR || join(STUDIO, "projects"));
const CREDITS_PER_VIEW = 50;
mkdirSync(PROJECTS, { recursive: true });

// ---------------------------------------------------------------- Python
type Job = {
  id: string;
  project: string;
  label: string;
  status: "running" | "done" | "failed";
  log: string;
  result?: unknown;
};
const jobs = new Map<string, Job>();
const tool = (name: string) => join(OCTOBER, "tools", name);
const studioTool = join(STUDIO, "tools", "studio.py");

// One Python command, run the way the October pipeline is run: from the october folder, with the shared env.
function runPython(project: string, args: string[], log: (s: string) => void) {
  return new Promise<string>((done, fail) => {
    const child = spawn(PYTHON, ["-I", ...args], {
      cwd: OCTOBER,
      env: {
        ...process.env,
        PLACE_ROOT: projectDir(project),
        OPENCV_IO_ENABLE_OPENEXR: "1",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      log(String(d));
    });
    child.stderr.on("data", (d) => log(String(d)));
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done(out)
        : fail(new Error(`${args[0].split("/").pop()} exited with ${code}`)),
    );
  });
}

// The last line a studio.py command prints is its JSON result.
const lastJson = (out: string) => JSON.parse(out.trim().split("\n").at(-1)!);

// Long steps run as jobs the editor polls.
function startJob(project: string, label: string, steps: string[][]) {
  const job: Job = {
    id: randomUUID(),
    project,
    label,
    status: "running",
    log: "",
  };
  jobs.set(job.id, job);
  (async () => {
    for (const args of steps) {
      job.log += `$ ${args.map((a) => a.replace(MEMORY_WORLDS + "/", "")).join(" ")}\n`;
      await runPython(project, args, (s) => (job.log += s));
    }
  })().then(
    () => (job.status = "done"),
    (error) => {
      job.status = "failed";
      job.log += `\n${error.message}\n`;
    },
  );
  return job;
}

// ---------------------------------------------------------------- projects on disk
function projectDir(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(id))
    throw new Error("Bad project name");
  return join(PROJECTS, id);
}
const readJson = (path: string, fallback: any = null) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1));
}
const placeConfig = (id: string) =>
  readJson(join(projectDir(id), "places.json"), {})[id];
const setPlaceConfig = (id: string, cfg: unknown) =>
  writeJson(join(projectDir(id), "places.json"), { [id]: cfg });
const genDir = (id: string, tag: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(tag)) throw new Error("Bad take name");
  return join(projectDir(id), "work", "gen", `${id}-${tag}`);
};

function generations(id: string) {
  const dir = join(projectDir(id), "work", "gen");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(id + "-"))
    .map((name) => {
      const gen = join(dir, name);
      const frames = readdirSync(gen).filter((f) => /^frame-\d+\.png$/.test(f));
      return {
        tag: name.slice(id.length + 1),
        targets: readJson(join(gen, "targets.json"), []),
        settings: readJson(join(gen, "settings.json")),
        frames: frames.length,
        submitted: existsSync(join(gen, "result.json")),
        cloud: existsSync(join(gen, "cloud.ply")),
        exported: existsSync(join(projectDir(id), "export", name)),
      };
    });
}

function projectState(id: string) {
  const dir = projectDir(id);
  const cfg = placeConfig(id);
  const scene = join(dir, "work", "scene", id);
  return {
    id,
    config: cfg,
    editor: readJson(join(dir, "project.json"), {}),
    posed: readJson(join(dir, "work", "pose", id, "posed.json")),
    terrain: existsSync(join(dir, "source", "aerial", id, "meta.json")),
    context: readJson(join(scene, "context.json")),
    registration: existsSync(join(scene, "check-registration.jpg")),
    generations: generations(id),
    jobs: [...jobs.values()].filter((j) => j.project === id),
  };
}

// What a new place needs in places.json (the October tools read it); values as for Big Sur.
const newPlaceConfig = (
  photo: string,
  lat: number,
  lon: number,
  heading: number,
) => ({
  photo,
  gps: [lat, lon],
  heading_deg: heading,
  heading_from: "atlas-studio",
  camera_height_m: 1.5,
  ground_region: [1.0, 1.0, 0.75],
  aerial_views: { "aerial-mid": [900, 600], "aerial-close": [450, 520] },
  target_hfov: 75,
  approach: {
    frames: 10,
    start_alt_m: 450,
    start_pitch_deg: -70,
    pitch_curve: 1.4,
    min_glide_deg: 15,
    start_side_m: 0,
  },
});

// ---------------------------------------------------------------- http
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "60mb" }));
const route =
  (handler: (req: express.Request) => unknown) =>
  async (req: express.Request, res: express.Response) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      res
        .status(400)
        .json({
          error: error instanceof Error ? error.message : String(error),
        });
    }
  };

app.get(
  "/api/projects",
  route(() =>
    readdirSync(PROJECTS)
      .filter((id) => existsSync(join(PROJECTS, id, "places.json")))
      .map((id) => ({
        id,
        photo: placeConfig(id)?.photo,
        gps: placeConfig(id)?.gps,
      })),
  ),
);

// A new project from a photo: save it, read its GPS point and heading from EXIF.
app.post(
  "/api/projects",
  route(async (req) => {
    const { name, fileName, base64 } = req.body;
    const id = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const dir = projectDir(id);
    if (existsSync(dir))
      throw new Error(`A project called ${id} exists already.`);
    const photo = `source/photos/${id}${extname(String(fileName)).toLowerCase() || ".jpg"}`;
    mkdirSync(join(dir, "source", "photos"), { recursive: true });
    writeFileSync(join(dir, photo), Buffer.from(base64, "base64"));
    const exif = lastJson(
      await runPython(id, [studioTool, "exif", join(dir, photo)], () => {}),
    );
    setPlaceConfig(
      id,
      newPlaceConfig(photo, exif.lat ?? 0, exif.lon ?? 0, exif.heading ?? 0),
    );
    writeJson(join(dir, "project.json"), { exif });
    return projectState(id);
  }),
);

app.get(
  "/api/projects/:id",
  route((req) => projectState(String(req.params.id))),
);

// The editor's own state (camera path, output settings): project.json.
app.put(
  "/api/projects/:id/editor",
  route((req) => {
    const file = join(projectDir(String(req.params.id)), "project.json");
    writeJson(file, { ...readJson(file, {}), ...req.body });
    return { saved: true };
  }),
);

// GPS point, heading and photo strips (places.json). A moved point makes the fetched terrain stale.
app.put(
  "/api/projects/:id/config",
  route((req) => {
    const id = String(req.params.id);
    const cfg = placeConfig(id);
    const { gps, heading_deg, strips_down_deg } = req.body;
    if (gps && (gps[0] !== cfg.gps[0] || gps[1] !== cfg.gps[1]))
      rmSync(join(projectDir(id), "source", "aerial", id), {
        recursive: true,
        force: true,
      });
    setPlaceConfig(id, {
      ...cfg,
      ...(gps && { gps }),
      ...(heading_deg !== undefined && { heading_deg }),
      ...(strips_down_deg !== undefined && { strips_down_deg }),
    });
    return projectState(id);
  }),
);

// images2PosedRGBD spends World Labs credits: only on an explicit confirmation, and never again once cached.
app.post(
  "/api/projects/:id/pose",
  route((req) => {
    const id = String(req.params.id);
    if (req.body?.confirm !== true)
      throw new Error("Posing spends World Labs credits; confirm it first.");
    if (existsSync(join(projectDir(id), "work", "pose", id, "posed.json")))
      throw new Error(
        "This photo is posed already; the cached pose (work/pose) is used.",
      );
    const { width = 3, height = 4 } =
      readJson(join(projectDir(id), "project.json"), {}).exif ?? {};
    const res =
      height > width
        ? ["768", "1024"]
        : width / height > 1.7
          ? ["1280", "720"]
          : ["1024", "768"];
    return startJob(id, "Pose the photo (images2PosedRGBD)", [
      [
        tool("pose.py"),
        id,
        join(projectDir(id), placeConfig(id).photo),
        "--res",
        ...res,
      ],
    ]);
  }),
);

// USGS 3DEP elevation and NAIP imagery around the point (free, US only).
app.post(
  "/api/projects/:id/terrain",
  route((req) => {
    const id = String(req.params.id);
    const [lat, lon] = placeConfig(id).gps;
    return startJob(id, "Fetch USGS terrain and imagery", [
      [
        tool("fetch_aerial.py"),
        join(projectDir(id), "source", "aerial"),
        "--place",
        id,
        String(lat),
        String(lon),
      ],
    ]);
  }),
);

// Place the photo in the local frame and render the aerial context frames (free).
app.post(
  "/api/projects/:id/scene",
  route((req) => {
    const id = String(req.params.id);
    return startJob(id, "Build the context frames", [
      [tool("build_place.py"), id],
    ]);
  }),
);

// The dry run: write the path's cameras and settings and build the request with local files. Sends nothing.
app.post(
  "/api/projects/:id/generations",
  route(async (req) => {
    const id = String(req.params.id);
    const { tag, targets, settings } = req.body;
    const gen = genDir(id, String(tag));
    if (existsSync(join(gen, "result.json")))
      throw new Error(`Take ${tag} was generated already; name a new one.`);
    writeJson(join(gen, "targets.json"), targets);
    writeJson(join(gen, "settings.json"), settings);
    return lastJson(
      await runPython(id, [studioTool, "request", id, tag], () => {}),
    );
  }),
);

// atlasGenerate spends credits: only after a dry run and an explicit confirmation of its cost. Then the frames are
// fused into a dot cloud and the request is exported as a package.
const cloudStep = (id: string, tag: string) => [
  tool("place_cloud.py"),
  id,
  "--tag",
  tag,
  "--radius",
  "800",
  "--max-depth",
  "2000",
  "--out",
  join(genDir(id, tag), "cloud.ply"),
];
app.post(
  "/api/projects/:id/generations/:tag/submit",
  route((req) => {
    const id = String(req.params.id);
    const tag = String(req.params.tag);
    const gen = genDir(id, tag);
    const local = readJson(join(gen, "request-local.json"));
    if (!local) throw new Error("Review the request (dry run) first.");
    const credits = CREDITS_PER_VIEW * local.targetCameras.length;
    if (req.body?.confirm !== true || req.body?.credits !== credits)
      throw new Error(
        `Generating spends ~${credits} credits; confirm that amount first.`,
      );
    if (existsSync(join(gen, "result.json")))
      throw new Error(`Take ${tag} was generated already.`);
    return startJob(id, `Generate ${tag} (atlasGenerate)`, [
      [studioTool, "submit", id, tag],
      cloudStep(id, tag),
      [tool("export_request.py"), id, tag],
    ]);
  }),
);

// Fuse or export a generated take again (free).
app.post(
  "/api/projects/:id/generations/:tag/cloud",
  route((req) => {
    const id = String(req.params.id);
    const tag = String(req.params.tag);
    return startJob(id, `Dot cloud for ${tag}`, [cloudStep(id, tag)]);
  }),
);
app.post(
  "/api/projects/:id/generations/:tag/export",
  route((req) => {
    const id = String(req.params.id);
    const tag = String(req.params.tag);
    return startJob(id, `Export ${tag}`, [
      [tool("export_request.py"), id, tag],
    ]);
  }),
);

app.get(
  "/api/jobs/:id",
  route((req) => {
    const job = jobs.get(String(req.params.id));
    if (!job) throw new Error("No such job");
    return job;
  }),
);

// The projects' files (photos, context frames, generated views), read by the editor.
app.use("/files", express.static(PROJECTS, { dotfiles: "deny" }));
app.use(express.static(join(STUDIO, "dist"), { index: false }));
app.get("/{*path}", (_req, res) =>
  res.sendFile(join(STUDIO, "dist", "index.html")),
);

app.listen(PORT, "127.0.0.1", () =>
  console.log(
    `Atlas map studio on http://127.0.0.1:${PORT} (projects in ${PROJECTS})`,
  ),
);
