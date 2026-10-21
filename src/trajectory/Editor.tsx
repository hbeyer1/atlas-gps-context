import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ChevronDown,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Map as MapIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  Redo2,
  Rotate3D,
  Sparkles,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  createIntrinsicsFromFov,
  verticalFov,
  type PinholeCamera,
} from "./common";
import * as THREE from "three";
import {
  CameraPointCloudView,
  CameraTrajectoryCanvas,
  frameBox,
} from "./Canvas";
import {
  cameraAimDegrees,
  cameraDrawingView,
  cameraQuaternionFromAim,
  cameraTargetIsClearOfPath,
  cameraViewLookingAt,
  cameraViewsFromSegments,
  buildTargetCameras,
  deleteTrajectoryPivot,
  frameTrajectorySpaceAboveFloor,
  insertTrajectoryPivot,
  materializeTrajectorySmoothing,
  smoothTrajectorySegments,
  moveTrajectoryPoint,
  normalizeClosedTrajectorySegments,
  partLookAtTargetIsClearOfPath,
  projectTrajectoryPoint,
  reshapeTrajectorySegments,
  sampleCameraPivot,
  setTrajectoryPointDirectionOverride,
  setTrajectoryPointQuaternion,
  TRAJECTORY_FLOOR_Y,
  TRAJECTORY_SMOOTHING_VERSION,
  trajectoryPathFromSegments,
  trajectoryPivotsFromSegments,
  trajectoryFloorBoundary,
  appendDrawnTrajectory,
  type CameraDirectionMode,
  type CameraView,
  type DrawPoint,
  type TrajectoryDrawingView,
  type TrajectoryPoint,
  type TrajectoryPivot,
  type TrajectoryQuaternion,
  type TrajectorySegment,
  type TrajectoryShape,
  type TrajectorySpace,
} from "./camera-trajectory";
import { useEditHistory } from "./use-edit-history";
import type { Frame, Scene } from "../scene";

type CameraTrajectoryAspectRatio = "16:9" | "9:16";

const DEFAULT_FRAME_COUNT = 48;
const DEFAULT_FPS = 12;
const DEFAULT_DIRECTION_MODE: CameraDirectionMode = "manual";
const DEFAULT_HFOV_DEGREES = 75; // the October pipeline's target_hfov
const MIN_FRAME_COUNT = 2;
const MAX_FRAME_COUNT = 96;
const MIN_TARGET_FOV_DEGREES = 5;
const MAX_TARGET_FOV_DEGREES = 140;
const WIDTH = 1280;
const HEIGHT = 720;
// The draw pad's width in metres: a walk around the spot, a circle above it, the whole descent.
const PAD_WIDTHS = [10, 40, 150, 600, 1500];
const DRAWING_PANEL_SIZES = [
  { label: "Small", widthClass: "w-80" },
  { label: "Medium", widthClass: "w-[26rem]" },
  { label: "Large", widthClass: "w-[34rem]" },
  { label: "Full", widthClass: "w-[44rem]" },
] as const;
const CAMERA_DIRECTION_PRESETS: readonly {
  mode: CameraDirectionMode;
  label: string;
  title: string;
}[] = [
  {
    mode: "manual",
    label: "My angles",
    title: "Use the camera directions you set below",
  },
  {
    mode: "forward",
    label: "Forward",
    title: "Face along the flight path",
  },
  {
    mode: "look_at",
    label: "Look at point",
    title: "Point every camera at one spot you choose in the scene",
  },
  {
    mode: "look_away",
    label: "Look away",
    title: "Point every camera away from one spot you choose in the scene",
  },
];
const DEFAULT_DRAWING_PANEL_SIZE_INDEX = 1;
type PointDirectionMode = "look_at" | "look_away";

function isPointDirectionMode(
  mode: CameraDirectionMode,
): mode is PointDirectionMode {
  return mode === "look_at" || mode === "look_away";
}

type SelectedPivot = {
  segmentId: string;
  pointIndex: number;
  pivotNumber: number;
};

const hfovToVfov = (degrees: number) =>
  THREE.MathUtils.radToDeg(
    2 *
      Math.atan(
        (Math.tan(THREE.MathUtils.degToRad(degrees) / 2) * HEIGHT) / WIDTH,
      ),
  );
const vfovToHfov = (degrees: number) =>
  THREE.MathUtils.radToDeg(
    2 *
      Math.atan(
        (Math.tan(THREE.MathUtils.degToRad(degrees) / 2) * WIDTH) / HEIGHT,
      ),
  );

// What project.json keeps of the editor.
export type EditorState = {
  segments: TrajectorySegment[];
  trajectorySmoothingVersion: number;
  directionMode: CameraDirectionMode;
  directionTarget: TrajectoryPoint | null;
  closedLoop: boolean;
  allowBelowFloor: boolean;
  targetFovDegrees: number;
  frameCount: number;
  fps: number;
};

export type Mode = "place" | "frame" | "video";
export type Take = {
  tag: string;
  frames: { image: string; camera: PinholeCamera; label: string }[];
  /** The fused dot cloud (place_cloud.py), once made. */
  cloud: string | null;
};
type ViewFrom = { label: string; view: CameraView; image?: string };

// Ready-made parts, in the spirit of the October pipeline: a descent onto the photo spot, a circle at eye level
// around what the photo looks at, a walk around the spot. Each point carries its camera's direction.
type PresetKind = "descent" | "circle" | "walk";
function presetPart(kind: PresetKind, scene: Scene, fovRadians: number) {
  const photo = scene.reference.extrinsics;
  const P = new THREE.Vector3(...photo.position);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
    new THREE.Quaternion(...photo.quaternion),
  );
  const heading = new THREE.Vector3(forward.x, 0, forward.z).normalize();
  const look = (position: THREE.Vector3, target: THREE.Vector3) =>
    cameraViewLookingAt("", position.toArray(), target.toArray(), fovRadians)
      .quaternion;
  const views: { point: TrajectoryPoint; quaternion: TrajectoryQuaternion }[] =
    [];
  if (kind === "descent") {
    // from 450 m, looking almost straight down at the spot, down to the photo's own view (build_place.approach)
    const n = 8;
    const endPitch = Math.asin(forward.y);
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1);
      const alt = Math.exp(Math.log(450 + P.y) * (1 - s) + Math.log(P.y) * s);
      const pitch =
        THREE.MathUtils.degToRad(-70) +
        (endPitch - THREE.MathUtils.degToRad(-70)) * s ** 1.4;
      const back =
        (alt - P.y) / Math.tan(Math.max(-pitch, THREE.MathUtils.degToRad(15)));
      const C = P.clone().addScaledVector(heading, -back).setY(alt);
      const dir = heading
        .clone()
        .multiplyScalar(Math.cos(pitch))
        .setY(Math.sin(pitch));
      views.push({
        point: C.toArray(),
        quaternion:
          i === n - 1 ? photo.quaternion : look(C, C.clone().add(dir)),
      });
    }
  } else if (kind === "circle") {
    const S = new THREE.Vector3(...scene.focus).setY(P.y);
    const radius = Math.min(8, Math.max(3, S.distanceTo(P) * 0.6));
    const start = Math.atan2(P.x - S.x, P.z - S.z);
    for (let k = 0; k < 8; k++) {
      const a = start + (k / 8) * Math.PI * 2;
      const C = new THREE.Vector3(
        S.x + Math.sin(a) * radius,
        P.y,
        S.z + Math.cos(a) * radius,
      );
      views.push({ point: C.toArray(), quaternion: look(C, S) });
    }
  } else {
    // a 3 m circle around the spot, starting and ending at the photo, looking the way you walk
    const centre = P.clone().addScaledVector(heading, 3);
    for (let k = 0; k <= 8; k++) {
      const a = Math.atan2(-heading.x, -heading.z) + (k / 8) * Math.PI * 2;
      const C = new THREE.Vector3(
        centre.x + Math.sin(a) * 3,
        P.y,
        centre.z + Math.cos(a) * 3,
      );
      const along = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
      views.push({
        point: C.toArray(),
        quaternion:
          k === 0 || k === 8 ? photo.quaternion : look(C, C.clone().add(along)),
      });
    }
  }
  return views;
}

function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry!.contentRect.width,
        height: entry!.contentRect.height,
      }),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

const pill =
  "flex h-9 items-center gap-1 rounded-lg border border-black/10 bg-white/95 px-1 text-xs text-neutral-700 shadow-sm backdrop-blur";
const pillButton =
  "flex h-7 items-center gap-1.5 rounded-md px-2 font-medium transition hover:bg-black/5 hover:text-neutral-900 disabled:opacity-30 disabled:hover:bg-transparent";

export function CameraWorkspace({
  projectId,
  scene,
  mode,
  saved,
  hiddenFrames,
  onToggleFrame,
  takes,
  onShowTakeDots,
  onTakeStep,
  onChange,
  onRender,
  placePanel,
}: {
  projectId: string;
  scene: Scene;
  mode: Mode;
  saved: Partial<EditorState>;
  hiddenFrames: ReadonlySet<string>;
  onToggleFrame: (name: string) => void;
  takes: Take[];
  onShowTakeDots: (tag: string | null) => void;
  onTakeStep: (tag: string, step: "cloud" | "export") => void;
  onChange: (state: EditorState) => void;
  onRender: (targets: PinholeCamera[], what: string) => void;
  placePanel: ReactNode;
}) {
  const drawingPanelMinimizeButton = useRef<HTMLButtonElement | null>(null);
  const drawingPanelRestoreButton = useRef<HTMLButtonElement | null>(null);
  const directionPanelMinimizeButton = useRef<HTMLButtonElement | null>(null);
  const directionPanelRestoreButton = useRef<HTMLButtonElement | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const viewportCamera = useRef<THREE.PerspectiveCamera | null>(null);
  const viewportSize = useSize(viewport);
  const [segments, setSegments] = useState<TrajectorySegment[]>(
    saved.segments ?? [],
  );
  const [trajectorySmoothingVersion, setTrajectorySmoothingVersion] = useState(
    saved.trajectorySmoothingVersion ?? 0,
  );
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  const [selectedPivot, setSelectedPivot] = useState<SelectedPivot | null>(
    null,
  );
  const [drawingView, setDrawingView] = useState<TrajectoryDrawingView | null>(
    null,
  );
  const [frameCount, setFrameCount] = useState(
    saved.frameCount ?? DEFAULT_FRAME_COUNT,
  );
  const [fps, setFps] = useState(saved.fps ?? DEFAULT_FPS);
  const [directionMode, setDirectionMode] = useState<CameraDirectionMode>(
    saved.directionMode ?? DEFAULT_DIRECTION_MODE,
  );
  const [directionTarget, setDirectionTarget] =
    useState<TrajectoryPoint | null>(saved.directionTarget ?? null);
  const [placingDirectionTarget, setPlacingDirectionTarget] = useState(false);
  const [pendingDirectionMode, setPendingDirectionMode] =
    useState<PointDirectionMode | null>(null);
  const [placingLookAtSegmentId, setPlacingLookAtSegmentId] = useState<
    string | null
  >(null);
  const [closedLoop, setClosedLoop] = useState(saved.closedLoop ?? false);
  // The terrain is not flat: cameras may go below the photo spot's ground level (the dry run checks the terrain).
  const [allowBelowFloor, setAllowBelowFloor] = useState(
    saved.allowBelowFloor ?? true,
  );
  const [targetFovDegrees, setTargetFovDegrees] = useState(
    saved.targetFovDegrees ?? Math.round(hfovToVfov(DEFAULT_HFOV_DEGREES)),
  );
  const [previewing, setPreviewing] = useState(false);
  const [addingPivot, setAddingPivot] = useState(false);
  const [newPart, setNewPart] = useState(false);
  const [padWidth, setPadWidth] = useState(150);
  const [viewFrom, setViewFrom] = useState<ViewFrom | null>(null);
  const [showImage, setShowImage] = useState(true);
  const [takeTag, setTakeTag] = useState<string | null>(
    takes.at(-1)?.tag ?? null,
  );
  const [takeDots, setTakeDots] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawingPanelOpen, setDrawingPanelOpen] = useState(true);
  const [directionPanelOpen, setDirectionPanelOpen] = useState(true);
  const [drawingPanelSizeIndex, setDrawingPanelSizeIndex] = useState(
    DEFAULT_DRAWING_PANEL_SIZE_INDEX,
  );
  const [error, setError] = useState<string | null>(null);
  const effectiveDirectionTarget = isPointDirectionMode(directionMode)
    ? (directionTarget ?? scene.focus)
    : scene.focus;
  const path = useMemo(() => trajectoryPathFromSegments(segments), [segments]);
  const take = takes.find((t) => t.tag === takeTag) ?? null;

  const referenceView = useMemo<CameraView>(
    () => ({
      id: "reference",
      position: scene.reference.extrinsics.position,
      quaternion: scene.reference.extrinsics.quaternion,
      fovRadians: verticalFov(scene.reference.intrinsics),
    }),
    [scene.reference],
  );
  const targetReferenceView = useMemo<CameraView>(
    () => ({
      ...referenceView,
      fovRadians: THREE.MathUtils.degToRad(targetFovDegrees),
    }),
    [referenceView, targetFovDegrees],
  );
  const trajectoryMap = useMemo(() => buildTrajectoryMap(scene), [scene]);
  const padSpace = useMemo<TrajectorySpace>(
    () => ({ center: trajectoryMap.space.center, radius: padWidth / 2 }),
    [padWidth, trajectoryMap],
  );
  const views = useMemo(
    () =>
      cameraViewsFromSegments(segments, targetReferenceView, allowBelowFloor),
    [allowBelowFloor, segments, targetReferenceView],
  );
  const pathOptions = {
    directionMode,
    directionTarget: effectiveDirectionTarget,
    closedLoop,
    allowBelowFloor,
  };
  const requiredFrameCount =
    views.length + (closedLoop && views.length >= 3 ? 1 : 0);
  const minimumFrameCount = Math.min(
    MAX_FRAME_COUNT,
    Math.max(MIN_FRAME_COUNT, requiredFrameCount),
  );
  const cameraPivots = useMemo(
    () => trajectoryPivotsFromSegments(segments),
    [segments],
  );
  const selectedPartIndex = selectedSegmentId
    ? segments.findIndex((segment) => segment.id === selectedSegmentId)
    : -1;
  const selectedPart =
    selectedPartIndex >= 0 ? segments[selectedPartIndex]! : null;
  const partLookAtTargets = useMemo(
    () =>
      segments.reduce<TrajectoryPoint[]>((targets, segment) => {
        const target = segment.look_at_target;
        if (
          target &&
          !targets.some(
            (current) =>
              new THREE.Vector3(...current).distanceTo(
                new THREE.Vector3(...target),
              ) <= 1e-5,
          )
        ) {
          targets.push(target);
        }
        return targets;
      }, []),
    [segments],
  );
  const selectedCameraView = useMemo<CameraView | null>(() => {
    if (!selectedPivot) return null;
    const viewIndex = selectedPivot.pivotNumber - 1;
    const view = views[viewIndex];
    return view
      ? { id: view.id, ...sampleCameraPivot(views, viewIndex, pathOptions) }
      : null;
  }, [
    allowBelowFloor,
    closedLoop,
    directionMode,
    effectiveDirectionTarget,
    selectedPivot,
    views,
  ]);
  const editSnapshot = useMemo<EditorState>(
    () => ({
      segments,
      trajectorySmoothingVersion,
      directionMode,
      directionTarget,
      closedLoop,
      allowBelowFloor,
      targetFovDegrees,
      frameCount,
      fps,
    }),
    [
      segments,
      trajectorySmoothingVersion,
      directionMode,
      directionTarget,
      closedLoop,
      allowBelowFloor,
      targetFovDegrees,
      frameCount,
      fps,
    ],
  );
  const edits = useEditHistory(editSnapshot, projectId, (state) => {
    setSegments(state.segments);
    setTrajectorySmoothingVersion(state.trajectorySmoothingVersion);
    setDirectionMode(state.directionMode);
    setDirectionTarget(state.directionTarget);
    setClosedLoop(state.closedLoop);
    setAllowBelowFloor(state.allowBelowFloor);
    setTargetFovDegrees(state.targetFovDegrees);
    setFrameCount(state.frameCount);
    setFps(state.fps);
    setSelectedPivot(null);
    setSelectedSegmentId(null);
    setPreviewing(false);
    setAddingPivot(false);
    setPlacingDirectionTarget(false);
    setPlacingLookAtSegmentId(null);
    setPendingDirectionMode(null);
    setError(null);
    setNotice(null);
  });
  useEffect(() => onChange(editSnapshot), [editSnapshot]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"]',
        )
      )
        return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) edits.redo();
        else edits.undo();
      } else if (event.ctrlKey && key === "y") {
        event.preventDefault();
        edits.redo();
      } else if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !previewing &&
        !addingPivot &&
        !placingDirectionTarget &&
        selectedPivot &&
        (key === "delete" || key === "backspace")
      ) {
        event.preventDefault();
        deletePathPivot(selectedPivot);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // The cameras World Labs is asked for: one per camera point (Frame), or the path sampled into frames (Video).
  function targetCameras(views: CameraView[]): PinholeCamera[] {
    if (mode === "video")
      return buildTargetCameras(views, frameCount, WIDTH, HEIGHT, pathOptions);
    return views.map((_, index) => {
      const view = sampleCameraPivot(views, index, pathOptions);
      return {
        intrinsics: createIntrinsicsFromFov(
          THREE.MathUtils.radToDeg(view.fovRadians),
          WIDTH,
          HEIGHT,
        ),
        extrinsics: {
          position: view.position,
          quaternion: view.quaternion,
          coordinateSystem: "rub",
        },
      };
    });
  }

  function render() {
    if (views.length < 1 || (mode === "video" && views.length < 2)) return;
    const smoothed =
      mode === "video" ? materializeSmoothedTrajectory() : segments;
    onRender(
      targetCameras(
        cameraViewsFromSegments(smoothed, targetReferenceView, allowBelowFloor),
      ),
      mode === "video"
        ? `a ${frameCount}-frame path (${(frameCount / fps).toFixed(1)} s at ${fps} fps)`
        : `${views.length} camera ${views.length === 1 ? "point" : "points"}`,
    );
  }

  // A camera where the viewport is looking from: appended to the last part, or the start of a new one.
  function addCameras(
    added: { point: TrajectoryPoint; quaternion: TrajectoryQuaternion }[],
    startPart: boolean,
  ) {
    const materialized = materializeTrajectorySmoothing(
      segments,
      trajectorySmoothingVersion,
    );
    const current = materialized.segments;
    const last = current.at(-1);
    let next: TrajectorySegment[];
    if (!last || startPart) {
      const head = last
        ? [
            {
              point: last.points.at(-1)!,
              quaternion: last.quaternions?.at(-1) ?? null,
            },
          ]
        : [];
      const all = [...head, ...added];
      next = [
        ...current,
        {
          id: `part-${Date.now()}`,
          points: all.map((a) => a.point),
          quaternions: all.map((a) => a.quaternion),
        },
      ];
    } else {
      next = current.map((segment) =>
        segment === last
          ? {
              ...segment,
              points: [...segment.points, ...added.map((a) => a.point)],
              quaternions: [
                ...(segment.quaternions ?? segment.points.map(() => null)),
                ...added.map((a) => a.quaternion),
              ],
            }
          : segment,
      );
    }
    setSegments(next);
    setTrajectorySmoothingVersion(materialized.version);
    const lastSegment = next.at(-1)!;
    setSelectedSegmentId(lastSegment.id);
    setSelectedPivot({
      segmentId: lastSegment.id,
      pointIndex: lastSegment.points.length - 1,
      pivotNumber: trajectoryPathFromSegments(next).length,
    });
    setClosedLoop(false);
    setPreviewing(false);
    setError(null);
  }

  function addFrameHere() {
    const camera = viewportCamera.current;
    if (!camera) return;
    addCameras(
      [
        {
          point: camera.position.toArray() as TrajectoryPoint,
          quaternion: camera.quaternion.toArray() as TrajectoryQuaternion,
        },
      ],
      newPart,
    );
    setNewPart(false);
    setNotice("Camera added where you are looking from.");
  }

  function addPreset(kind: PresetKind) {
    addCameras(
      presetPart(kind, scene, THREE.MathUtils.degToRad(targetFovDegrees)),
      true,
    );
    setNotice(
      kind === "descent"
        ? "Added a descent from 450 m to the photo's view."
        : kind === "circle"
          ? "Added a circle at eye level around what the photo looks at."
          : "Added a short walk from the photo spot.",
    );
  }

  function smoothPath() {
    setSegments(smoothTrajectorySegments(segments, closedLoop));
    setTrajectorySmoothingVersion(TRAJECTORY_SMOOTHING_VERSION);
    setPreviewing(false);
    setAddingPivot(false);
    setError(null);
    setNotice(
      "Path smoothed. Camera aim and timing are preserved. Undo to compare.",
    );
  }

  function materializeSmoothedTrajectory(): TrajectorySegment[] {
    const materialized = materializeTrajectorySmoothing(
      segments,
      trajectorySmoothingVersion,
    );
    if (materialized.version !== trajectorySmoothingVersion) {
      setSegments(materialized.segments);
      setTrajectorySmoothingVersion(materialized.version);
    }
    return materialized.segments;
  }

  useEffect(() => {
    if (frameCount >= minimumFrameCount) return;
    setFrameCount(minimumFrameCount);
    setPreviewing(false);
  }, [frameCount, minimumFrameCount]);

  function updateDrawnSegments(nextSegments: TrajectorySegment[]) {
    setSegments(nextSegments);
    setClosedLoop(false);
    setAddingPivot(false);
    setPreviewing(false);
    setError(null);
  }

  function completeDrawnSegments(nextSegments: TrajectorySegment[]) {
    updateDrawnSegments(nextSegments);
    const lastSegment = nextSegments.at(-1);
    setSelectedSegmentId(lastSegment?.id ?? null);
    setSelectedPivot(
      lastSegment
        ? {
            segmentId: lastSegment.id,
            pointIndex: lastSegment.points.length - 1,
            pivotNumber: trajectoryPathFromSegments(nextSegments).length,
          }
        : null,
    );
  }

  function movePathPoint(
    segmentId: string,
    pointIndex: number,
    position: TrajectoryPoint,
  ) {
    setSegments((current) =>
      moveTrajectoryPoint(current, segmentId, pointIndex, position),
    );
    setPreviewing(false);
    setSelectedSegmentId(segmentId);
    setError(null);
  }

  function applyPathShape(
    shape: TrajectoryShape,
    scopeSegmentId: string | null,
  ) {
    const materialized = materializeTrajectorySmoothing(
      segments,
      trajectorySmoothingVersion,
    );
    const shaped = reshapeTrajectorySegments(
      materialized.segments,
      shape,
      drawingView ?? cameraDrawingView(referenceView.quaternion),
      scopeSegmentId,
      closedLoop,
      allowBelowFloor,
    );
    if (!shaped) {
      setError(
        allowBelowFloor
          ? "That shape would collapse cameras together. Try another part or rotate the 3D view."
          : "That shape would collapse cameras together or move them below the floor. Try another part or rotate the 3D view.",
      );
      return;
    }
    setSegments(shaped);
    setTrajectorySmoothingVersion(materialized.version);
    setAddingPivot(false);
    setPreviewing(false);
    setError(null);
    const scopeLabel = scopeSegmentId
      ? `Part ${segments.findIndex((segment) => segment.id === scopeSegmentId) + 1}`
      : "Whole path";
    const actionLabel =
      shape === "straighten"
        ? "straightened"
        : shape === "circular"
          ? "made circular"
          : "flattened";
    setNotice(
      `${scopeLabel} ${actionLabel}. Camera aim and timing stayed the same.`,
    );
  }

  function chooseDirectionMode(nextMode: CameraDirectionMode) {
    if (isPointDirectionMode(nextMode) && !directionTarget) {
      setPlacingLookAtSegmentId(null);
      setPendingDirectionMode(nextMode);
      setPlacingDirectionTarget(true);
      setPreviewing(false);
      setError(null);
      return;
    }
    if (isPointDirectionMode(nextMode)) {
      setSegments((current) =>
        current.map((segment) => ({ ...segment, look_at_target: null })),
      );
    }
    setDirectionMode(nextMode);
    setPlacingLookAtSegmentId(null);
    setPendingDirectionMode(null);
    setPlacingDirectionTarget(false);
    setPreviewing(false);
    setError(null);
  }

  function choosePartDirectionTarget(segmentId: string) {
    setPlacingLookAtSegmentId(segmentId);
    setPendingDirectionMode(null);
    setPlacingDirectionTarget(true);
    setPreviewing(false);
    setError(null);
  }

  function setPartLookAtTarget(
    segmentId: string,
    target: TrajectoryPoint | null,
  ) {
    setSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, look_at_target: target }
          : segment,
      ),
    );
    setPreviewing(false);
    setError(null);
  }

  function removePartLookAtTarget(segmentId: string) {
    setPartLookAtTarget(segmentId, null);
    const partNumber =
      segments.findIndex((segment) => segment.id === segmentId) + 1;
    setNotice(`Part ${partNumber} now uses the whole-path camera behavior.`);
  }

  function limitLookAtTargetToPart(segmentId: string) {
    if (!effectiveDirectionTarget) return;
    setSegments((current) =>
      current.map((segment) => ({
        ...segment,
        look_at_target:
          segment.id === segmentId ? effectiveDirectionTarget : null,
      })),
    );
    setDirectionMode("manual");
    setPreviewing(false);
    setError(null);
    const partNumber =
      segments.findIndex((segment) => segment.id === segmentId) + 1;
    setNotice(
      `Only Part ${partNumber} looks at that point. Other parts keep their camera angles.`,
    );
  }

  function placeDirectionTarget(position: TrajectoryPoint) {
    const clearance = Math.max(0.02, trajectoryMap.space.radius * 0.015);
    const targetViews = placingLookAtSegmentId
      ? cameraViewsFromSegments(
          segments.map((segment) =>
            segment.id === placingLookAtSegmentId
              ? { ...segment, look_at_target: position }
              : segment,
          ),
          targetReferenceView,
          allowBelowFloor,
        )
      : views;
    if (
      !(placingLookAtSegmentId
        ? partLookAtTargetIsClearOfPath(
            targetViews,
            position,
            closedLoop,
            clearance,
            allowBelowFloor,
          )
        : cameraTargetIsClearOfPath(
            targetViews,
            position,
            closedLoop,
            clearance,
            undefined,
            allowBelowFloor,
          ))
    ) {
      setError(
        "That point is on the camera path. Pick a nearby object away from the blue line.",
      );
      return;
    }
    if (placingLookAtSegmentId) {
      setPartLookAtTarget(placingLookAtSegmentId, position);
      const partNumber =
        segments.findIndex((segment) => segment.id === placingLookAtSegmentId) +
        1;
      setPlacingLookAtSegmentId(null);
      setPlacingDirectionTarget(false);
      setNotice(
        `Part ${partNumber} now looks at that point. Other parts keep their current behavior.`,
      );
      return;
    }
    setSegments((current) =>
      current.map((segment) => ({ ...segment, look_at_target: null })),
    );
    setDirectionTarget(position);
    const nextMode =
      pendingDirectionMode ??
      (isPointDirectionMode(directionMode) ? directionMode : "look_at");
    setDirectionMode(nextMode);
    setPlacingLookAtSegmentId(null);
    setPendingDirectionMode(null);
    setPlacingDirectionTarget(false);
    setPreviewing(false);
    setError(null);
    setNotice(
      nextMode === "look_at"
        ? "Every camera now points at the selected scene point."
        : "Every camera now points away from the selected scene point.",
    );
  }

  function addPathPivot(position: TrajectoryPoint, pathProgress: number) {
    const inserted = insertTrajectoryPivot(
      segments,
      position,
      pathProgress,
      closedLoop,
      allowBelowFloor,
    );
    setAddingPivot(false);
    if (!inserted) {
      setError("Could not add a pivot there. Choose another part of the path.");
      return;
    }
    setSegments(inserted.segments);
    setSelectedSegmentId(inserted.segmentId);
    setSelectedPivot({
      segmentId: inserted.segmentId,
      pointIndex: inserted.pointIndex,
      pivotNumber: inserted.pivotNumber,
    });
    setPreviewing(false);
    setError(null);
  }

  function selectPathPivot(
    segmentId: string,
    pointIndex: number,
    pivotNumber: number,
  ) {
    setSelectedPivot({ segmentId, pointIndex, pivotNumber });
    setSelectedSegmentId(segmentId);
    setAddingPivot(false);
    setError(null);
  }

  function setPathPivotCameraAngle(
    segmentId: string,
    pointIndex: number,
    quaternion: TrajectoryQuaternion,
  ) {
    setSegments((current) =>
      directionMode === "manual"
        ? setTrajectoryPointQuaternion(
            current,
            segmentId,
            pointIndex,
            quaternion,
          )
        : setTrajectoryPointDirectionOverride(
            current,
            segmentId,
            pointIndex,
            quaternion,
          ),
    );
    setPreviewing(false);
    setError(null);
  }

  function clearPath() {
    setSegments([]);
    setTrajectorySmoothingVersion(0);
    setSelectedSegmentId(null);
    setSelectedPivot(null);
    setAddingPivot(false);
    setPreviewing(false);
    setPlacingLookAtSegmentId(null);
    setClosedLoop(false);
    setError(null);
  }

  function updateAllowBelowFloor(nextAllowBelowFloor: boolean) {
    const belowFloorCount = path.filter(
      (point) => point[1] < TRAJECTORY_FLOOR_Y - 1e-6,
    ).length;
    if (!nextAllowBelowFloor && belowFloorCount > 0) {
      setError(
        `${belowFloorCount} camera ${belowFloorCount === 1 ? "is" : "are"} below the floor. Move ${belowFloorCount === 1 ? "it" : "them"} above it first.`,
      );
      return;
    }
    setAllowBelowFloor(nextAllowBelowFloor);
    setAddingPivot(false);
    setPreviewing(false);
    setError(null);
  }

  function closePathLoop() {
    if (path.length < 3) return;
    const nextSegments = normalizeClosedTrajectorySegments(segments);
    const nextPivots = trajectoryPivotsFromSegments(nextSegments);
    if (nextPivots.length < 3) {
      setError("A loop needs at least three different camera points.");
      return;
    }
    if (nextPivots.length !== cameraPivots.length) {
      setSegments(nextSegments);
      setSelectedPivot(null);
    }
    setClosedLoop(true);
    setPreviewing(false);
    setError(null);
  }

  function deletePathPart(id: string) {
    const remaining = segments.filter((segment) => segment.id !== id);
    setSegments(remaining);
    if (selectedSegmentId === id) {
      setSelectedSegmentId(remaining.at(-1)?.id ?? null);
    }
    setSelectedPivot(null);
    setPreviewing(false);
    setAddingPivot(false);
    setClosedLoop(false);
    setError(null);
  }

  function deletePathPivot(pivot: SelectedPivot) {
    const nextSegments = deleteTrajectoryPivot(
      segments,
      pivot.segmentId,
      pivot.pointIndex,
    );
    if (!nextSegments) {
      setError("That camera is no longer in the path.");
      return;
    }

    const nextPivots = trajectoryPivotsFromSegments(nextSegments);
    const nextPivot =
      nextPivots[Math.min(pivot.pivotNumber - 1, nextPivots.length - 1)] ??
      null;
    setSegments(nextSegments);
    if (nextPivots.length < 3) setClosedLoop(false);
    setSelectedPivot(
      nextPivot
        ? {
            segmentId: nextPivot.segmentId,
            pointIndex: nextPivot.pointIndex,
            pivotNumber: nextPivot.pivotNumber,
          }
        : null,
    );
    setSelectedSegmentId(nextPivot?.segmentId ?? null);
    setPreviewing(false);
    setAddingPivot(false);
    setError(null);
  }

  function togglePathPreview() {
    if (views.length < 2) return;
    setAddingPivot(false);
    setViewFrom(null);
    if (!previewing) materializeSmoothedTrajectory();
    setPreviewing((current) => !current);
    setError(null);
  }

  function setDrawingPanelVisibility(open: boolean) {
    setDrawingPanelOpen(open);
    requestAnimationFrame(() => {
      (open
        ? drawingPanelMinimizeButton
        : drawingPanelRestoreButton
      ).current?.focus();
    });
  }

  function setDirectionPanelVisibility(open: boolean) {
    setDirectionPanelOpen(open);
    requestAnimationFrame(() => {
      (open
        ? directionPanelMinimizeButton
        : directionPanelRestoreButton
      ).current?.focus();
    });
  }

  function viewFromFrame(frame: Frame) {
    setViewFrom({
      label: frame.name,
      image: frame.image,
      view: {
        id: frame.name,
        position: frame.camera.extrinsics.position,
        quaternion: frame.camera.extrinsics.quaternion,
        fovRadians: verticalFov(frame.camera.intrinsics),
      },
    });
  }

  function viewFromPivot(index: number) {
    const view = sampleCameraPivot(views, index, pathOptions);
    setViewFrom({
      label: `Camera ${index + 1}`,
      view: { id: `pivot-${index}`, ...view },
    });
    const pivot = cameraPivots[index];
    if (pivot)
      selectPathPivot(pivot.segmentId, pivot.pointIndex, pivot.pivotNumber);
  }

  const box = frameBox(viewportSize.width, viewportSize.height);
  const hfov = Math.round(vfovToHfov(targetFovDegrees));
  const tile =
    "group relative h-[5.25rem] w-[9.5rem] shrink-0 overflow-hidden rounded-lg border bg-neutral-100 text-left transition";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <main
        ref={viewport}
        className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-black/10 bg-[#f6f6f4]"
      >
        <div
          className={
            previewing
              ? "absolute inset-0 grid place-items-center bg-neutral-900 p-4 sm:p-8"
              : "absolute inset-0"
          }
        >
          <div
            className={
              previewing
                ? "relative aspect-video w-full max-w-[min(72rem,130dvh)] overflow-hidden rounded-lg border border-white/15 bg-black shadow-2xl"
                : "h-full w-full"
            }
          >
            <CameraTrajectoryCanvas
              scene={scene}
              hiddenClouds={hiddenFrames}
              viewFrom={viewFrom?.view ?? null}
              onViewFromEnd={() => setViewFrom(null)}
              viewportCamera={viewportCamera}
              referenceView={referenceView}
              views={views}
              segments={segments}
              selectedPivot={selectedPivot}
              addingPivot={addingPivot}
              previewing={previewing}
              disabled={mode === "place"}
              frameCount={frameCount}
              previewSeconds={frameCount / fps}
              frameWidth={WIDTH}
              frameHeight={HEIGHT}
              directionMode={directionMode}
              directionTarget={effectiveDirectionTarget ?? null}
              directionTargetCandidates={trajectoryMap.worldPoints}
              placingDirectionTarget={placingDirectionTarget}
              placingDirectionTargetMode={
                pendingDirectionMode ??
                (isPointDirectionMode(directionMode)
                  ? directionMode
                  : "look_at")
              }
              closedLoop={closedLoop}
              allowBelowFloor={allowBelowFloor}
              onPreviewDone={() => setPreviewing(false)}
              onDrawingViewChange={setDrawingView}
              onPointChange={movePathPoint}
              onPointSelect={selectPathPivot}
              onPivotAdd={addPathPivot}
              onDirectionTargetChange={placeDirectionTarget}
              onDirectionTargetCancel={() => {
                setPlacingDirectionTarget(false);
                setPendingDirectionMode(null);
                setPlacingLookAtSegmentId(null);
                setError(null);
              }}
              onDirectionTargetMiss={() =>
                setError(
                  "No reconstructed scene point there. Click on the visible point cloud.",
                )
              }
            />
            {previewing && (
              <button
                type="button"
                onClick={togglePathPreview}
                className="absolute right-3 top-3 flex h-9 items-center gap-2 rounded-md bg-white px-3 text-xs font-semibold text-neutral-900 shadow-lg transition hover:bg-white/90 active:translate-y-px"
              >
                <Pause className="h-3.5 w-3.5" />
                Stop preview
              </button>
            )}
          </div>
        </div>

        {viewFrom && !previewing && (
          <div
            className="pointer-events-none absolute rounded-sm border border-[#5b5fc7]/60"
            style={{
              ...box,
              boxShadow: "0 0 0 100vmax rgba(30,30,28,0.28)",
            }}
          >
            {viewFrom.image && showImage && (
              <img
                src={viewFrom.image}
                alt={viewFrom.label}
                className="h-full w-full object-cover"
              />
            )}
          </div>
        )}

        {!previewing && (
          <div className="pointer-events-none absolute inset-x-3 top-3 z-40 flex flex-wrap items-start justify-between gap-2 *:pointer-events-auto">
            <div className="flex gap-2">
              {mode === "place" ? null : (
                <div className={pill}>
                  <span className="pl-2 pr-1 text-neutral-400">Add part</span>
                  <button
                    type="button"
                    className={pillButton}
                    onClick={() => addPreset("descent")}
                    title="8 cameras from 450 m down to the photo's view"
                  >
                    Descent
                  </button>
                  <button
                    type="button"
                    className={pillButton}
                    onClick={() => addPreset("circle")}
                    title="8 cameras at eye level around what the photo looks at"
                  >
                    Circle
                  </button>
                  <button
                    type="button"
                    className={pillButton}
                    onClick={() => addPreset("walk")}
                    title="9 cameras walking a 3 m circle from the photo spot and back"
                  >
                    Walk
                  </button>
                </div>
              )}
            </div>

            <div>
              {viewFrom ? (
                <div className={pill}>
                  <span className="pl-2 text-neutral-400">Viewing from</span>
                  <span className="flex items-center gap-1.5 px-1 font-medium text-neutral-900">
                    <ImageIcon className="h-3.5 w-3.5" />
                    {viewFrom.label}
                  </span>
                  {viewFrom.image && (
                    <button
                      type="button"
                      className={pillButton}
                      title={
                        showImage ? "Show the dots instead" : "Show the image"
                      }
                      onClick={() => setShowImage((v) => !v)}
                    >
                      {showImage ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className={pillButton}
                    aria-label="Stop viewing from this camera"
                    onClick={() => setViewFrom(null)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <label
                  className={`${pill} pl-3`}
                  title="Horizontal field of view of the cameras you add (1280 × 720)"
                >
                  <span className="text-neutral-400">FOV</span>
                  <input
                    type="number"
                    min={Math.round(vfovToHfov(MIN_TARGET_FOV_DEGREES))}
                    max={Math.round(vfovToHfov(MAX_TARGET_FOV_DEGREES))}
                    value={hfov}
                    onChange={(event) =>
                      setTargetFovDegrees(
                        hfovToVfov(
                          Number(event.target.value) || DEFAULT_HFOV_DEGREES,
                        ),
                      )
                    }
                    className="h-7 w-14 rounded-md bg-transparent px-1 text-right font-medium tabular-nums text-neutral-900 outline-none focus:bg-black/5"
                  />
                  <span className="pr-2">°</span>
                </label>
              )}
            </div>

            <div className="flex gap-2">
              <div className={pill}>
                <button
                  type="button"
                  className={pillButton}
                  aria-label="Undo"
                  title="Undo (⌘Z)"
                  disabled={!edits.canUndo}
                  onClick={edits.undo}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className={pillButton}
                  aria-label="Redo"
                  title="Redo (⌘⇧Z)"
                  disabled={!edits.canRedo}
                  onClick={edits.redo}
                >
                  <Redo2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className={pill}>
                <button
                  type="button"
                  className={pillButton}
                  title="Look from the photo"
                  onClick={() =>
                    viewFromFrame(scene.frames.find((f) => f.name === "photo")!)
                  }
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  Photo
                </button>
                <button
                  type="button"
                  className={pillButton}
                  title="Look straight down from 900 m"
                  onClick={() =>
                    setViewFrom({
                      label: "Above, 900 m",
                      view: {
                        id: "above",
                        position: [0, 900, 0],
                        // pitched down 89°, north up (the orbit controls cannot look exactly straight down)
                        quaternion: cameraQuaternionFromAim(0, -89),
                        fovRadians: THREE.MathUtils.degToRad(45),
                      },
                    })
                  }
                >
                  <MapIcon className="h-3.5 w-3.5" />
                  Above
                </button>
              </div>
              <div className={pill}>
                <button
                  type="button"
                  className={pillButton}
                  disabled={
                    views.length < (mode === "video" ? 2 : 1) ||
                    mode === "place"
                  }
                  title="The exact atlasGenerate request and its cost (sends nothing)"
                  onClick={render}
                >
                  {"</>"} API
                </button>
              </div>
            </div>
          </div>
        )}

        {!previewing && mode === "place" && (
          <div className="absolute left-3 top-16 z-30 max-h-[calc(100%-5rem)] w-[24rem] overflow-y-auto rounded-xl border border-black/10 bg-white/95 p-3 shadow-xl backdrop-blur">
            {placePanel}
          </div>
        )}

        {!previewing && mode === "video" && (
          <div
            id="trajectory-drawing-panel"
            hidden={!drawingPanelOpen || placingDirectionTarget}
            inert={placingDirectionTarget ? true : undefined}
            className={`absolute left-3 top-16 z-30 max-h-[calc(100%-5rem)] max-w-[calc(100%-1.5rem)] overflow-y-auto overscroll-contain rounded-xl border border-black/10 bg-white/95 p-3 shadow-xl backdrop-blur ${DRAWING_PANEL_SIZES[drawingPanelSizeIndex]!.widthClass}`}
          >
            <div className="mb-2 flex items-center gap-2 border-b border-black/10 pb-2">
              <label
                className="flex flex-1 items-center gap-2 text-[11px] text-neutral-500"
                title="How many metres the drawing pad spans"
              >
                Pad width
                <select
                  value={padWidth}
                  onChange={(event) => setPadWidth(Number(event.target.value))}
                  className="h-7 rounded-md border border-black/10 bg-white px-1.5 text-[11px] font-medium text-neutral-800"
                >
                  {PAD_WIDTHS.map((w) => (
                    <option key={w} value={w}>
                      {w} m
                    </option>
                  ))}
                </select>
              </label>
              <button
                ref={drawingPanelMinimizeButton}
                type="button"
                aria-label="Minimize path panel"
                title="Minimize path panel"
                onClick={() => setDrawingPanelVisibility(false)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-black/10 text-neutral-500 transition hover:bg-black/5 hover:text-neutral-900"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>
            <TrajectoryDrawPad
              points={trajectoryMap.worldPoints}
              referencePosition={referenceView.position}
              segments={segments}
              selectedSegmentId={selectedSegmentId}
              path={path}
              view={drawingView ?? cameraDrawingView(referenceView.quaternion)}
              space={padSpace}
              previewing={previewing}
              addingPivot={addingPivot}
              closedLoop={closedLoop}
              allowBelowFloor={allowBelowFloor}
              disabled={false}
              panelSizeIndex={drawingPanelSizeIndex}
              onChange={updateDrawnSegments}
              onComplete={completeDrawnSegments}
              onSelectPart={setSelectedSegmentId}
              onDeletePart={deletePathPart}
              onApplyShape={applyPathShape}
              onSmooth={smoothPath}
              onTogglePivot={() => {
                setAddingPivot((current) => !current);
                setPreviewing(false);
                setError(null);
              }}
              onCloseLoop={closePathLoop}
              onAllowBelowFloorChange={updateAllowBelowFloor}
              onClear={clearPath}
              onPlay={togglePathPreview}
              onPanelSizeChange={setDrawingPanelSizeIndex}
            />
          </div>
        )}

        {!previewing &&
          mode === "video" &&
          !placingDirectionTarget &&
          !drawingPanelOpen && (
            <button
              ref={drawingPanelRestoreButton}
              type="button"
              onClick={() => setDrawingPanelVisibility(true)}
              className="absolute left-3 top-16 z-30 flex h-9 items-center gap-2 rounded-lg border border-black/10 bg-white/95 px-3 text-xs font-semibold text-neutral-700 shadow-sm hover:text-neutral-900"
            >
              <PanelLeftOpen className="h-4 w-4" />
              Path
            </button>
          )}

        {!previewing && mode !== "place" && views.length >= 1 && (
          <CameraDirectionPanel
            scene={scene}
            pivots={cameraPivots}
            selectedPivot={selectedPivot}
            selectedView={selectedCameraView}
            aspectRatio="16:9"
            frameWidth={WIDTH}
            frameHeight={HEIGHT}
            directionMode={directionMode}
            hasDirectionTarget={directionTarget !== null}
            selectedPart={
              selectedPart
                ? {
                    id: selectedPart.id,
                    number: selectedPartIndex + 1,
                    hasLookAtTarget: selectedPart.look_at_target != null,
                  }
                : null
            }
            disabled={addingPivot}
            hidden={!directionPanelOpen || placingDirectionTarget}
            minimizeButtonRef={directionPanelMinimizeButton}
            onMinimize={() => setDirectionPanelVisibility(false)}
            onSelect={(pivot) =>
              selectPathPivot(
                pivot.segmentId,
                pivot.pointIndex,
                pivot.pivotNumber,
              )
            }
            onAngleChange={(pivot, quaternion) => {
              setPathPivotCameraAngle(
                pivot.segmentId,
                pivot.pointIndex,
                quaternion,
              );
            }}
            onDirectionModeChange={chooseDirectionMode}
            onChooseDirectionTarget={() => {
              setPlacingLookAtSegmentId(null);
              if (isPointDirectionMode(directionMode)) {
                setPendingDirectionMode(directionMode);
              }
              setPlacingDirectionTarget(true);
              setPreviewing(false);
              setError(null);
            }}
            onChoosePartDirectionTarget={choosePartDirectionTarget}
            onRemovePartDirectionTarget={removePartLookAtTarget}
            onLimitDirectionTargetToPart={limitLookAtTargetToPart}
            onDelete={deletePathPivot}
          />
        )}

        {!previewing &&
          mode !== "place" &&
          !placingDirectionTarget &&
          views.length >= 1 &&
          !directionPanelOpen && (
            <button
              ref={directionPanelRestoreButton}
              type="button"
              onClick={() => setDirectionPanelVisibility(true)}
              className="absolute right-3 top-16 z-30 flex h-9 items-center gap-2 rounded-lg border border-black/10 bg-white/95 px-3 text-xs font-semibold text-neutral-700 shadow-sm hover:text-neutral-900"
            >
              Aim
              <PanelRightOpen className="h-4 w-4" />
            </button>
          )}

        {!previewing && (error || notice) && (
          <div className="absolute inset-x-3 bottom-3 z-20 mx-auto max-w-xl">
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-center text-xs text-red-700">
                {error}
              </div>
            )}
            {notice && !error && (
              <div
                role="status"
                className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-center text-xs text-emerald-800"
              >
                {notice}
              </div>
            )}
          </div>
        )}
      </main>

      <section className="flex shrink-0 flex-wrap gap-2">
        <div className="min-w-[20rem] flex-1 rounded-xl border border-black/10 bg-white p-2.5">
          <div className="mb-2 flex items-center gap-2 whitespace-nowrap px-1 text-xs">
            <span className="font-semibold text-neutral-900">
              Spatial Context
            </span>
            <span className="text-neutral-400">
              {scene.frames.length - hiddenFrames.size} of {scene.frames.length}
            </span>
            {mode !== "place" && views.length > 0 && (
              <>
                <span className="ml-4 font-semibold text-neutral-900">
                  Cameras
                </span>
                <span className="text-neutral-400">{views.length}</span>
              </>
            )}
            {takes.length > 0 && (
              <label className="ml-auto flex items-center gap-1.5 text-neutral-500">
                Results
                <select
                  value={takeTag ?? ""}
                  onChange={(event) => {
                    setTakeTag(event.target.value || null);
                    setTakeDots(false);
                    onShowTakeDots(null);
                  }}
                  className="h-7 rounded-md border border-black/10 bg-white px-1.5 font-medium text-neutral-800"
                >
                  <option value="">none</option>
                  {takes.map((t) => (
                    <option key={t.tag} value={t.tag}>
                      {t.tag} · {t.frames.length}
                    </option>
                  ))}
                </select>
                {take && (
                  <label
                    className="flex items-center gap-1"
                    title="Its frames with the depth World Labs returned, as dots in the 3D view"
                  >
                    <input
                      type="checkbox"
                      checked={takeDots}
                      onChange={(event) => {
                        setTakeDots(event.target.checked);
                        onShowTakeDots(event.target.checked ? take.tag : null);
                      }}
                    />
                    as dots
                  </label>
                )}
                {take?.cloud && (
                  <a
                    href={take.cloud}
                    download
                    className="text-[#4a4eb3] underline"
                  >
                    cloud.ply
                  </a>
                )}
                {take && (
                  <>
                    <button
                      type="button"
                      title="Fuse the take and the photo into one dot cloud (place_cloud.py)"
                      onClick={() => onTakeStep(take.tag, "cloud")}
                      className="h-7 rounded-md border border-black/10 px-2 font-medium text-neutral-700 hover:bg-black/5"
                    >
                      {take.cloud ? "Fuse again" : "Fuse .ply"}
                    </button>
                    <button
                      type="button"
                      title="Bundle the request, its files and results into export/ (export_request.py)"
                      onClick={() => onTakeStep(take.tag, "export")}
                      className="h-7 rounded-md border border-black/10 px-2 font-medium text-neutral-700 hover:bg-black/5"
                    >
                      Export
                    </button>
                  </>
                )}
              </label>
            )}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {scene.frames.map((frame) => {
              const hidden = hiddenFrames.has(frame.name);
              return (
                <div
                  key={frame.name}
                  className={`${tile} ${viewFrom?.label === frame.name ? "border-[#5b5fc7] ring-2 ring-[#5b5fc7]/30" : "border-black/10 hover:border-black/30"} ${hidden ? "opacity-40" : ""}`}
                >
                  <button
                    type="button"
                    className="h-full w-full"
                    onClick={() => viewFromFrame(frame)}
                    title={`Look from ${frame.name}`}
                  >
                    <img
                      src={frame.image}
                      alt={frame.name}
                      className="h-full w-full object-cover"
                    />
                  </button>
                  <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-neutral-800">
                    {frame.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleFrame(frame.name)}
                    title={
                      hidden
                        ? "Leave out of the request: click to use it"
                        : "Used in the request: click to leave it out"
                    }
                    className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded bg-white/90 text-neutral-700 opacity-0 transition group-hover:opacity-100"
                  >
                    {hidden ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              );
            })}
            {mode !== "place" &&
              views.map((view, index) => (
                <button
                  key={view.id}
                  type="button"
                  onClick={() => viewFromPivot(index)}
                  title={`Look from camera ${index + 1}`}
                  className={`${tile} grid place-items-center ${viewFrom?.label === `Camera ${index + 1}` ? "border-[#5b5fc7] ring-2 ring-[#5b5fc7]/30" : "border-dashed border-black/15 hover:border-black/30"}`}
                >
                  <span className="text-lg font-semibold tabular-nums text-neutral-700">
                    {index + 1}
                  </span>
                  <span className="absolute bottom-1 left-1.5 text-[10px] tabular-nums text-neutral-500">
                    {Math.round(view.position[1])} m up
                  </span>
                </button>
              ))}
            {take?.frames.map((frame, index) => (
              <button
                key={frame.image}
                type="button"
                onClick={() =>
                  setViewFrom({
                    label: `${take.tag} · ${index + 1}`,
                    image: frame.image,
                    view: {
                      id: frame.image,
                      position: frame.camera.extrinsics.position,
                      quaternion: frame.camera.extrinsics.quaternion,
                      fovRadians: verticalFov(frame.camera.intrinsics),
                    },
                  })
                }
                title={frame.label}
                className={`${tile} ${viewFrom?.label === `${take.tag} · ${index + 1}` ? "border-[#5b5fc7] ring-2 ring-[#5b5fc7]/30" : "border-black/10 hover:border-black/30"}`}
              >
                <img
                  src={frame.image}
                  alt={frame.label}
                  className="h-full w-full object-cover"
                />
                <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-neutral-800">
                  {index + 1}
                </span>
              </button>
            ))}
          </div>
        </div>

        {mode !== "place" && (
          <div className="flex w-[17rem] shrink-0 flex-col gap-2 rounded-xl border border-black/10 bg-white p-2.5">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={addFrameHere}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-[#5b5fc7] text-sm font-semibold text-white shadow-sm transition hover:bg-[#4a4eb3] active:translate-y-px"
                title="Add a camera where the viewport is looking from"
              >
                <Plus className="h-4 w-4" />
                Add frame
              </button>
              <button
                type="button"
                aria-pressed={newPart}
                onClick={() => setNewPart((v) => !v)}
                title="The next frame starts a new part of the path"
                className={`h-11 rounded-lg border px-2.5 text-[11px] font-semibold transition ${newPart ? "border-[#5b5fc7] bg-[#5b5fc7]/10 text-[#4a4eb3]" : "border-black/10 text-neutral-600 hover:bg-black/5"}`}
              >
                New part
              </button>
            </div>
            {mode === "video" ? (
              <div className="flex items-end gap-2">
                <OutputNumberInput
                  label="Frames"
                  value={frameCount}
                  min={minimumFrameCount}
                  max={MAX_FRAME_COUNT}
                  disabled={false}
                  onChange={(v) => {
                    setFrameCount(Math.max(v, minimumFrameCount));
                    setPreviewing(false);
                  }}
                />
                <OutputNumberInput
                  label="FPS"
                  value={fps}
                  min={1}
                  max={60}
                  disabled={false}
                  onChange={(v) => {
                    setFps(v);
                    setPreviewing(false);
                  }}
                />
                <button
                  type="button"
                  disabled={views.length < 2}
                  onClick={togglePathPreview}
                  className="flex h-11 items-center gap-1.5 rounded-lg border border-black/10 px-2.5 text-xs font-semibold text-neutral-700 hover:bg-black/5 disabled:opacity-30"
                  title="Fly the path through the dots"
                >
                  <Play className="h-3.5 w-3.5" />
                  {(frameCount / fps).toFixed(1)} s
                </button>
              </div>
            ) : null}
            <button
              type="button"
              disabled={views.length < (mode === "video" ? 2 : 1)}
              onClick={render}
              className="flex h-10 items-center justify-center gap-2 rounded-lg border border-black/10 text-sm font-medium text-neutral-800 transition hover:bg-black/5 disabled:opacity-35"
            >
              <Sparkles className="h-4 w-4" />
              {mode === "video"
                ? `Render video · ${frameCount} frames`
                : `Render ${views.length || ""} ${views.length === 1 ? "frame" : "frames"}`}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function CameraDirectionPanel({
  scene,
  pivots,
  selectedPivot,
  selectedView,
  aspectRatio,
  frameWidth,
  frameHeight,
  directionMode,
  hasDirectionTarget,
  selectedPart,
  disabled,
  hidden,
  minimizeButtonRef,
  onMinimize,
  onSelect,
  onAngleChange,
  onDirectionModeChange,
  onChooseDirectionTarget,
  onChoosePartDirectionTarget,
  onRemovePartDirectionTarget,
  onLimitDirectionTargetToPart,
  onDelete,
}: {
  scene: Scene;
  pivots: readonly TrajectoryPivot[];
  selectedPivot: SelectedPivot | null;
  selectedView: CameraView | null;
  aspectRatio: CameraTrajectoryAspectRatio;
  frameWidth: number;
  frameHeight: number;
  directionMode: CameraDirectionMode;
  hasDirectionTarget: boolean;
  selectedPart: {
    id: string;
    number: number;
    hasLookAtTarget: boolean;
  } | null;
  disabled: boolean;
  hidden: boolean;
  minimizeButtonRef: RefObject<HTMLButtonElement | null>;
  onMinimize: () => void;
  onSelect: (pivot: TrajectoryPivot) => void;
  onAngleChange: (
    pivot: SelectedPivot,
    quaternion: TrajectoryQuaternion,
  ) => void;
  onDirectionModeChange: (mode: CameraDirectionMode) => void;
  onChooseDirectionTarget: () => void;
  onChoosePartDirectionTarget: (segmentId: string) => void;
  onRemovePartDirectionTarget: (segmentId: string) => void;
  onLimitDirectionTargetToPart: (segmentId: string) => void;
  onDelete: (pivot: SelectedPivot) => void;
}) {
  const [previewQuaternion, setPreviewQuaternion] =
    useState<TrajectoryQuaternion | null>(null);
  const aimDrag = useRef<{
    pointerId: number;
    target: HTMLDivElement;
    pivot: SelectedPivot;
    startX: number;
    startY: number;
    startAim: { yaw: number; pitch: number };
    quaternion: TrajectoryQuaternion;
    moved: boolean;
  } | null>(null);
  const displayedQuaternion =
    previewQuaternion ?? selectedView?.quaternion ?? null;
  const aim = displayedQuaternion
    ? cameraAimDegrees(displayedQuaternion)
    : null;
  const pointDirectionMode = isPointDirectionMode(directionMode);
  const selectedPivotUsesPartTarget = Boolean(
    selectedPivot &&
    pivots.find((pivot) => pivot.pivotNumber === selectedPivot.pivotNumber)
      ?.hasLookAtTarget,
  );
  const selectedUsesPointTarget =
    pointDirectionMode || selectedPivotUsesPartTarget;

  useEffect(() => {
    const activeDrag = aimDrag.current;
    aimDrag.current = null;
    if (activeDrag?.target.hasPointerCapture(activeDrag.pointerId)) {
      activeDrag.target.releasePointerCapture(activeDrag.pointerId);
    }
    setPreviewQuaternion(selectedView?.quaternion ?? null);
  }, [selectedPivot, selectedView]);

  function startAimDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      disabled ||
      selectedUsesPointTarget ||
      event.button !== 0 ||
      !selectedPivot ||
      !displayedQuaternion
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    aimDrag.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      pivot: selectedPivot,
      startX: event.clientX,
      startY: event.clientY,
      startAim: cameraAimDegrees(displayedQuaternion),
      quaternion: displayedQuaternion,
      moved: false,
    };
  }

  function continueAimDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const activeDrag = aimDrag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    const horizontalPixels = event.clientX - activeDrag.startX;
    const verticalPixels = event.clientY - activeDrag.startY;
    if (!activeDrag.moved && Math.hypot(horizontalPixels, verticalPixels) < 3) {
      return;
    }
    activeDrag.moved = true;
    activeDrag.quaternion = cameraQuaternionFromAim(
      activeDrag.startAim.yaw + horizontalPixels * 0.3,
      activeDrag.startAim.pitch - verticalPixels * 0.3,
    );
    setPreviewQuaternion(activeDrag.quaternion);
  }

  function finishAimDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ) {
    const activeDrag = aimDrag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    aimDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit && activeDrag.moved) {
      onAngleChange(activeDrag.pivot, activeDrag.quaternion);
    } else {
      setPreviewQuaternion(selectedView?.quaternion ?? null);
    }
  }

  function nudgeAim(yawDelta: number, pitchDelta: number) {
    if (disabled || selectedUsesPointTarget || !selectedPivot || !aim) return;
    const quaternion = cameraQuaternionFromAim(
      aim.yaw + yawDelta,
      aim.pitch + pitchDelta,
    );
    setPreviewQuaternion(quaternion);
    onAngleChange(selectedPivot, quaternion);
  }

  return (
    <aside
      id="camera-direction-panel"
      hidden={hidden}
      aria-label="Camera direction"
      className="absolute right-3 top-16 z-30 max-h-[calc(100%-5rem)] w-[calc(50%-1.125rem)] max-w-[22rem] overflow-y-auto rounded-xl border border-black/10 bg-white/95 p-3 shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-start justify-between gap-3 border-b border-black/10 pb-2.5">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">
            Camera direction
          </h2>
          <p className="mt-1 text-[11px] leading-4 text-neutral-500">
            Select a camera to move, aim, or delete it.
          </p>
        </div>
        <button
          ref={minimizeButtonRef}
          type="button"
          data-overlay-toggle="direction"
          aria-label="Minimize camera direction panel"
          aria-controls="camera-direction-panel"
          aria-expanded="true"
          title="Minimize camera direction panel"
          onClick={onMinimize}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-black/10 text-neutral-500 transition hover:border-black/25 hover:bg-black/5 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b5fc7] active:translate-y-px"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div
          aria-label="Choose camera point"
          className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1"
        >
          {pivots.map((pivot) => {
            const selected = pivot.pivotNumber === selectedPivot?.pivotNumber;
            const partTargeted = pivot.hasLookAtTarget;
            return (
              <button
                key={`${pivot.segmentId}:${pivot.pointIndex}`}
                type="button"
                data-camera-point={pivot.pivotNumber}
                data-part-look-at-camera={partTargeted ? "true" : "false"}
                aria-label={`Select camera at point ${pivot.pivotNumber}`}
                aria-pressed={selected}
                onClick={() => onSelect(pivot)}
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border text-xs font-semibold tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b5fc7] active:translate-y-px ${
                  selected
                    ? partTargeted
                      ? "border-[#f4b860] bg-[#f4b860] text-neutral-900"
                      : "border-neutral-900 bg-neutral-900 text-neutral-900"
                    : partTargeted
                      ? "border-[#f4b860]/55 bg-[#f4b860]/10 text-amber-700 hover:border-[#f4b860] hover:bg-[#f4b860]/20"
                      : "border-black/10 bg-black/[0.04] text-neutral-600 hover:border-black/25 hover:text-neutral-900"
                } ${!pointDirectionMode && pivot.hasCameraAngle ? "ring-1 ring-[#5b5fc7]/80 ring-offset-1 ring-offset-white" : ""}`}
              >
                {pivot.pivotNumber}
              </button>
            );
          })}
        </div>
        {selectedPivot && (
          <button
            type="button"
            data-delete-camera-point={selectedPivot.pivotNumber}
            aria-label={`Delete camera point ${selectedPivot.pivotNumber}`}
            disabled={disabled}
            onClick={() => onDelete(selectedPivot)}
            title={`Delete camera ${selectedPivot.pivotNumber} (Delete / Backspace)`}
            className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-red-400/25 bg-red-500/[0.06] px-2 text-[11px] font-medium text-red-600 transition hover:border-red-400/45 hover:bg-red-500/10 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete {selectedPivot.pivotNumber}
          </button>
        )}
      </div>

      {selectedPivot && selectedView && aim ? (
        <>
          <div
            role={selectedUsesPointTarget ? "img" : "application"}
            aria-label={
              selectedUsesPointTarget
                ? "Point-cloud preview from the selected camera"
                : "Drag the point-cloud preview to aim the selected camera"
            }
            data-camera-aim-preview={selectedPivot.pivotNumber}
            onPointerDown={selectedUsesPointTarget ? undefined : startAimDrag}
            onPointerMove={
              selectedUsesPointTarget ? undefined : continueAimDrag
            }
            onPointerUp={
              selectedUsesPointTarget
                ? undefined
                : (event) => finishAimDrag(event, true)
            }
            onPointerCancel={
              selectedUsesPointTarget
                ? undefined
                : (event) => finishAimDrag(event, false)
            }
            onLostPointerCapture={
              selectedUsesPointTarget
                ? undefined
                : (event) => finishAimDrag(event, false)
            }
            className={`relative mt-2.5 select-none overflow-hidden rounded-lg border border-black/10 bg-[#ececea] ${selectedUsesPointTarget ? "touch-auto" : "touch-none"} ${aspectRatio === "9:16" ? "mx-auto w-[58%]" : "w-full"} ${disabled ? "cursor-not-allowed opacity-40" : selectedUsesPointTarget ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
            style={{ aspectRatio: `${frameWidth} / ${frameHeight}` }}
          >
            <div
              data-camera-preview-renderer="dense-splats"
              aria-label="Dense point-cloud view from the selected camera"
              className="pointer-events-none absolute inset-0"
            >
              <CameraPointCloudView
                scene={scene}
                view={{
                  ...selectedView,
                  quaternion: displayedQuaternion!,
                }}
              />
            </div>
            <div className="pointer-events-none absolute left-2 top-2 rounded border border-black/10 bg-white/85 px-2 py-1 text-[10px] font-medium text-neutral-700 backdrop-blur">
              Point {selectedPivot.pivotNumber} · dense camera view
            </div>
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2">
              <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-neutral-900/50" />
              <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-neutral-900/50" />
            </div>
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-neutral-400">
            {selectedUsesPointTarget
              ? selectedPivotUsesPartTarget && !pointDirectionMode
                ? "Preview follows this part's target. Other parts keep their own behavior."
                : "Preview follows the chosen target. Pick another camera above to inspect its view."
              : "Drag to aim. Position stays fixed."}
          </p>

          {!selectedUsesPointTarget && (
            <div className="mt-3 space-y-2.5">
              <div>
                <p className="flex items-center justify-between text-[11px] font-medium text-neutral-600">
                  <span>Yaw · left / right</span>
                  <span className="font-mono text-[10px] tabular-nums text-[#4a4eb3]">
                    {Math.round(aim.yaw)}°
                  </span>
                </p>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <CameraAimButton
                    label="← Left"
                    disabled={disabled}
                    onClick={() => nudgeAim(-5, 0)}
                  />
                  <CameraAimButton
                    label="Right →"
                    disabled={disabled}
                    onClick={() => nudgeAim(5, 0)}
                  />
                </div>
              </div>
              <div>
                <p className="flex items-center justify-between text-[11px] font-medium text-neutral-600">
                  <span>Pitch · down / up</span>
                  <span className="font-mono text-[10px] tabular-nums text-[#4a4eb3]">
                    {Math.round(aim.pitch)}°
                  </span>
                </p>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <CameraAimButton
                    label="↓ Down"
                    disabled={disabled}
                    onClick={() => nudgeAim(0, -5)}
                  />
                  <CameraAimButton
                    label="Up ↑"
                    disabled={disabled}
                    onClick={() => nudgeAim(0, 5)}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div
          className={`mt-3 grid place-items-center rounded-lg border border-dashed border-black/10 bg-black/[0.02] px-8 text-center text-xs leading-5 text-neutral-400 ${aspectRatio === "9:16" ? "mx-auto w-[58%]" : "w-full"}`}
          style={{ aspectRatio: `${frameWidth} / ${frameHeight}` }}
        >
          Choose a point above to aim its camera.
        </div>
      )}
      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
          Camera behavior
        </p>
        <div
          role="group"
          aria-label="Camera behavior"
          className="mt-1.5 grid grid-cols-2 gap-1.5"
        >
          {CAMERA_DIRECTION_PRESETS.map((preset) => {
            const selected = directionMode === preset.mode;
            return (
              <button
                key={preset.mode}
                type="button"
                data-camera-direction-mode={preset.mode}
                aria-pressed={selected}
                title={preset.title}
                onClick={() => onDirectionModeChange(preset.mode)}
                className={`h-8 rounded-md border px-2 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b5fc7] active:translate-y-px ${
                  selected
                    ? "border-[#5b5fc7] bg-[#5b5fc7] text-neutral-900"
                    : "border-black/10 bg-black/[0.03] text-neutral-600 hover:border-black/25 hover:text-neutral-900"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        {directionMode !== "manual" && !isPointDirectionMode(directionMode) && (
          <p className="mt-1.5 text-[10px] leading-4 text-neutral-400">
            Adjusted cameras override this preset; the rest stay automatic.
          </p>
        )}
      </div>

      {pointDirectionMode && (
        <div className="mt-3 flex flex-col items-stretch gap-2 rounded-lg border border-[#f4b860]/25 bg-[#f4b860]/[0.06] p-2.5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-amber-700">
              {hasDirectionTarget ? "Target set in scene" : "Choose a target"}
            </p>
            <p className="mt-0.5 text-[10px] leading-4 text-neutral-400">
              Every camera points{" "}
              {directionMode === "look_at" ? "at" : "away from"} this spot with
              a level horizon.
            </p>
          </div>
          <button
            type="button"
            data-change-direction-target="true"
            onClick={onChooseDirectionTarget}
            className="h-8 shrink-0 rounded-md border border-[#f4b860]/35 bg-[#f4b860]/10 px-2.5 text-[11px] font-semibold text-amber-700 transition hover:bg-[#f4b860]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4b860] active:translate-y-px"
          >
            {hasDirectionTarget ? "Change point" : "Pick point in 3D"}
          </button>
        </div>
      )}

      {selectedPart && (
        <div
          data-part-look-at={selectedPart.hasLookAtTarget ? "set" : "unset"}
          className="mt-3 rounded-lg border border-black/10 bg-black/[0.03] p-2.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-neutral-700">
                Selected Part {selectedPart.number}
              </p>
              <p className="mt-0.5 text-[10px] leading-4 text-neutral-400">
                {selectedPart.hasLookAtTarget
                  ? "This part looks at its own scene point."
                  : pointDirectionMode
                    ? "The whole path currently uses the scene target."
                    : "This part uses the whole-path camera behavior."}
              </p>
            </div>
            {selectedPart.hasLookAtTarget && (
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-[#f4b860] shadow-[0_0_10px_rgba(244,184,96,0.65)]" />
            )}
          </div>
          {selectedPart.hasLookAtTarget ? (
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                data-change-part-look-at={selectedPart.number}
                onClick={() => onChoosePartDirectionTarget(selectedPart.id)}
                className="h-8 rounded-md border border-[#f4b860]/35 bg-[#f4b860]/10 px-2 text-[11px] font-semibold text-amber-700 transition hover:bg-[#f4b860]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4b860] active:translate-y-px"
              >
                Change point
              </button>
              <button
                type="button"
                data-remove-part-look-at={selectedPart.number}
                onClick={() => onRemovePartDirectionTarget(selectedPart.id)}
                className="h-8 rounded-md border border-black/10 px-2 text-[11px] font-semibold text-neutral-600 transition hover:border-black/25 hover:bg-black/5 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b5fc7] active:translate-y-px"
              >
                Remove
              </button>
            </div>
          ) : directionMode === "look_at" && hasDirectionTarget ? (
            <button
              type="button"
              data-limit-look-at-to-part={selectedPart.number}
              onClick={() => onLimitDirectionTargetToPart(selectedPart.id)}
              className="mt-2 h-8 w-full rounded-md border border-[#f4b860]/35 bg-[#f4b860]/10 px-2 text-[11px] font-semibold text-amber-700 transition hover:bg-[#f4b860]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4b860] active:translate-y-px"
            >
              Look here only for Part {selectedPart.number}
            </button>
          ) : (
            <button
              type="button"
              data-add-part-look-at={selectedPart.number}
              onClick={() => onChoosePartDirectionTarget(selectedPart.id)}
              className="mt-2 h-8 w-full rounded-md border border-[#f4b860]/35 bg-[#f4b860]/10 px-2 text-[11px] font-semibold text-amber-700 transition hover:bg-[#f4b860]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f4b860] active:translate-y-px"
            >
              Look at a point for Part {selectedPart.number}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function CameraAimButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-md border border-black/10 bg-black/[0.03] px-2 text-[11px] font-medium text-neutral-600 transition hover:border-black/25 hover:bg-black/5 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b5fc7] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-30"
    >
      {label}
    </button>
  );
}

type TrajectoryMap = {
  space: TrajectorySpace;
  worldPoints: TrajectoryPoint[];
};

function buildTrajectoryMap(scene: Scene): TrajectoryMap {
  const center = new THREE.Vector3(...scene.focus);
  const worldPoints: TrajectoryPoint[] = [];
  for (const cloud of scene.clouds) {
    const count = cloud.positions.length / 3;
    const step = Math.max(1, Math.floor(count / 600));
    for (let index = 0; index < count; index += step) {
      const point = Array.from(
        cloud.positions.subarray(index * 3, index * 3 + 3),
      ) as TrajectoryPoint;
      if (point.every(Number.isFinite)) worldPoints.push(point);
    }
  }

  const extents = worldPoints
    .map((point) => new THREE.Vector3(...point).distanceTo(center))
    .sort((a, b) => a - b);
  const sceneExtent = extents[Math.floor(extents.length * 0.95)] ?? 1;

  return {
    space: {
      center: scene.focus,
      radius: Math.max(1, sceneExtent * 1.35),
    },
    worldPoints,
  };
}

function TrajectoryDrawPad({
  points,
  referencePosition,
  segments,
  selectedSegmentId,
  path,
  view,
  space,
  previewing,
  addingPivot,
  closedLoop,
  allowBelowFloor,
  disabled,
  panelSizeIndex,
  onChange,
  onComplete,
  onSelectPart,
  onDeletePart,
  onApplyShape,
  onSmooth,
  onTogglePivot,
  onCloseLoop,
  onAllowBelowFloorChange,
  onClear,
  onPlay,
  onPanelSizeChange,
}: {
  points: readonly TrajectoryPoint[];
  referencePosition: TrajectoryPoint;
  segments: readonly TrajectorySegment[];
  selectedSegmentId: string | null;
  path: readonly TrajectoryPoint[];
  view: TrajectoryDrawingView;
  space: TrajectorySpace;
  previewing: boolean;
  addingPivot: boolean;
  closedLoop: boolean;
  allowBelowFloor: boolean;
  disabled: boolean;
  panelSizeIndex: number;
  onChange: (segments: TrajectorySegment[]) => void;
  onComplete: (segments: TrajectorySegment[]) => void;
  onSelectPart: (id: string) => void;
  onDeletePart: (id: string) => void;
  onApplyShape: (shape: TrajectoryShape, segmentId: string | null) => void;
  onSmooth: () => void;
  onTogglePivot: () => void;
  onCloseLoop: () => void;
  onAllowBelowFloorChange: (allowBelowFloor: boolean) => void;
  onClear: () => void;
  onPlay: () => void;
  onPanelSizeChange: (index: number) => void;
}) {
  const [frozenView, setFrozenView] = useState<TrajectoryDrawingView | null>(
    null,
  );
  const [frozenSpace, setFrozenSpace] = useState<TrajectorySpace | null>(null);
  const [shapeScope, setShapeScope] = useState<"selected" | "whole">(
    "selected",
  );
  const draft = useRef<DrawPoint[]>([]);
  const draftDistance = useRef(0);
  const previousSegments = useRef<TrajectorySegment[]>([]);
  const previousPath = useRef<TrajectoryPoint[]>([]);
  const publishedSegments = useRef<TrajectorySegment[]>([]);
  const published = useRef(false);
  const pointerId = useRef<number | null>(null);
  const pointerOrigin = useRef<DrawPoint>([0, 0]);
  const screenOrigin = useRef<DrawPoint>([0, 0]);
  const activePartId = useRef("");
  const nextPartId = useRef(1);
  const strokeView = useRef<TrajectoryDrawingView>(view);
  const strokeSpace = useRef<TrajectorySpace>(space);
  const strokeFloorBoundary = useRef<[DrawPoint, DrawPoint] | null>(null);
  const displayView = frozenView ?? view;
  const drawingSpace = useMemo(
    () =>
      frameTrajectorySpaceAboveFloor(
        space,
        displayView,
        path.at(-1) ?? referencePosition,
        allowBelowFloor,
      ),
    [allowBelowFloor, displayView, path, referencePosition, space],
  );
  const displaySpace = frozenSpace ?? drawingSpace;
  const panelSize = DRAWING_PANEL_SIZES[panelSizeIndex]!;
  const selectedPartIndex = segments.findIndex(
    (segment) => segment.id === selectedSegmentId,
  );
  const effectiveShapeScope =
    shapeScope === "selected" && selectedPartIndex >= 0 ? "selected" : "whole";
  const shapePointCount =
    effectiveShapeScope === "selected"
      ? segments[selectedPartIndex]!.points.length
      : path.length;

  const projectedPoints = useMemo(
    () =>
      points
        .map((point) =>
          projectTrajectoryPoint(point, displayView, displaySpace),
        )
        .filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1),
    [displaySpace, displayView, points],
  );
  const referencePoint = projectTrajectoryPoint(
    referencePosition,
    displayView,
    displaySpace,
  );
  const projectedPath = path.map((point) =>
    projectTrajectoryPoint(point, displayView, displaySpace),
  );
  const displayedPath =
    closedLoop && projectedPath.length >= 3
      ? [...projectedPath, projectedPath[0]!]
      : projectedPath;
  const projectedPartEnds = segments.map((segment) =>
    projectTrajectoryPoint(segment.points.at(-1)!, displayView, displaySpace),
  );
  const floorBoundary = trajectoryFloorBoundary(
    displayView,
    displaySpace,
    path.at(-1) ?? referencePosition,
  );

  function pointerFromEvent(
    event: ReactPointerEvent<SVGSVGElement>,
  ): DrawPoint {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [
      (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height,
    ];
  }

  function clampDrawPoint(
    point: DrawPoint,
    boundary: [DrawPoint, DrawPoint] | null,
    drawingView: TrajectoryDrawingView,
  ): DrawPoint {
    const x = THREE.MathUtils.clamp(point[0], 0, 1);
    let y = THREE.MathUtils.clamp(point[1], 0, 1);
    if (boundary) {
      const floorY = THREE.MathUtils.lerp(boundary[0][1], boundary[1][1], x);
      y = drawingView.up[1] >= 0 ? Math.min(y, floorY) : Math.max(y, floorY);
    }
    return [x, THREE.MathUtils.clamp(y, 0, 1)];
  }

  function startPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (
      disabled ||
      addingPivot ||
      event.button !== 0 ||
      pointerId.current !== null
    )
      return;
    const pointer = pointerFromEvent(event);
    startDrawing(event, pointer);
  }

  function startDrawing(
    event: ReactPointerEvent<SVGSVGElement>,
    pointer: DrawPoint,
  ) {
    const endpoint = projectedPath.at(-1);
    const anchor = path.at(-1) ?? referencePosition;
    const activeView = displayView;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerId.current = event.pointerId;
    previousSegments.current = [...segments];
    previousPath.current = [...path];
    publishedSegments.current = [...segments];
    pointerOrigin.current = pointer;
    strokeView.current = activeView;
    strokeSpace.current = displaySpace;
    strokeFloorBoundary.current = trajectoryFloorBoundary(
      activeView,
      displaySpace,
      anchor,
    );
    if (allowBelowFloor) strokeFloorBoundary.current = null;
    screenOrigin.current =
      endpoint ??
      clampDrawPoint(pointer, strokeFloorBoundary.current, activeView);
    draft.current = [screenOrigin.current];
    draftDistance.current = 0;
    do {
      activePartId.current = `part-${nextPartId.current++}`;
    } while (segments.some((segment) => segment.id === activePartId.current));
    published.current = false;
    setFrozenView(activeView);
    setFrozenSpace(displaySpace);
  }

  function continueDrawing(event: ReactPointerEvent<SVGSVGElement>) {
    if (pointerId.current !== event.pointerId) return;
    const pointer = pointerFromEvent(event);
    const point = clampDrawPoint(
      [
        screenOrigin.current[0] + pointer[0] - pointerOrigin.current[0],
        screenOrigin.current[1] + pointer[1] - pointerOrigin.current[1],
      ],
      strokeFloorBoundary.current,
      strokeView.current,
    );
    const previous = draft.current.at(-1)!;
    const segmentLength = Math.hypot(
      point[0] - previous[0],
      point[1] - previous[1],
    );
    if (segmentLength < 0.012) return;
    draft.current = [...draft.current, point];
    draftDistance.current += segmentLength;
    if (draftDistance.current >= 0.02) {
      const nextPath = appendDrawnTrajectory(
        previousPath.current,
        draft.current,
        strokeView.current,
        strokeSpace.current,
        referencePosition,
        allowBelowFloor,
      );
      const addedPoints = nextPath.slice(previousPath.current.length);
      if (addedPoints.length === 0) return;
      const partPoints = previousPath.current.length
        ? [previousPath.current.at(-1)!, ...addedPoints]
        : addedPoints;
      const sharedQuaternion = previousSegments.current
        .at(-1)
        ?.quaternions?.at(-1);
      const quaternions = sharedQuaternion
        ? partPoints.map((_, index) => (index === 0 ? sharedQuaternion : null))
        : undefined;
      published.current = true;
      publishedSegments.current = [
        ...previousSegments.current,
        { id: activePartId.current, points: partPoints, quaternions },
      ];
      onChange(publishedSegments.current);
    }
  }

  function continuePointer(event: ReactPointerEvent<SVGSVGElement>) {
    continueDrawing(event);
  }

  function finishPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    if (published.current) onComplete(publishedSegments.current);
    draft.current = [];
    draftDistance.current = 0;
    published.current = false;
    setFrozenView(null);
    setFrozenSpace(null);
  }

  function cancelPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    if (published.current) onChange(previousSegments.current);
    draft.current = [];
    draftDistance.current = 0;
    published.current = false;
    setFrozenView(null);
    setFrozenSpace(null);
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Rotate3D className="h-3.5 w-3.5 text-neutral-500" />
          <h2 className="text-sm font-semibold text-neutral-900">
            Draw new path
          </h2>
        </div>
        <div
          className="flex h-7 items-center overflow-hidden rounded-md border border-black/10 bg-black/[0.03]"
          aria-label="Drawing panel size"
        >
          <button
            type="button"
            disabled={panelSizeIndex === 0}
            onClick={() => onPanelSizeChange(Math.max(0, panelSizeIndex - 1))}
            aria-label="Make drawing panel smaller"
            title="Make drawing panel smaller"
            className="grid h-full w-7 place-items-center text-neutral-600 transition hover:bg-black/5 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black/60 disabled:opacity-25"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onPanelSizeChange(DEFAULT_DRAWING_PANEL_SIZE_INDEX)}
            aria-label={`Reset drawing panel size from ${panelSize.label} to Medium`}
            title="Reset drawing panel size"
            className="h-full min-w-14 border-x border-black/10 px-1.5 text-[10px] font-semibold text-neutral-800 transition hover:bg-black/5 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black/60"
          >
            {panelSize.label}
          </button>
          <button
            type="button"
            disabled={panelSizeIndex === DRAWING_PANEL_SIZES.length - 1}
            onClick={() =>
              onPanelSizeChange(
                Math.min(DRAWING_PANEL_SIZES.length - 1, panelSizeIndex + 1),
              )
            }
            aria-label="Make drawing panel larger"
            title="Make drawing panel larger"
            className="grid h-full w-7 place-items-center text-neutral-600 transition hover:bg-black/5 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black/60 disabled:opacity-25"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <p className="mb-2 text-[10px] leading-4 text-neutral-500">
        {addingPivot
          ? "Click the blue path in the main 3D view."
          : "Larger panel = finer moves. Every point-to-point section gets equal video time."}
      </p>

      <button
        type="button"
        role="switch"
        aria-checked={allowBelowFloor}
        data-allow-below-floor={allowBelowFloor}
        disabled={disabled}
        onClick={() => onAllowBelowFloorChange(!allowBelowFloor)}
        className={`mb-2 flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b5fc7] disabled:opacity-30 ${
          allowBelowFloor
            ? "border-[#66c7e8]/45 bg-[#66c7e8]/10"
            : "border-black/10 bg-black/[0.02] hover:border-black/20 hover:bg-black/5"
        }`}
      >
        <span>
          <span className="block text-[11px] font-semibold text-neutral-800">
            Allow below y = 0
          </span>
          <span className="mt-0.5 block text-[9px] leading-3.5 text-neutral-400">
            y = 0 is the ground at the photo spot. The terrain is checked in the
            request review.
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`relative h-5 w-9 shrink-0 rounded-full transition ${
            allowBelowFloor ? "bg-[#66c7e8]" : "bg-black/10"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              allowBelowFloor ? "translate-x-[1.125rem]" : "translate-x-0.5"
            }`}
          />
        </span>
      </button>

      <div className="relative aspect-square overflow-hidden rounded-lg border border-black/10 bg-[#f1f1ef]">
        <svg
          viewBox="0 0 100 100"
          role="application"
          aria-label="Draw camera path from the current 3D view"
          aria-disabled={disabled || addingPivot}
          className={`h-full w-full touch-none cursor-crosshair select-none ${disabled || addingPivot ? "pointer-events-none opacity-40" : ""}`}
          onPointerDown={startPointer}
          onPointerMove={continuePointer}
          onPointerUp={finishPointer}
          onPointerCancel={cancelPointer}
        >
          {floorBoundary && (
            <>
              {!allowBelowFloor && (
                <polygon
                  points={
                    displayView.up[1] >= 0
                      ? `${floorBoundary[0][0] * 100},${floorBoundary[0][1] * 100} ${floorBoundary[1][0] * 100},${floorBoundary[1][1] * 100} 100,100 0,100`
                      : `0,0 100,0 ${floorBoundary[1][0] * 100},${floorBoundary[1][1] * 100} ${floorBoundary[0][0] * 100},${floorBoundary[0][1] * 100}`
                  }
                  fill="rgba(244, 184, 96, 0.07)"
                />
              )}
              <line
                data-trajectory-floor="true"
                x1={floorBoundary[0][0] * 100}
                x2={floorBoundary[1][0] * 100}
                y1={floorBoundary[0][1] * 100}
                y2={floorBoundary[1][1] * 100}
                stroke={
                  allowBelowFloor
                    ? "rgba(102, 199, 232, 0.55)"
                    : "rgba(244, 184, 96, 0.8)"
                }
                strokeWidth="0.7"
                strokeDasharray="2 1.5"
              />
              <text
                x="97"
                y={THREE.MathUtils.clamp(
                  floorBoundary[1][1] * 100 - 1.5,
                  4,
                  96,
                )}
                textAnchor="end"
                fill={
                  allowBelowFloor
                    ? "rgba(102, 199, 232, 0.8)"
                    : "rgba(244, 184, 96, 0.85)"
                }
                fontSize="3.2"
                fontWeight="600"
              >
                {allowBelowFloor
                  ? "FLOOR - CROSSING ALLOWED"
                  : "FLOOR - LOCKED"}
              </text>
            </>
          )}
          <path
            d="M25 0V100M50 0V100M75 0V100M0 25H100M0 50H100M0 75H100"
            stroke="rgba(0,0,0,0.06)"
            strokeWidth="0.45"
          />
          {projectedPoints.map(([x, y], index) => (
            <circle
              key={index}
              cx={x * 100}
              cy={y * 100}
              r="0.45"
              fill="rgba(0,0,0,0.3)"
            />
          ))}
          <circle
            cx={referencePoint[0] * 100}
            cy={referencePoint[1] * 100}
            r="1.8"
            fill="#f4b860"
            stroke="#ffffff"
            strokeWidth="0.8"
          />
          {displayedPath.length >= 2 && (
            <>
              <polyline
                points={displayedPath
                  .map(([x, y]) => `${x * 100},${y * 100}`)
                  .join(" ")}
                fill="none"
                stroke="#5b5fc7"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle
                cx={projectedPath[0]![0] * 100}
                cy={projectedPath[0]![1] * 100}
                r="2.2"
                fill="#1f2937"
              />
              <circle
                cx={projectedPath.at(-1)![0] * 100}
                cy={projectedPath.at(-1)![1] * 100}
                r="2.2"
                fill="#5b5fc7"
              />
              <circle
                cx={projectedPath.at(-1)![0] * 100}
                cy={projectedPath.at(-1)![1] * 100}
                r="4.5"
                fill="none"
                stroke="rgba(169,188,255,0.7)"
                strokeWidth="0.8"
              />
              {projectedPartEnds.map(([x, y], index) => (
                <g key={segments[index]!.id} pointerEvents="none">
                  <circle
                    cx={x * 100}
                    cy={y * 100}
                    r="2.5"
                    fill={index === segments.length - 1 ? "#5b5fc7" : "#15171c"}
                    stroke="#5b5fc7"
                    strokeWidth="0.7"
                  />
                  <text
                    x={x * 100}
                    y={y * 100 + 1}
                    textAnchor="middle"
                    fill={index === segments.length - 1 ? "#10131c" : "#f7f5ef"}
                    fontSize="2.8"
                    fontWeight="700"
                  >
                    {index + 1}
                  </text>
                </g>
              ))}
            </>
          )}
        </svg>

        {path.length < 2 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="rounded-md border border-black/15 bg-white/90 px-3 py-2 text-xs font-semibold text-neutral-900 shadow-xl">
              DRAG TO DRAW
            </span>
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={path.length < 2}
        onClick={onTogglePivot}
        className={`mt-2 flex h-10 w-full items-center justify-center gap-2 rounded border text-xs font-semibold transition disabled:opacity-25 ${
          addingPivot
            ? "border-[#5b5fc7] bg-[#5b5fc7] text-neutral-900"
            : "border-[#5b5fc7]/40 bg-[#5b5fc7]/10 text-[#d8e1ff] hover:bg-[#5b5fc7]/20"
        }`}
      >
        <Plus className="h-3.5 w-3.5" />
        {addingPivot ? "Click the blue path in 3D" : "Add pivot on path"}
      </button>

      <button
        type="button"
        onClick={onSmooth}
        disabled={disabled || addingPivot || path.length < 3}
        title="Soften bends in the camera path while keeping camera aim and timing"
        className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded border border-black/10 bg-black/[0.03] text-xs font-semibold text-neutral-700 transition hover:border-[#5b5fc7]/45 hover:bg-[#5b5fc7]/10 hover:text-neutral-900 disabled:opacity-35"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Smooth path
      </button>
      <button
        type="button"
        data-close-camera-loop="true"
        disabled={disabled || addingPivot || path.length < 3 || closedLoop}
        onClick={onCloseLoop}
        className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded border border-black/10 bg-black/[0.03] text-xs font-semibold text-neutral-700 transition hover:border-[#5b5fc7]/45 hover:bg-[#5b5fc7]/10 hover:text-neutral-900 disabled:opacity-35"
      >
        <Rotate3D className="h-3.5 w-3.5" />
        {closedLoop ? "Loop closed" : "Close loop"}
      </button>

      {segments.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
            Parts
          </span>
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex w-max gap-1">
              {segments.map((segment, index) => (
                <div
                  key={segment.id}
                  className={`flex h-7 overflow-hidden rounded border text-[10px] font-semibold transition ${
                    segment.id === selectedSegmentId
                      ? "border-[#5b5fc7]/60 bg-[#5b5fc7]/15 text-neutral-900"
                      : "border-black/10 bg-black/[0.03] text-neutral-700"
                  }`}
                >
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onSelectPart(segment.id)}
                    className="px-2 transition hover:bg-black/5 disabled:opacity-30"
                    aria-label={`Edit path part ${index + 1}`}
                  >
                    {index + 1}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onDeletePart(segment.id)}
                    aria-label={`Delete path part ${index + 1}`}
                    className="border-l border-current/15 px-1.5 transition hover:bg-red-400/15 hover:text-red-700 disabled:opacity-30"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {path.length >= 2 && (
        <details
          data-path-shape-panel="true"
          className="group mt-2 rounded-lg border border-black/10 bg-black/[0.02]"
        >
          <summary className="flex h-9 cursor-pointer list-none items-center justify-between px-2.5 text-xs font-semibold text-neutral-700 transition hover:bg-black/5 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#5b5fc7] [&::-webkit-details-marker]:hidden">
            <span>Shape path</span>
            <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-black/10 p-2.5">
            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
              Apply to
            </p>
            <div
              role="group"
              aria-label="Apply path shape to"
              className="mt-1.5 grid grid-cols-2 gap-1.5"
            >
              <button
                type="button"
                data-path-shape-scope="selected"
                aria-pressed={effectiveShapeScope === "selected"}
                disabled={selectedPartIndex < 0}
                onClick={() => setShapeScope("selected")}
                className={`h-8 rounded-md border px-2 text-[10px] font-semibold transition disabled:opacity-30 ${
                  effectiveShapeScope === "selected"
                    ? "border-[#5b5fc7] bg-[#5b5fc7] text-neutral-900"
                    : "border-black/10 text-neutral-600 hover:border-black/25 hover:text-neutral-900"
                }`}
              >
                {selectedPartIndex >= 0
                  ? `Selected part ${selectedPartIndex + 1}`
                  : "Selected part"}
              </button>
              <button
                type="button"
                data-path-shape-scope="whole"
                aria-pressed={effectiveShapeScope === "whole"}
                onClick={() => setShapeScope("whole")}
                className={`h-8 rounded-md border px-2 text-[10px] font-semibold transition ${
                  effectiveShapeScope === "whole"
                    ? "border-[#5b5fc7] bg-[#5b5fc7] text-neutral-900"
                    : "border-black/10 text-neutral-600 hover:border-black/25 hover:text-neutral-900"
                }`}
              >
                Whole path
              </button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {(
                [
                  ["straighten", "Straighten"],
                  ["circular", "Make circular"],
                  ["flatten", "Flatten"],
                ] as const
              ).map(([shape, label]) => (
                <button
                  key={shape}
                  type="button"
                  data-path-shape-action={shape}
                  disabled={
                    disabled ||
                    addingPivot ||
                    shapePointCount < 3 ||
                    (shape === "straighten" &&
                      effectiveShapeScope === "whole" &&
                      closedLoop)
                  }
                  title={
                    shape === "straighten"
                      ? "Place pivots evenly on a line between the endpoints"
                      : shape === "circular"
                        ? "Arrange pivots on a circular arc; closed loops become a full circle"
                        : "Place pivots on the plane facing the current 3D view"
                  }
                  onClick={() =>
                    onApplyShape(
                      shape,
                      effectiveShapeScope === "selected"
                        ? selectedSegmentId
                        : null,
                    )
                  }
                  className="min-h-9 rounded-md border border-black/10 bg-black/[0.03] px-1.5 text-[10px] font-semibold leading-3 text-neutral-600 transition hover:border-[#5b5fc7]/45 hover:bg-[#5b5fc7]/10 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b5fc7] disabled:cursor-not-allowed disabled:opacity-25"
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[9px] leading-3.5 text-neutral-400">
              Circular and Flatten use the current 3D view. Camera aim and
              timing stay unchanged.
            </p>
          </div>
        </details>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled || path.length === 0}
          onClick={onClear}
          className="flex h-9 items-center justify-center gap-1.5 rounded border border-black/10 text-xs font-semibold text-neutral-600 transition hover:bg-black/5 hover:text-neutral-900 disabled:opacity-25"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clear path
        </button>
        <button
          type="button"
          disabled={path.length < 2}
          onClick={onPlay}
          className="flex h-9 items-center justify-center gap-1.5 rounded bg-[#5b5fc7] text-xs font-semibold text-[#10131c] transition hover:bg-[#4a4eb3] disabled:opacity-25"
        >
          {previewing ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {previewing ? "Stop" : "Play path"}
        </button>
      </div>
    </section>
  );
}

function OutputNumberInput({
  label,
  value,
  min,
  max,
  step = 1,
  title,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  title?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    const parsed = Number(draft);
    const precision = Math.max(0, (String(step).split(".")[1] ?? "").length);
    const rounded = Number(
      (Math.round(parsed / step) * step).toFixed(precision),
    );
    const nextValue =
      draft && Number.isFinite(parsed)
        ? THREE.MathUtils.clamp(rounded, min, max)
        : value;
    setDraft(String(nextValue));
    if (nextValue !== value) onChange(nextValue);
  }

  return (
    <label className="w-20 shrink-0" title={title}>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
        {label}
      </span>
      <input
        type="text"
        inputMode={step < 1 ? "decimal" : "numeric"}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          const pattern = step < 1 ? /^\d*\.?\d*$/ : /^\d*$/;
          if (pattern.test(event.target.value)) setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
        className="h-11 w-full rounded-md border border-black/10 bg-black/[0.04] px-3 text-sm font-semibold text-neutral-900 outline-none transition hover:border-black/25 focus:border-[#5b5fc7] focus:ring-2 focus:ring-[#5b5fc7]/20 disabled:opacity-40"
      />
    </label>
  );
}
