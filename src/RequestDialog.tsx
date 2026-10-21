import { useState } from "react";
import { Copy, Loader2, Sparkles, X } from "lucide-react";
import { api, type DryRun, type Job, type Project, type Settings } from "./api";
import type { PinholeCamera } from "./trajectory/common";

// One atlasGenerate request: every context frame in use plus the cameras you planned. First a dry run (the exact
// request, with local files where the asset ids will go, and its cost); it is sent only when you confirm the cost.
export function RequestDialog({
  project,
  targets,
  what,
  contexts,
  onClose,
  runJob,
}: {
  project: Project;
  targets: PinholeCamera[];
  what: string;
  contexts: string[];
  onClose: () => void;
  runJob: (start: () => Promise<Job>) => void;
}) {
  const last = project.generations.at(-1)?.settings;
  const [tag, setTag] = useState(
    () =>
      `take-${project.generations.filter((g) => g.tag.startsWith("take-")).length + 1}`,
  );
  const [settings, setSettings] = useState<Settings>({
    seed: last?.seed ?? 42,
    prompt: last?.prompt ?? "",
    enhancePrompt: last?.enhancePrompt ?? true,
    returnDepth: true,
    contexts,
  });
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function review() {
    setWorking(true);
    setError(null);
    setConfirmed(false);
    try {
      setDryRun(
        await api.dryRun(
          project.id,
          tag,
          targets.map((camera, i) => ({ kind: "path", index: i, camera })),
          { ...settings, contexts },
        ),
      );
    } catch (e) {
      setDryRun(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  const change = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch });
    setDryRun(null);
  };
  const field = "h-8 rounded-md border border-black/10 px-2 text-neutral-900";

  return (
    <div
      role="dialog"
      aria-label="atlasGenerate request"
      className="fixed inset-0 z-[100] grid place-items-center bg-black/30 p-6"
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white text-xs text-neutral-700 shadow-2xl">
        <header className="flex items-center gap-2 border-b border-black/10 px-4 py-3">
          <span className="font-mono text-neutral-400">{"</>"}</span>
          <h2 className="text-sm font-semibold text-neutral-900">
            atlasGenerate · {what}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="ml-auto grid h-8 w-8 place-items-center rounded-md hover:bg-black/5"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-black/10 px-4 py-3">
          <label className="col-span-3 flex flex-col gap-1 text-[11px] text-neutral-500">
            Prompt (optional; with none, World Labs captions the context frames)
            <textarea
              value={settings.prompt}
              onChange={(e) => change({ prompt: e.target.value })}
              rows={2}
              placeholder="Leave empty unless needed. Words like “camera” or “circle” get drawn into the views."
              className="rounded-md border border-black/10 px-2 py-1.5 text-neutral-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
            Take name
            <input
              className={field}
              value={tag}
              onChange={(e) => {
                setTag(
                  e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
                );
                setDryRun(null);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
            Seed
            <input
              className={`${field} w-24`}
              type="number"
              value={settings.seed}
              onChange={(e) => change({ seed: Number(e.target.value) })}
            />
          </label>
          <div className="flex flex-col justify-end gap-1.5 text-[11px]">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={settings.enhancePrompt}
                onChange={(e) => change({ enhancePrompt: e.target.checked })}
              />
              Enhance prompt
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={settings.returnDepth}
                onChange={(e) => change({ returnDepth: e.target.checked })}
              />
              Return depth
            </label>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!dryRun ? (
            <p className="text-neutral-500">
              {targets.length} target cameras, {contexts.length} context frames
              ({contexts.join(", ")}). Review the request to see exactly what
              would be sent and what it costs. Nothing is sent to World Labs
              until you confirm.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <span className="text-2xl font-semibold tabular-nums text-neutral-900">
                  ~{dryRun.credits.toLocaleString()} credits
                </span>
                <span className="text-neutral-500">
                  ≈ ${dryRun.dollars.toFixed(2)} · {dryRun.targets} views × ~50
                  credits · 1,000 credits = $1
                </span>
              </div>
              {dryRun.warnings.map((w) => (
                <p
                  key={w}
                  className="mb-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-amber-900"
                >
                  {w}
                </p>
              ))}
              <p className="mb-1.5 text-neutral-500">
                Height of each camera above the terrain (m):{" "}
                {dryRun.heights.map((h) => (h == null ? "?" : h)).join(", ")}
              </p>
              <div className="relative">
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      JSON.stringify(dryRun.request, null, 1),
                    )
                  }
                  className="absolute right-2 top-2 flex h-7 items-center gap-1 rounded-md border border-black/10 bg-white px-2 hover:bg-black/5"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy
                </button>
                <pre className="max-h-80 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-[11px] leading-4 text-neutral-800">
                  {JSON.stringify(dryRun.request, null, 1)}
                </pre>
              </div>
              <p className="mt-1.5 text-neutral-500">
                “file” entries are uploaded on submit and replaced by their
                asset ids. Saved as work/gen/{project.id}-{tag}
                /request-local.json.
              </p>
            </>
          )}
          {error && (
            <p className="mt-2 whitespace-pre-wrap rounded-md bg-red-50 px-2 py-1.5 text-red-700">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-black/10 px-4 py-3">
          <button
            type="button"
            disabled={working || !tag}
            onClick={() => void review()}
            className="flex h-9 items-center gap-2 rounded-lg border border-black/10 px-3 font-medium text-neutral-800 hover:bg-black/5 disabled:opacity-40"
          >
            {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {dryRun ? "Review again" : "Review request (dry run)"}
          </button>
          {dryRun && (
            <label className="flex items-center gap-1.5 text-neutral-800">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Spend ~{dryRun.credits.toLocaleString()} World Labs credits
            </label>
          )}
          <button
            type="button"
            disabled={!dryRun || !confirmed}
            onClick={() => {
              runJob(() => api.submit(project.id, tag, dryRun!.credits));
              onClose();
            }}
            className="ml-auto flex h-9 items-center gap-2 rounded-lg bg-[#5b5fc7] px-4 font-semibold text-white hover:bg-[#4a4eb3] disabled:opacity-35"
          >
            <Sparkles className="h-4 w-4" />
            Generate
          </button>
        </footer>
      </div>
    </div>
  );
}
