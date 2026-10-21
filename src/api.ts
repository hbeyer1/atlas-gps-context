import type { Camera } from "./types";

// The local server's API (server/index.ts). Projects are folders on disk; long steps are jobs to poll.
export type Job = {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
  log: string;
};
export type Exif = {
  width: number;
  height: number;
  lat: number | null;
  lon: number | null;
  heading: number | null;
  taken: string | null;
};
export type PlaceConfig = {
  photo: string;
  gps: [number, number];
  heading_deg: number;
  strips_down_deg?: number[];
};
export type Settings = {
  seed: number;
  prompt: string;
  enhancePrompt: boolean;
  returnDepth: boolean;
  contexts: string[];
};
export type Generation = {
  tag: string;
  targets: { kind?: string; camera: Camera }[];
  settings: Settings | null;
  frames: number;
  submitted: boolean;
  cloud: boolean;
  exported: boolean;
};
export type Posed = {
  frames: { image: string; camera: Camera }[];
};
export type Project = {
  id: string;
  config: PlaceConfig;
  editor: Record<string, unknown> & { exif?: Exif; hiddenFrames?: string[] };
  posed: Posed | null;
  terrain: boolean;
  context: { frames: { name: string; camera: Camera }[] } | null;
  registration: boolean;
  generations: Generation[];
  jobs: Job[];
};
export type DryRun = {
  request: unknown;
  contexts: string[];
  targets: number;
  credits: number;
  dollars: number;
  warnings: string[];
  heights: (number | null)[];
};

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

const base64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const p = (id: string) => `/api/projects/${id}`;
export const api = {
  projects: () =>
    call<{ id: string; photo: string; gps: [number, number] }[]>(
      "GET",
      "/api/projects",
    ),
  project: (id: string) => call<Project>("GET", p(id)),
  create: async (name: string, file: File) =>
    call<Project>("POST", "/api/projects", {
      name,
      fileName: file.name,
      base64: await base64(file),
    }),
  saveEditor: (id: string, state: object) =>
    call("PUT", `${p(id)}/editor`, state),
  setConfig: (id: string, patch: Partial<PlaceConfig>) =>
    call<Project>("PUT", `${p(id)}/config`, patch),
  // images2PosedRGBD: spends World Labs credits
  pose: (id: string) => call<Job>("POST", `${p(id)}/pose`, { confirm: true }),
  terrain: (id: string) => call<Job>("POST", `${p(id)}/terrain`),
  scene: (id: string) => call<Job>("POST", `${p(id)}/scene`),
  dryRun: (id: string, tag: string, targets: unknown[], settings: Settings) =>
    call<DryRun>("POST", `${p(id)}/generations`, { tag, targets, settings }),
  // atlasGenerate: spends World Labs credits
  submit: (id: string, tag: string, credits: number) =>
    call<Job>("POST", `${p(id)}/generations/${tag}/submit`, {
      confirm: true,
      credits,
    }),
  cloud: (id: string, tag: string) =>
    call<Job>("POST", `${p(id)}/generations/${tag}/cloud`),
  exportRequest: (id: string, tag: string) =>
    call<Job>("POST", `${p(id)}/generations/${tag}/export`),
  job: (id: string) => call<Job>("GET", `/api/jobs/${id}`),
};

export async function waitForJob(job: Job, onUpdate: (job: Job) => void) {
  while (job.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    job = await api.job(job.id);
    onUpdate(job);
  }
  if (job.status === "failed")
    throw new Error(
      `${job.label} failed:\n${job.log.trim().split("\n").slice(-6).join("\n")}`,
    );
  return job;
}
