import { useEffect, useMemo, useRef, useState } from "react";
import {
  Film,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Plus,
} from "lucide-react";
import { api, waitForJob, type Job, type Project } from "./api";
import {
  fileUrl,
  loadClouds,
  loadScene,
  type Cloud,
  type Scene,
} from "./scene";
import {
  CameraWorkspace,
  type EditorState,
  type Mode,
  type Take,
} from "./trajectory/Editor";
import type { PinholeCamera } from "./trajectory/common";
import { JobStatus, PlacePanel } from "./PlacePanel";
import { RequestDialog } from "./RequestDialog";
import "./styles.css";

const REPO = "https://github.com/worldlabsai/atlas-camera-studio";

export default function App() {
  const [projectId, setProjectId] = useState(() =>
    new URLSearchParams(location.search).get("project"),
  );
  const [project, setProject] = useState<Project | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [mode, setMode] = useState<Mode>("frame");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [takeClouds, setTakeClouds] = useState<Cloud[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [saving, setSaving] = useState("");
  const [request, setRequest] = useState<{
    targets: PinholeCamera[];
    what: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  function open(id: string | null) {
    history.replaceState(null, "", id ? `?project=${id}` : location.pathname);
    setProjectId(id);
  }

  // The project's files and state on disk; the scene (context frames as dots) once it is built.
  useEffect(() => {
    setProject(null);
    setScene(null);
    setTakeClouds([]);
    if (!projectId) return;
    api.project(projectId).then(
      (p) => {
        setProject(p);
        setHidden(new Set(p.editor.hiddenFrames ?? []));
        if (!p.context) setMode("place");
      },
      (e) => setError(e.message),
    );
  }, [projectId]);
  const contextKey = JSON.stringify(project?.context);
  useEffect(() => {
    if (!project?.context) return;
    const controller = new AbortController();
    setScene(null);
    loadScene(project.id, project.context, controller.signal).then(
      setScene,
      (e) => {
        if (!controller.signal.aborted) setError(e.message);
      },
    );
    return () => controller.abort();
  }, [project?.id, contextKey]);

  function save(state: object) {
    if (!project) return;
    setSaving("Saving…");
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(
      () =>
        void api.saveEditor(project.id, state).then(
          () => setSaving("Saved to project"),
          (e) => setSaving(e.message),
        ),
      600,
    );
  }

  // One long step at a time (pose, terrain, scene, generation): followed in the top bar, then the project reloads.
  function runJob(start: () => Promise<Job>) {
    setError(null);
    start()
      .then((started) => {
        setJob(started);
        return waitForJob(started, setJob);
      })
      .then(
        () => project && api.project(project.id).then(setProject),
        (e) => setError(e.message),
      );
  }

  const takes = useMemo<Take[]>(
    () =>
      (project?.generations ?? [])
        .filter((g) => g.frames > 0)
        .map((g) => ({
          tag: g.tag,
          frames: g.targets.slice(0, g.frames).map((t, i) => ({
            image: fileUrl(
              project!.id,
              `work/gen/${project!.id}-${g.tag}/frame-${String(i).padStart(2, "0")}.png`,
            ),
            camera: t.camera,
            label: `${g.tag} ${i + 1}: ${t.kind ?? "view"}`,
          })),
          cloud: g.cloud
            ? fileUrl(project!.id, `work/gen/${project!.id}-${g.tag}/cloud.ply`)
            : null,
        })),
    [project],
  );

  // A take's generated views with the depth World Labs returned, as dots next to the context (to check they agree).
  async function showTakeDots(tag: string | null) {
    const take = takes.find((t) => t.tag === tag);
    if (!take) return setTakeClouds([]);
    const frames = take.frames.map((f, i) => ({
      name: `${take.tag}-${i}`,
      camera: f.camera,
      image: f.image,
      depth: f.image.replace(".png", "-depth.exr"),
      confidence: f.image.replace(".png", "-confidence.png"),
    }));
    try {
      setTakeClouds(await loadClouds(frames, new AbortController().signal));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const shownScene = useMemo(
    () =>
      scene && takeClouds.length
        ? { ...scene, clouds: [...scene.clouds, ...takeClouds] }
        : scene,
    [scene, takeClouds],
  );
  const placePanel = project && (
    <PlacePanel
      project={project}
      busy={job?.status === "running"}
      runJob={runJob}
      onProject={setProject}
    />
  );

  const rail = (
    m: Mode,
    label: string,
    Icon: typeof Film,
    disabled = false,
  ) => (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={mode === m}
      onClick={() => setMode(m)}
      className={`flex w-14 flex-col items-center gap-1 rounded-lg py-2 text-[10px] font-medium transition disabled:opacity-30 ${mode === m ? "bg-black/[0.06] text-neutral-900" : "text-neutral-500 hover:bg-black/5 hover:text-neutral-900"}`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );

  return (
    <div className="flex h-dvh bg-[#fafaf9] text-neutral-900">
      <nav className="flex w-12 shrink-0 flex-col items-center gap-3 border-r border-black/10 py-3">
        <span
          className="grid h-8 w-8 place-items-center text-base font-bold"
          aria-hidden
        >
          ◢
        </span>
        <button
          type="button"
          title="Projects"
          onClick={() => open(null)}
          className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-black/5 hover:text-neutral-900"
        >
          <FolderOpen className="h-4 w-4" />
        </button>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/10 px-4 text-sm">
          <button
            type="button"
            onClick={() => open(null)}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-black/5"
          >
            <FolderOpen className="h-4 w-4 text-neutral-500" />
            {project?.id ?? "Projects"}
          </button>
          <span className="text-neutral-300">/</span>
          <span className="font-medium">Atlas GPS context</span>
          {project && (
            <>
              <span className="text-neutral-300">/</span>
              <span className="text-neutral-600">
                {mode === "place"
                  ? "Place"
                  : mode === "frame"
                    ? "Frames"
                    : "Video path"}
              </span>
            </>
          )}
          <span className="ml-2 text-xs text-neutral-400">{saving}</span>
          <div className="ml-auto flex items-center gap-4">
            <JobStatus job={job} />
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-neutral-500 hover:text-neutral-900"
            >
              Based on Atlas Camera Studio
            </a>
          </div>
        </header>
        {error && (
          <div className="flex items-start justify-between gap-4 border-b border-red-200 bg-red-50 px-4 py-2 text-xs whitespace-pre-wrap text-red-700">
            {error}
            <button type="button" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {!projectId ? (
              <Projects onOpen={open} />
            ) : !project ? (
              <Loading text="Loading project…" />
            ) : !project.context ? (
              <div className="h-full overflow-y-auto p-6">
                <div className="mx-auto max-w-md rounded-xl border border-black/10 bg-white p-4 shadow-sm">
                  {placePanel}
                </div>
              </div>
            ) : !shownScene ? (
              <Loading text="Loading the context frames as dots…" />
            ) : (
              <CameraWorkspace
                key={project.id}
                projectId={project.id}
                scene={shownScene}
                mode={mode}
                saved={project.editor as Partial<EditorState>}
                hiddenFrames={hidden}
                onToggleFrame={(name) => {
                  const next = new Set(hidden);
                  if (!next.delete(name)) next.add(name);
                  setHidden(next);
                  save({ hiddenFrames: [...next] });
                }}
                takes={takes}
                onShowTakeDots={(tag) => void showTakeDots(tag)}
                onTakeStep={(tag, step) =>
                  runJob(() =>
                    step === "cloud"
                      ? api.cloud(project.id, tag)
                      : api.exportRequest(project.id, tag),
                  )
                }
                onChange={save}
                onRender={(targets, what) => setRequest({ targets, what })}
                placePanel={placePanel}
              />
            )}
          </div>
          {project && (
            <aside className="flex w-[4.5rem] shrink-0 flex-col items-center gap-1 border-l border-black/10 py-3">
              {rail("place", "Place", MapPin)}
              {rail("frame", "Frame", ImageIcon, !project.context)}
              {rail("video", "Video", Film, !project.context)}
            </aside>
          )}
        </div>
      </div>

      {request && project && scene && (
        <RequestDialog
          project={project}
          targets={request.targets}
          what={request.what}
          contexts={scene.frames
            .map((f) => f.name)
            .filter((n) => !hidden.has(n))}
          onClose={() => setRequest(null)}
          runJob={runJob}
        />
      )}
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div className="grid h-full place-items-center text-sm text-neutral-500">
      <span className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {text}
      </span>
    </div>
  );
}

// Projects are folders in projects/; a new one starts from a photo (its GPS point and heading come from EXIF).
function Projects({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<
    { id: string; photo: string; gps: [number, number] }[]
  >([]);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(
    () => void api.projects().then(setProjects, (e) => setError(e.message)),
    [],
  );

  async function create() {
    if (!file || !name) return;
    setBusy(true);
    try {
      onOpen((await api.create(name, file)).id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <h1 className="text-lg font-semibold">Projects</h1>
      <p className="mt-1 text-sm text-neutral-500">
        A photo, the map's depth around where it was taken, and the cameras you
        plan through both. Each project is a folder in atlas-studio/projects/.
      </p>
      <div className="mt-6 flex flex-wrap gap-4">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpen(p.id)}
            className="w-48 overflow-hidden rounded-xl border border-black/10 bg-white text-left shadow-sm transition hover:border-black/30"
          >
            <img
              src={fileUrl(p.id, p.photo)}
              alt=""
              className="h-36 w-full object-cover"
            />
            <div className="p-2.5 text-sm font-medium">
              {p.id}
              <div className="text-xs font-normal text-neutral-500">
                {p.gps[0].toFixed(5)}, {p.gps[1].toFixed(5)}
              </div>
            </div>
          </button>
        ))}
        <div className="flex w-64 flex-col gap-2 rounded-xl border border-dashed border-black/20 bg-white p-3 text-sm">
          <span className="flex items-center gap-1.5 font-medium">
            <Plus className="h-4 w-4" /> New from a photo
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-xs"
          />
          <input
            placeholder="Name, e.g. twin-peaks"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 rounded-md border border-black/10 px-2 text-sm"
          />
          <button
            type="button"
            disabled={!file || !name || busy}
            onClick={() => void create()}
            className="h-8 rounded-md bg-[#5b5fc7] text-sm font-semibold text-white disabled:opacity-35"
          >
            {busy ? "Reading the photo…" : "Create"}
          </button>
          {error && <p className="text-xs text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
