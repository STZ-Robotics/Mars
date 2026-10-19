// The Paths tab's 3D view: the field as a match sees it, beside the 2D editor.
//
// The robot drives the trajectory (the playhead, or stands on the selected waypoint), its fixed
// cameras' frustums and sight lines in Limelight green, each AprilTag drawn with its real
// tag36h11 pattern, the field's structures, and an inset with what one camera actually sees,
// rendered from its lens. No physics: the robot is where the trajectory says (that is Gazebo's
// job, from the files Ares exports). Everything is in WPILib's frame: Z up, X toward red.

import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CatmullRomCurve3, CircleGeometry, TubeGeometry, Color, ConeGeometry, CylinderGeometry, TorusGeometry, DoubleSide, EdgesGeometry, Float32BufferAttribute, Group, Line,
  LineBasicMaterial, LineDashedMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, NearestFilter, Object3D,
  PerspectiveCamera, Plane, PlaneGeometry, Quaternion, Raycaster, Scene, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from "three"
import type { FieldConfig } from "@desktop/utils/field/fieldImages"
import { addStandardLights, makeOrbitControls } from "@desktop/components/dashboard/three/sceneKit"
import { composeRotations, parseAssetConfig } from "@desktop/utils/field3d/assetConfig"
import { disposeAssetInstance, instantiateAsset, loadAssetModel, OPTIMIZE_PRESETS } from "@desktop/utils/field3d/assetModels"
import { disposeInstance, instantiateModel, loadModel } from "@desktop/utils/field/robotModel"
import type { RobotConfig } from "../robot/types"
import { placeModel } from "../robot/RobotTurntable"
import { cameraPose, detections, LIMELIGHT_GREEN, rangeOf, World } from "../vision/vision"
import { TOTAL_WIDTH, tag36h11 } from "../vision/tag36h11"
import { COLORS, drawFieldBackground, rotationAt, rotationPoint, ZONE, type Decal, type DecalLabel } from "./FieldView"
import { modelTurn } from "./field3dAlign"
import { useToast } from "../ui/toasts"
import {
  ALLIANCE_COLOR, allianceOf, allianceHint, kindOf, type KeepOut, type PathSpec, type ScopedConstraint, type Selection, type SlowZone, type Tool,
  type Trajectory, type ViewOptions,
} from "./types"

interface Props {
  field: FieldConfig
  robot: RobotConfig
  robotPath: string
  world: World
  /** The trajectory drawn on the carpet. */
  traj: Trajectory | null
  /** Where the robot is: (x, y, heading). */
  pose: [number, number, number] | null
  /** The path, for whose alliance it is and for editing it on the carpet. */
  spec: PathSpec | null
  view: ViewOptions
  /** The 2D editor's drawing in the field's frame, laid on the carpet: the same paths, waypoints,
   * constraints and vision map, with depth around them. */
  decal: Decal | null
  tool: Tool
  /** The same handlers as the 2D editor's, so a waypoint moved here obeys the same rules. */
  onSelect: (s: Selection) => void
  onMoveWaypoint: (i: number, x: number, y: number, final: boolean) => void
  onFieldClick: (x: number, y: number) => void
  onWaypointClick: (i: number) => void
  /** What is selected: a selected waypoint carries the gizmo (move along X, Y, free, and turn). */
  selected: Selection
  onRotateWaypoint: (i: number, headingDeg: number, final: boolean) => void
  /** The rest of what the 2D editor edits, with its handlers: keep-outs, slow zones, the constraints'
   * shapes and the rotation targets. */
  keepOut: KeepOut[]
  zones: SlowZone[]
  onMoveKeepOut: (i: number, x: number, y: number, final: boolean) => void
  onResizeKeepOut: (i: number, r: number, final: boolean) => void
  onAddZone: (z: SlowZone) => void
  onEditZone: (i: number, patch: Partial<SlowZone>, final: boolean) => void
  onEditConstraint: (i: number, patch: Partial<ScopedConstraint>, final: boolean) => void
  onAddRotation: (segment: number, fraction: number, headingDeg: number) => void
  onEditRotation: (i: number, patch: { headingDeg: number }, final: boolean) => void
  /** A manual segment's control point dragged; `free` (Alt) breaks the tangent. */
  onMoveControl: (i: number, side: "prev" | "next", x: number, y: number, final: boolean, free: boolean) => void
}

/** The black square of a 6.5 in tag; its whole picture (white border included) is 10/8 of it. */
const TAG_BLACK_M = 0.1651
const BUMPER_HEIGHT = 0.13
/** Layer of what only the main view shows (the robot itself, its frustums): the inset hides it. */
const MAIN_ONLY = 1
type CameraMode = "orbit" | "follow" | "blue" | "red" | "lens"

export default function Field3DView(p: Props) {
  const host = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<{
    scene: Scene; renderer: WebGLRenderer; camera: PerspectiveCamera; inset: PerspectiveCamera; controls: ReturnType<typeof makeOrbitControls>
    field: Group; structures: Group; tags: Group; robot: Group; model: Group; overlay: Group; path: Group
    tagMeshes: Map<number, { outline: LineSegments }>
    handles: Group; gizmo: Gizmo; grid: Group; labels: Group; draft: Group
  } | null>(null)
  const decalRef = useRef<{ mesh: Mesh; texture: CanvasTexture; version: number; width: number } | null>(null)
  const propsRef = useRef(p)
  propsRef.current = p
  const [mode, setMode] = useState<CameraMode>("orbit")
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [insetCamera, setInsetCamera] = useState(0)
  const insetRef = useRef(insetCamera)
  insetRef.current = insetCamera
  const [showInset, setShowInset] = useState(true)
  const showInsetRef = useRef(showInset)
  showInsetRef.current = showInset
  // Locked: the camera holds still and a click only reaches what can be edited.
  const [locked, setLocked] = useState(() => remembered("ares.view3dLocked", false))
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const [grid, setGrid] = useState(() => remembered("ares.view3dGrid", true))
  const [fieldNote, setFieldNote] = useState<string | null>(null)
  const [seenNote, setSeenNote] = useState<string>("")
  const [L, W] = p.field.sizeMeters
  const toast = useToast()
  const [exporting, setExporting] = useState(false)

  /** The robot and the field as Gazebo reads them, into the project's ares/sim/. */
  const exportSim = async () => {
    setExporting(true)
    try {
      const pack = await invoke<{ folder: string; config: string } | null>("field3d_find", { year: p.field.key.slice(0, 4) }).catch(() => null)
      const config = pack ? parseAssetConfig(pack.config) : null
      // The field model's turn, as SDF's roll, pitch, yaw (fixed axes X, Y, Z).
      let rpy: [number, number, number] | null = null
      if (config && config.kind === "field") {
        const turn = modelTurn(config, p.world.tags, L, W)
        const [cw, cx, cy, cz] = composeRotations(config.rotations)
        // The turn about Z after the config's rotations: q = turn * config.
        const tw = Math.cos(turn / 2), tz = Math.sin(turn / 2)
        const [qw, qx, qy, qz] = [tw * cw - tz * cz, tw * cx - tz * cy, tw * cy + tz * cx, tw * cz + tz * cw]
        rpy = [
          Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy)),
          Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qy - qz * qx)))),
          Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)),
        ]
      }
      const first = p.traj?.samples[0]
      const out = await invoke<{ dir: string; files: string[] }>("sim_export", {
        robotPath: p.robotPath,
        request: {
          robot: p.robot, fieldLengthM: L, fieldWidthM: W, tags: p.world.tags, occluders: p.world.occluders,
          start: first ? [first.x, first.y, first.heading] : null,
          fieldModel: pack ? `${pack.folder}/model.glb` : null,
          fieldModelRpy: rpy,
        },
      })
      toast({ kind: "success", title: "Exported to Gazebo", body: `${out.dir}: robot.urdf, world.sdf and ${out.files.length - 3} AprilTags. Open world.sdf in MARS Simulation Studio, or run gz sim world.sdf.` })
    } catch (e) {
      toast({ kind: "error", title: "Could not export to Gazebo", body: String(e) })
    } finally {
      setExporting(false)
    }
  }

  // The scene, once.
  useEffect(() => {
    const el = host.current!
    const renderer = new WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = SRGBColorSpace
    el.appendChild(renderer.domElement)
    const scene = new Scene()
    scene.background = new Color(0x1b1d22)
    addStandardLights(scene)
    const camera = new PerspectiveCamera(45, 1, 0.05, 200)
    camera.up.set(0, 0, 1)
    camera.layers.enable(MAIN_ONLY)
    camera.position.set(L / 2 - 9, W / 2 - 7, 8)
    const controls = makeOrbitControls(camera, renderer.domElement, { minDistance: 0.6, maxDistance: 60 })
    controls.target.set(L / 2, W / 2, 0)
    const inset = new PerspectiveCamera(50, 1.4, 0.05, 30)
    const groups = ["field", "structures", "tags", "robot", "overlay", "path"].map(() => new Group())
    const [field, structures, tags, robot, overlay, path] = groups
    const model = new Group()
    robot.add(model)
    scene.add(...groups)
    const handles = new Group()
    const gizmo = makeGizmo()
    const gridGroup = new Group()
    const labels = new Group()
    const draft = new Group()
    scene.add(handles, gizmo.root, gridGroup, labels, draft)
    sceneRef.current = { scene, renderer, camera, inset, controls, field, structures, tags, robot, model, overlay, path, tagMeshes: new Map(), handles, gizmo, grid: gridGroup, labels, draft }
    let labelsVersion = -1

    let frame = 0
    const render = () => {
      frame = requestAnimationFrame(render)
      const w = el.clientWidth, h = el.clientHeight
      if (w === 0 || h === 0) return
      const size = renderer.getSize(new Vector2())
      if (size.x !== w || size.y !== h) {
        renderer.setSize(w, h)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      // Follow: the camera keeps its offset from the robot.
      if (modeRef.current === "follow") {
        const r = robot.position
        const offset = camera.position.clone().sub(controls.target)
        controls.target.copy(r)
        camera.position.copy(r).add(offset)
      }
      // The 2D drawing on the carpet, uploaded only when it changed.
      const d = propsRef.current.decal
      if (d && d.canvas.width > 0) {
        let dm = decalRef.current
        if (!dm || dm.width !== d.canvas.width) {
          if (dm) { scene.remove(dm.mesh); dm.texture.dispose() }
          const texture = new CanvasTexture(d.canvas)
          texture.colorSpace = SRGBColorSpace
          const mesh = new Mesh(new PlaneGeometry(L, W), new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }))
          mesh.position.set(L / 2, W / 2, 0.015)
          mesh.renderOrder = 2
          mesh.layers.set(MAIN_ONLY)
          scene.add(mesh)
          dm = decalRef.current = { mesh, texture, version: -1, width: d.canvas.width }
        }
        if (dm.version !== d.version) {
          dm.texture.needsUpdate = true
          dm.version = d.version
        }
      }
      // The gizmo, the knobs and the labels keep their size on screen: bigger in meters the farther the camera is.
      const reach = (v: Vector3) => Math.min(2.6, Math.max(0.45, camera.position.distanceTo(v) / 10))
      if (gizmo.root.visible) gizmo.root.scale.setScalar(reach(gizmo.root.position))
      handles.traverse(o => {
        if (!o.userData.knob) return
        const f = reach(o.position) * (o.userData.hover ? 1.25 : 1)
        o.scale.setScalar(f)
      })
      if (d && d.version !== labelsVersion) {
        labelsVersion = d.version
        buildLabels(labels, d.labels, propsRef.current.spec)
      }
      placeLabels(labels, camera)
      controls.update()
      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, w, h)
      const lens = modeRef.current === "lens" && (propsRef.current.robot.cameras ?? []).length > 0 && propsRef.current.pose
      if (lens) {
        // The whole view from the camera's lens, at the window's shape.
        const keep = inset.aspect
        inset.aspect = w / h
        inset.updateProjectionMatrix()
        renderer.render(scene, inset)
        inset.aspect = keep
        inset.updateProjectionMatrix()
        return
      }
      renderer.render(scene, camera)
      // The inset: what the chosen camera sees, from its lens.
      const cams = propsRef.current.robot.cameras ?? []
      const c = cams[Math.min(insetRef.current, cams.length - 1)]
      if (c && propsRef.current.pose && showInsetRef.current) {
        const iw = Math.min(360, Math.round(w * 0.42))
        const ih = Math.round(iw / inset.aspect)
        renderer.setScissorTest(true)
        renderer.setScissor(w - iw - 10, 10, iw, ih)
        renderer.setViewport(w - iw - 10, 10, iw, ih)
        renderer.render(scene, inset)
        renderer.setScissorTest(false)
      }
    }
    render()
    const ro = new ResizeObserver(() => { /* sized each frame */ })
    ro.observe(el)

    // Editing on the carpet. What can be edited has a handle: the selected waypoint's gizmo, the
    // waypoints' pucks, knobs on the keep-outs, slow zones and constraint shapes, the rotation
    // targets' arrows, and the floating labels (a click selects what they name). A handle grabbed
    // is dragged with the camera still; a press elsewhere is the tool's, or the camera's.
    const ray = new Raycaster()
    ray.layers.enableAll()
    const pointerAt = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect()
      return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    }
    const ground = (e: PointerEvent): [number, number] | null => {
      ray.setFromCamera(pointerAt(e), camera)
      const hit = ray.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), new Vector3())
      return hit ? [hit.x, hit.y] : null
    }
    const selectedIndex = () => {
      const s = propsRef.current.selected
      return s?.kind === "waypoint" ? s.index : -1
    }
    /** The handle under the pointer. The gizmo is drawn over everything, so it wins; then the knobs; then the labels. */
    const pick = (e: PointerEvent): { grip: Grip; object: Object3D } | null => {
      ray.setFromCamera(pointerAt(e), camera)
      const g = ray.intersectObject(gizmo.root, true).find(h => shown(h.object) && h.object.userData.part)
      if (g && selectedIndex() >= 0) return { grip: { kind: "wp", index: selectedIndex(), part: g.object.userData.part }, object: g.object }
      for (const group of [handles, labels]) {
        const hit = ray.intersectObject(group, true).find(h => shown(h.object) && h.object.userData.grip)
        if (hit) return { grip: hit.object.userData.grip, object: hit.object }
      }
      return null
    }
    const waypointNear = (g: [number, number]): number => {
      const spec = propsRef.current.spec
      if (!spec) return -1
      let best = -1, bd = 0.45
      spec.waypoints.forEach((w, i) => {
        if (kindOf(w) === "unknown") return
        const d = Math.hypot(w.x - g[0], w.y - g[1])
        if (d < bd) { bd = d; best = i }
      })
      return best
    }

    let drag: Drag3 | null = null
    let down: { x: number; y: number } | null = null
    const begin = (e: PointerEvent, d: Drag3) => {
      drag = d
      controls.enabled = false
      // The orbit controls must not see this press: it edits, it does not move the camera.
      e.stopImmediatePropagation()
      renderer.domElement.setPointerCapture(e.pointerId)
      renderer.domElement.style.cursor = "grabbing"
    }
    /** Where the grabbed thing was, so a drag moves it by how much the pointer moved (no jump). */
    const originOf = (grip: Grip): [number, number] => {
      const P = propsRef.current
      const at = (o: { x: number; y: number } | undefined): [number, number] => (o ? [o.x, o.y] : [0, 0])
      switch (grip.kind) {
        case "wp": return at(P.spec?.waypoints[grip.index])
        case "keepout": return at(P.keepOut[grip.index])
        case "zone": return at(P.zones[grip.index])
        case "shape": { const c = P.spec?.scoped[grip.index]; return c && "x" in c ? [c.x, c.y] : [0, 0] }
        case "control": { const w = P.spec?.waypoints[grip.index]; return (grip.side === "next" ? w?.nextControl : w?.prevControl) ?? [0, 0] }
        default: return [0, 0]
      }
    }
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    const turnTo = (from: { x: number; y: number }, g: [number, number], snap: boolean) => {
      const deg = (Math.atan2(g[1] - from.y, g[0] - from.x) * 180) / Math.PI
      return snap ? Math.round(deg / 15) * 15 : Math.round(deg * 10) / 10
    }
    /** The drag at the pointer `g`: what the 2D editor does with the same handle. */
    const apply = (d: Drag3, g: [number, number], final: boolean) => {
      const P = propsRef.current
      const x = r3(d.from[0] + g[0] - d.at[0]), y = r3(d.from[1] + g[1] - d.at[1])
      if (d.kind === "zoneNew") {
        const w = Math.abs(g[0] - d.at[0]), h = Math.abs(g[1] - d.at[1])
        drawDraft(sceneRef.current!.draft, d.at, g, final)
        if (final) {
          // A click (no drag) makes a 1 m circle; a drag, the rectangle drawn.
          P.onAddZone(w < 0.15 && h < 0.15
            ? { shape: "circle", x: r3(d.at[0]), y: r3(d.at[1]), radiusM: 1, maxVelocityMps: 1.5 }
            : { shape: "rectangle", x: r3(Math.min(d.at[0], g[0])), y: r3(Math.min(d.at[1], g[1])), widthM: r3(w), heightM: r3(h), maxVelocityMps: 1.5 })
        }
        return
      }
      const grip = d.grip
      switch (grip.kind) {
        case "wp": {
          const w = P.spec?.waypoints[grip.index]
          if (!w) return
          if (grip.part === "rot") P.onRotateWaypoint(grip.index, turnTo(w, g, d.shift), final)
          else P.onMoveWaypoint(grip.index, grip.part === "y" ? d.from[0] : x, grip.part === "x" ? d.from[1] : y, final)
          return
        }
        case "keepout": {
          const c = P.keepOut[grip.index]
          if (!c) return
          if (grip.part === "move") P.onMoveKeepOut(grip.index, x, y, final)
          else P.onResizeKeepOut(grip.index, Math.max(0.05, r3(Math.hypot(g[0] - c.x, g[1] - c.y))), final)
          return
        }
        case "zone": {
          const z = P.zones[grip.index]
          if (!z) return
          if (grip.part === "move") P.onEditZone(grip.index, { x, y }, final)
          else if (z.shape === "circle") P.onEditZone(grip.index, { radiusM: Math.max(0.1, r3(Math.hypot(g[0] - z.x, g[1] - z.y))) } as Partial<SlowZone>, final)
          else P.onEditZone(grip.index, { widthM: Math.max(0.1, r3(g[0] - z.x)), heightM: Math.max(0.1, r3(g[1] - z.y)) } as Partial<SlowZone>, final)
          return
        }
        case "shape": {
          const c = P.spec?.scoped[grip.index]
          if (!c || !("x" in c)) return
          if (grip.part === "move") P.onEditConstraint(grip.index, { x, y } as Partial<ScopedConstraint>, final)
          else if ("radiusM" in c) P.onEditConstraint(grip.index, { radiusM: Math.max(0.05, r3(Math.hypot(g[0] - c.x, g[1] - c.y))) } as Partial<ScopedConstraint>, final)
          else P.onEditConstraint(grip.index, { widthM: Math.max(0.1, r3(g[0] - c.x)), heightM: Math.max(0.1, r3(g[1] - c.y)) } as Partial<ScopedConstraint>, final)
          return
        }
        case "control":
          // Alt breaks the tangent, as in 2D.
          P.onMoveControl(grip.index, grip.side, x, y, final, !!d.alt)
          return
        case "rotation": {
          const r = P.spec?.rotationTargets?.[grip.index]
          const at = r && P.spec && rotationPoint(P.spec, P.traj, r)
          if (at) P.onEditRotation(grip.index, { headingDeg: turnTo(at, g, d.shift) }, final)
          return
        }
      }
    }
    const selectionOf = (grip: Grip): Selection => {
      switch (grip.kind) {
        case "wp": return { kind: "waypoint", index: grip.index }
        case "keepout": return { kind: "keepout", index: grip.index }
        case "zone": return { kind: "zone", index: grip.index }
        case "shape": return { kind: "constraint", index: grip.index }
        case "rotation": return { kind: "rotation", index: grip.index }
        case "control": return { kind: "waypoint", index: grip.index }
        case "label": return grip.select
      }
    }

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || modeRef.current === "lens") return
      down = { x: e.clientX, y: e.clientY }
      const P = propsRef.current
      const g = ground(e)
      const hit = pick(e)
      // A waypoint under the pointer, even off its puck.
      const grip: Grip | null = hit?.grip ?? (g && waypointNear(g) >= 0 ? { kind: "wp", index: waypointNear(g), part: "free", puck: true } : null)
      if (grip) {
        // With the constraint or event tool, a waypoint is where it goes.
        if (grip.kind === "wp" && grip.puck && P.tool.kind !== "select") {
          P.onWaypointClick(grip.index)
          down = null
          e.stopImmediatePropagation()
          return
        }
        if (grip.kind === "label") {
          if (grip.select?.kind === "waypoint" && P.tool.kind !== "select") P.onWaypointClick(grip.select.index)
          else P.onSelect(grip.select)
          down = null
          e.stopImmediatePropagation()
          return
        }
        if (!(grip.kind === "wp" && !grip.puck)) P.onSelect(selectionOf(grip))
        begin(e, { kind: "grip", grip, from: originOf(grip), at: g ?? [0, 0], last: null, shift: e.shiftKey })
        return
      }
      if (!g) return
      // Tools that start a gesture on the carpet.
      if (P.tool.kind === "zone") {
        begin(e, { kind: "zoneNew", from: [0, 0], at: [r3(g[0]), r3(g[1])], last: null, shift: false })
        return
      }
      if (P.tool.kind === "rotation") {
        // Near the path: a rotation target there. The 2D helper works in pixels: 30 px a meter makes its reach ~0.47 m.
        const r = rotationAt(P.spec, P.traj, g[0] * 30, -g[1] * 30, (x, y) => [x * 30, -y * 30])
        if (r) P.onAddRotation(r.segment, r.fraction, r.headingDeg)
        down = null
        e.stopImmediatePropagation()
      }
    }
    let hovered: Object3D | null = null
    const onMove = (e: PointerEvent) => {
      if (!drag) {
        if (e.buttons !== 0 || modeRef.current === "lens") return
        // What is under the pointer lights up (the gizmo) or swells (a knob), and says it can be grabbed.
        const hit = pick(e)
        const knob = hit ? knobOf(hit.object) : null
        if (knob !== hovered) {
          if (hovered) hovered.userData.hover = false
          if (knob) knob.userData.hover = true
          hovered = knob
        }
        lightGizmo(gizmo, hit?.grip.kind === "wp" && !hit.grip.puck ? hit.grip.part : null)
        const g = hit ? null : ground(e)
        const near = g ? waypointNear(g) >= 0 : false
        const tool = propsRef.current.tool.kind
        renderer.domElement.style.cursor = hit?.grip.kind === "label" ? "pointer"
          : hit || near ? (tool === "select" || hit?.grip.kind !== "wp" ? "grab" : "pointer")
          : tool === "zone" || tool === "rotation" || tool === "waypoint" || tool === "keepout" ? "crosshair"
          : lockedRef.current ? "default" : ""
        return
      }
      const g = ground(e)
      if (!g) return
      drag.last = g
      drag.shift = e.shiftKey
      if (drag.kind === "grip") drag.alt = e.altKey
      apply(drag, g, false)
    }
    const onUp = (e: PointerEvent) => {
      if (drag) {
        const d = drag
        drag = null
        if (d.last) apply(d, d.last, true)
        else if (d.kind === "zoneNew") apply(d, d.at, true)
        renderer.domElement.style.cursor = ""
        controls.enabled = !lockedRef.current
        down = null
        return
      }
      // A click, not an orbit: on empty carpet it is the tool's.
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
        const g = ground(e)
        if (g && g[0] >= 0 && g[1] >= 0 && g[0] <= L && g[1] <= W) {
          if (propsRef.current.tool.kind === "select") propsRef.current.onSelect(null)
          else propsRef.current.onFieldClick(g[0], g[1])
        }
      }
      down = null
    }
    renderer.domElement.addEventListener("pointerdown", onDown, { capture: true })
    renderer.domElement.addEventListener("pointermove", onMove)
    renderer.domElement.addEventListener("pointerup", onUp)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      renderer.domElement.removeEventListener("pointerdown", onDown, { capture: true })
      renderer.domElement.removeEventListener("pointermove", onMove)
      renderer.domElement.removeEventListener("pointerup", onUp)
      if (decalRef.current) { decalRef.current.texture.dispose(); decalRef.current = null }
      controls.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
      sceneRef.current = null
    }
  }, [])

  // The field: MARS Desktop's 3D model of it when installed, else the 2D picture as the carpet.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    let alive = true
    let placed: Object3D | null = null
    s.field.clear()
    const carpet = () => {
      const canvas = document.createElement("canvas")
      const k = 2048 / L
      canvas.width = 2048
      canvas.height = Math.round(W * k)
      const img = new Image()
      img.onload = () => {
        if (!alive) return
        const ctx = canvas.getContext("2d")!
        const toScreen = (x: number, y: number): [number, number] => [x * k, canvas.height - y * k]
        drawFieldBackground(ctx, { w: canvas.width, h: canvas.height }, toScreen, k, p.field, img, null, { ...p.view, fieldStyle: "photo", field: true, grid: false })
        const tex = new CanvasTexture(canvas)
        tex.colorSpace = SRGBColorSpace
        const mesh = new Mesh(new PlaneGeometry(L, W), new MeshStandardMaterial({ map: tex, roughness: 0.95 }))
        mesh.position.set(L / 2, W / 2, 0)
        s.field.add(mesh)
      }
      img.src = p.field.imageUrl
      // The perimeter, so the inset has walls to see.
      const wall = new MeshStandardMaterial({ color: 0x9aa3b2, transparent: true, opacity: 0.35 })
      for (const [x, y, lx, ly] of [[L / 2, -0.03, L, 0.06], [L / 2, W + 0.03, L, 0.06], [-0.03, W / 2, 0.06, W], [L + 0.03, W / 2, 0.06, W]]) {
        const m = new Mesh(new BoxGeometry(lx, ly, 0.5), wall)
        m.position.set(x, y, 0.25)
        s.field.add(m)
      }
    }
    invoke<{ folder: string; config: string } | null>("field3d_find", { year: p.field.key.slice(0, 4) })
      .then(async pack => {
        if (!alive) return
        const config = pack ? parseAssetConfig(pack.config) : null
        if (!pack || !config || config.kind !== "field") {
          setFieldNote("No 3D field installed for this year: the 2D picture stands in. Install one in MARS Desktop (Field 3D → Assets).")
          carpet()
          return
        }
        setFieldNote(null)
        const asset = await loadAssetModel({ kind: "path", path: `${pack.folder}/model.glb` }, [], OPTIMIZE_PRESETS.standard)
        if (!alive) return
        const inst = instantiateAsset(asset)
        const q = composeRotations(config.rotations)
        const holder = new Group()
        inst.quaternion.set(q[1], q[2], q[3], q[0])
        holder.add(inst)
        // AdvantageScope's fields are centered on the playing area; WPILib's origin is the blue
        // corner. Which end is blue: the turn that lands the model's tags on WPILib's.
        holder.position.set(L / 2, W / 2, 0)
        holder.rotation.z = modelTurn(config, propsRef.current.world.tags, L, W)
        s.field.add(holder)
        placed = inst
      })
      .catch(e => {
        if (!alive) return
        setFieldNote(`The 3D field did not load (${e}): the 2D picture stands in.`)
        carpet()
      })
    return () => {
      alive = false
      if (placed) disposeAssetInstance(placed)
    }
  }, [p.field.key, p.view.fieldFlip])

  // The structures (the 2.5D map): translucent boxes with their edges.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    s.structures.clear()
    if (!p.view.occluders) return
    for (const o of p.world.occluders) {
      const zMin = o.zMinM ?? 0
      const g = new BoxGeometry(o.lengthM, o.widthM, o.zMaxM - zMin)
      const box = new Mesh(g, new MeshStandardMaterial({ color: 0x334155, transparent: true, opacity: 0.22, depthWrite: false }))
      const edges = new LineSegments(new EdgesGeometry(g), new LineBasicMaterial({ color: 0x94a3b8 }))
      for (const m of [box, edges]) {
        m.position.set(o.x, o.y, (zMin + o.zMaxM) / 2)
        m.rotation.z = ((o.yawDeg ?? 0) * Math.PI) / 180
        s.structures.add(m)
      }
    }
  }, [p.world.occluders, p.view.occluders])

  // The tags, each with its real pattern, and a green outline shown while a camera detects it.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    s.tags.clear()
    s.tagMeshes.clear()
    if (!p.view.tags) return
    const side = (TAG_BLACK_M * TOTAL_WIDTH) / 8
    for (const t of p.world.tags) {
      const holder = new Group()
      holder.position.set(t.x, t.y, t.z)
      holder.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), new Vector3(t.nx, t.ny, t.nz).normalize()))
      const face = new Mesh(tagQuad(side), new MeshBasicMaterial({ map: tagTexture(t.id), side: DoubleSide }))
      face.position.x = 0.004
      const back = new Mesh(new BoxGeometry(0.006, side * 1.15, side * 1.15), new MeshStandardMaterial({ color: 0xe5e7eb }))
      const ring = side * 0.62
      const outline = new LineSegments(
        new EdgesGeometry(new BoxGeometry(0.002, 2 * ring, 2 * ring)),
        new LineBasicMaterial({ color: LIMELIGHT_GREEN }),
      )
      outline.position.x = 0.008
      outline.visible = false
      holder.add(back, face, outline)
      s.tags.add(holder)
      s.tagMeshes.set(t.id, { outline })
    }
  }, [p.world.tags, p.view.tags])

  // The robot: its model, or its bumper as a box.
  const [modelPath, setModelPath] = useState<string | null>(null)
  useEffect(() => {
    if (!p.robot.model) { setModelPath(null); return }
    invoke<string>("resolve_model_path", { robotPath: p.robotPath, modelPath: p.robot.model.path }).then(setModelPath).catch(() => setModelPath(null))
  }, [p.robotPath, p.robot.model?.path])
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    let alive = true
    let inst: Group | null = null
    s.model.clear()
    const { lengthM, widthM } = p.robot.bumper
    const bumper = new Mesh(new BoxGeometry(lengthM, widthM, BUMPER_HEIGHT), new MeshStandardMaterial({ color: 0xa83c3c }))
    bumper.position.z = BUMPER_HEIGHT / 2 + 0.02
    const front = new Mesh(new BoxGeometry(0.06, widthM * 0.5, 0.02), new MeshStandardMaterial({ color: 0xf8fafc }))
    front.position.set(lengthM / 2 - 0.05, 0, BUMPER_HEIGHT + 0.03)
    s.model.add(bumper, front)
    if (modelPath && p.robot.model) {
      const ref = p.robot.model
      loadModel(modelPath).then(m => {
        if (!alive) return
        inst = instantiateModel(m, "origin")
        placeModel(inst, ref)
        s.model.add(inst)
      }).catch(() => { /* the bumper box stays */ })
    }
    s.model.traverse(o => o.layers.set(MAIN_ONLY))
    return () => {
      alive = false
      if (inst) disposeInstance(inst)
    }
  }, [modelPath, JSON.stringify(p.robot.model), p.robot.bumper.lengthM, p.robot.bumper.widthM])

  // The trajectory on the carpet.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    s.path.clear()
    const owned: BufferGeometry[] = []
    const t = p.traj
    // The trajectory: a white tube in an orange glow, above the carpet's drawing so it reads from any angle.
    if (t && t.samples.length > 1) {
      const curve = new CatmullRomCurve3(t.samples.map(q => new Vector3(q.x, q.y, 0.07)), false, "centripetal")
      const segments = Math.min(1500, t.samples.length * 3)
      const core = new TubeGeometry(curve, segments, 0.035, 8, false)
      const glow = new TubeGeometry(curve, segments, 0.09, 12, false)
      owned.push(core, glow)
      s.path.add(new Mesh(core, PATH_CORE), new Mesh(glow, PATH_GLOW))
    }
    // Pathfind spans (found at run time): a green tube and a see-through fence along them, so they
    // stand out from the planned path.
    p.spec?.waypoints.forEach((w, j) => {
      if (!w.pathfindNext && !(j === 0 && kindOf(w) === "unknown")) return
      const next = p.spec!.waypoints[j + 1]
      if (!next) return
      const span = t?.pathfind?.find(q => q.fromWaypoint === j)
      const pts = span && t ? t.samples.slice(span.startSample, span.endSample + 1).map(q => [q.x, q.y]) : [[w.x, w.y], [next.x, next.y]]
      if (pts.length < 2) return
      const line = new CatmullRomCurve3(pts.map(([x, y]) => new Vector3(x, y, 0.1)), false, "centripetal")
      const tube = new TubeGeometry(line, Math.max(16, pts.length * 2), 0.06, 10, false)
      const fence = new BufferGeometry()
      const v: number[] = []
      const index: number[] = []
      pts.forEach(([x, y], k) => {
        v.push(x, y, 0, x, y, 0.5)
        if (k > 0) index.push(2 * k - 2, 2 * k - 1, 2 * k, 2 * k - 1, 2 * k + 1, 2 * k)
      })
      fence.setAttribute("position", new Float32BufferAttribute(v, 3))
      fence.setIndex(index)
      owned.push(tube, fence)
      s.path.add(new Mesh(tube, PATHFIND_TUBE), new Mesh(fence, PATHFIND_FENCE))
    })
    s.path.traverse(o => o.layers.set(MAIN_ONLY))
    return () => owned.forEach(g => g.dispose())
  }, [p.traj, p.spec])

  // Where the robot is, what its cameras see, and the inset's lens.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    s.overlay.clear()
    for (const { outline } of s.tagMeshes.values()) outline.visible = false
    const cams = p.robot.cameras ?? []
    if (!p.pose) {
      s.robot.visible = false
      setSeenNote("")
      return
    }
    const [x, y, h] = p.pose
    s.robot.visible = true
    s.robot.position.set(x, y, 0)
    s.robot.rotation.set(0, 0, h)
    const seen = detections(p.robot, p.world, x, y, h, true)
    cams.forEach((c, i) => {
      // The frustum, from the lens, out to a meter (its range is in the 2D view).
      const pose = cameraPose(c, x, y, h)
      const col = (j: number) => new Vector3(pose.rotation[0][j], pose.rotation[1][j], pose.rotation[2][j])
      const [f, l, u] = [col(0), col(1), col(2)]
      const apex = new Vector3(...pose.position)
      const th = Math.tan((c.horizontalFovDeg * Math.PI) / 360), tv = Math.tan((c.verticalFovDeg * Math.PI) / 360)
      const reach = Math.min(1.2, rangeOf(c))
      const corner = (a: number, b: number) => apex.clone().add(f.clone().add(l.clone().multiplyScalar(a * th)).add(u.clone().multiplyScalar(b * tv)).multiplyScalar(reach))
      const cs = [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)]
      const pts: number[] = []
      cs.forEach((q, k) => pts.push(apex.x, apex.y, apex.z, q.x, q.y, q.z, q.x, q.y, q.z, cs[(k + 1) % 4].x, cs[(k + 1) % 4].y, cs[(k + 1) % 4].z))
      const g = new BufferGeometry()
      g.setAttribute("position", new Float32BufferAttribute(pts, 3))
      const frustum = new LineSegments(g, new LineBasicMaterial({ color: LIMELIGHT_GREEN }))
      frustum.layers.set(MAIN_ONLY)
      s.overlay.add(frustum)
      // A sight line to every tag it detects; grey and dashed to the ones a structure hides.
      for (const d of seen.filter(q => q.camera === i)) {
        const to = new Vector3(d.tag.x, d.tag.y, d.tag.z)
        if (d.hidden) {
          const lg = new BufferGeometry().setFromPoints([apex, to])
          const line = new Line(lg, new LineDashedMaterial({ color: 0x7c8190, dashSize: 0.12, gapSize: 0.08 }))
          line.computeLineDistances()
          line.layers.set(MAIN_ONLY)
          s.overlay.add(line)
        } else {
          const beam = sightBeam(apex, to)
          beam.layers.set(MAIN_ONLY)
          s.overlay.add(beam)
          const t = s.tagMeshes.get(d.tag.id)
          if (t) t.outline.visible = true
        }
      }
      // The inset's camera sits in this lens: three's camera looks down -Z with Y up.
      if (i === Math.min(insetCamera, cams.length - 1)) {
        const basis = new Matrix4().makeBasis(l.clone().negate(), u, f.clone().negate())
        s.inset.position.copy(apex)
        s.inset.quaternion.setFromRotationMatrix(basis)
        s.inset.fov = c.verticalFovDeg
        s.inset.aspect = th / tv
        s.inset.far = Math.max(2, rangeOf(c) + 1)
        s.inset.updateProjectionMatrix()
        const mine = seen.filter(q => q.camera === i)
        const ids = mine.filter(q => !q.hidden).map(q => q.tag.id)
        const hidden = mine.length - ids.length
        setSeenNote(`${c.name}: ${ids.length ? `sees ${ids.join(", ")}` : "no tags"}${hidden ? ` · ${hidden} hidden` : ""}`)
      }
    })
    if (!cams.length) setSeenNote("")
  }, [p.pose, p.robot, p.world, insetCamera, p.view.tags])

  // Handles for everything the 2D editor edits, and the gizmo on the selected waypoint.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    const owned = buildHandles(s.handles, p)
    const sel = p.selected?.kind === "waypoint" ? p.selected.index : -1
    const w = sel >= 0 ? p.spec?.waypoints[sel] : undefined
    s.gizmo.root.visible = !!w && kindOf(w) !== "unknown"
    if (w) {
      s.gizmo.root.position.set(w.x, w.y, 0.12)
      // Only a pose has a heading of its own to turn.
      s.gizmo.ring.visible = kindOf(w) === "pose"
      s.gizmo.pointer.rotation.z = ((w.headingDeg ?? 0) * Math.PI) / 180
    }
    return () => owned.forEach(g => g.dispose())
  }, [p.spec, p.selected, p.keepOut, p.zones, p.traj])

  // A 1 m grid on the carpet.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    s.grid.clear()
    if (!grid) return
    const pts: number[] = []
    for (let x = 0; x <= L + 1e-6; x++) pts.push(x, 0, 0.02, x, W, 0.02)
    for (let y = 0; y <= W + 1e-6; y++) pts.push(0, y, 0.02, L, y, 0.02)
    const g = new BufferGeometry()
    g.setAttribute("position", new Float32BufferAttribute(pts, 3))
    const lines = new LineSegments(g, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }))
    lines.layers.set(MAIN_ONLY)
    s.grid.add(lines)
    return () => { g.dispose(); (lines.material as LineBasicMaterial).dispose() }
  }, [grid, L, W])

  useEffect(() => {
    const s = sceneRef.current
    if (s) s.controls.enabled = !locked
    remember("ares.view3dLocked", locked)
  }, [locked])
  useEffect(() => remember("ares.view3dGrid", grid), [grid])

  // Camera presets.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    if (mode === "blue" || mode === "red") {
      // From behind the alliance wall, at a driver's eye height.
      const blue = mode === "blue"
      s.camera.position.set(blue ? -1.2 : L + 1.2, W / 2, 1.9)
      s.controls.target.set(blue ? L * 0.45 : L * 0.55, W / 2, 0)
    } else if (mode === "follow" && p.pose) {
      s.controls.target.set(p.pose[0], p.pose[1], 0)
      s.camera.position.set(p.pose[0] - 2.6, p.pose[1] - 2.6, 2.2)
    }
  }, [mode])

  const cams = p.robot.cameras ?? []
  useEffect(() => { if (mode === "lens" && cams.length === 0) setMode("orbit") }, [mode, cams.length])
  if (insetCamera >= Math.max(1, cams.length)) setInsetCamera(0)
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div ref={host} style={{ position: "absolute", inset: 0, overflow: "hidden" }} />
      <div style={{ position: "absolute", left: 8, right: 8, top: 8, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, pointerEvents: "none" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, pointerEvents: "auto" }}>
          {([["orbit", "Orbit"], ["follow", "Follow"], ["blue", "Blue DS"], ["red", "Red DS"], ["lens", "◉ Lens"]] as const)
            .filter(([m]) => m !== "lens" || cams.length > 0)
            .map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)} style={chip(mode === m)}
                title={m === "lens" ? "The whole view from the robot's camera, as it sees the match" : undefined}>{label}</button>
            ))}
          <button onClick={() => setLocked(v => !v)} style={{ ...chip(locked), marginLeft: 6 }}
            title={locked ? "The view is locked: the camera holds still and a click only reaches what can be edited. Click to move the camera again." : "Lock the view: the camera holds still, so a click or a drag only edits."}>
            <i className={`ti ${locked ? "ti-lock" : "ti-lock-open"}`} /> {locked ? "View locked" : "Lock view"}
          </button>
          <button onClick={() => setGrid(v => !v)} style={chip(grid)} title="A 1 m grid on the carpet">
            <i className="ti ti-grid-4x4" /> Grid
          </button>
          {cams.length > 0 && mode !== "lens" && (
            <button onClick={() => setShowInset(v => !v)} style={chip(showInset)} title="Show or hide the inset with what the camera sees">Camera inset</button>
          )}
          <button onClick={exportSim} disabled={exporting} style={{ ...chip(false), marginLeft: 6 }}
            title="Write the robot (URDF, with its fixed cameras as Gazebo camera sensors) and this field (SDF world: walls, structures, AprilTags, the robot at the path's start) into the project's ares/sim/ folder, for MARS Simulation Studio.">
            {exporting ? "Exporting…" : "⇪ Export to Gazebo"}
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", pointerEvents: "auto" }}>
          {(() => {
            const side = allianceOf(p.spec, L)
            return side && (
              <span title={allianceHint(side)} style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "#ffffff", background: ALLIANCE_COLOR[side], padding: "3px 10px", borderRadius: 3 }}>
                ◆ {side === "blue" ? "BLUE ALLIANCE PATH" : "RED ALLIANCE PATH ⚠ (flips on red)"}
              </span>
            )
          })()}
          {cams.length > 0 && p.pose && (
            <>
              {cams.length > 1 && (
                <select value={insetCamera} onChange={e => setInsetCamera(Number(e.target.value))} style={{ fontSize: 11 }}>
                  {cams.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
                </select>
              )}
              <span style={{ fontSize: 11, fontWeight: 700, color: LIMELIGHT_GREEN, background: "rgba(0,0,0,0.75)", padding: "2px 8px", border: `1px solid ${LIMELIGHT_GREEN}` }}>
                ◉ {seenNote}
              </span>
            </>
          )}
          {!p.pose && (
            <span style={{ fontSize: 11, color: "#e5e7eb", background: "rgba(0,0,0,0.6)", padding: "3px 8px" }}>
              Play the path or select a waypoint to place the robot.
            </span>
          )}
        </div>
        {fieldNote && (
          <div style={{ maxWidth: 360, fontSize: 10.5, color: "#fde68a", background: "rgba(0,0,0,0.6)", padding: "3px 8px" }}>{fieldNote}</div>
        )}
      </div>
    </div>
  )
}

function chip(on: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 5, fontSize: 12, padding: "5px 11px", borderRadius: 3, cursor: "pointer", border: `1px solid ${on ? LIMELIGHT_GREEN : "#4b5563"}`,
    background: on ? "rgba(57,255,20,0.18)" : "rgba(17,24,39,0.8)", color: on ? LIMELIGHT_GREEN : "#e5e7eb",
  }
}

/** A tag's picture as a square facing +X, its right edge toward +Y and its top toward +Z. */
function tagQuad(side: number): BufferGeometry {
  const h = side / 2
  const g = new BufferGeometry()
  // Bottom-left, bottom-right, top-right, top-left, as seen from in front (from +X).
  g.setAttribute("position", new Float32BufferAttribute([0, -h, -h, 0, h, -h, 0, h, h, 0, -h, h], 3))
  g.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  g.setAttribute("normal", new Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0], 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

const textures = new Map<number, CanvasTexture>()

/** The tag's tag36h11 picture, crisp: one texel per cell, no smoothing. */
function tagTexture(id: number): CanvasTexture {
  const hit = textures.get(id)
  if (hit) return hit
  const cells = tag36h11(id)
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = TOTAL_WIDTH
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, TOTAL_WIDTH, TOTAL_WIDTH)
  ctx.fillStyle = "#000000"
  cells?.forEach((row, r) => row.forEach((white, c) => { if (!white) ctx.fillRect(c, r, 1, 1) }))
  const tex = new CanvasTexture(canvas)
  tex.magFilter = NearestFilter
  tex.minFilter = NearestFilter
  tex.colorSpace = SRGBColorSpace
  textures.set(id, tex)
  return tex
}

const BEAM = new MeshBasicMaterial({ color: LIMELIGHT_GREEN })

/** A thin glowing rod from the lens to the tag: lines are one pixel wide in WebGL. */
function sightBeam(a: Vector3, b: Vector3): Mesh {
  const d = b.clone().sub(a)
  const rod = new Mesh(new CylinderGeometry(0.008, 0.008, d.length(), 6), BEAM)
  rod.position.copy(a).addScaledVector(d, 0.5)
  rod.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), d.normalize())
  return rod
}

// --- Editing handles ----------------------------------------------------------------

/** What a handle edits. A waypoint is grabbed by its puck (`puck`) or by a part of the gizmo. */
type Grip =
  | { kind: "wp"; index: number; part: GizmoPart; puck?: boolean }
  | { kind: "keepout" | "zone" | "shape"; index: number; part: "move" | "size" }
  | { kind: "rotation"; index: number }
  | { kind: "control"; index: number; side: "prev" | "next" }
  | { kind: "label"; select: Selection }

type Drag3 =
  | { kind: "grip"; grip: Grip; from: [number, number]; at: [number, number]; last: [number, number] | null; shift: boolean; alt?: boolean }
  | { kind: "zoneNew"; from: [number, number]; at: [number, number]; last: [number, number] | null; shift: boolean }

const KEEP_OUT_COLOR = 0xc21c1c
const CONTROL_COLOR = 0x0ea5e9
const PATH_CORE = new MeshBasicMaterial({ color: 0xffffff })
const PATH_GLOW = new MeshBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.45, depthWrite: false })
const PATHFIND_TUBE = new MeshBasicMaterial({ color: 0x22c55e })
const PATHFIND_FENCE = new MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.22, side: DoubleSide, depthWrite: false })
const ZONE_COLOR = new Color(ZONE).getHex()
const CONSTRAINT_COLOR = new Color(COLORS.constraint).getHex()
/** How high the knobs float: above the bumpers, below the labels. */
const KNOB_Z = 0.45

const KNOB = new SphereGeometry(1, 24, 16)
const knobMats = new Map<number, MeshBasicMaterial>()
function knobMat(color: number): MeshBasicMaterial {
  let m = knobMats.get(color)
  if (!m) knobMats.set(color, (m = onTop(color)))
  return m
}
const wallMats = new Map<number, MeshBasicMaterial>()
function wallMat(color: number): MeshBasicMaterial {
  let m = wallMats.get(color)
  if (!m) wallMats.set(color, (m = new MeshBasicMaterial({ color, transparent: true, opacity: 0.2, side: DoubleSide, depthWrite: false })))
  return m
}
const edgeMats = new Map<number, LineBasicMaterial>()
function edgeMat(color: number): LineBasicMaterial {
  let m = edgeMats.get(color)
  if (!m) edgeMats.set(color, (m = new LineBasicMaterial({ color })))
  return m
}

/** A ball floating over (x, y) on a stem: what is grabbed. It keeps its size on screen (see the render loop). */
function knob(x: number, y: number, color: number, grip: Grip, size = 0.17): Group {
  const g = new Group()
  g.userData.knob = true
  g.position.set(x, y, 0)
  const ball = new Mesh(KNOB, knobMat(color))
  ball.scale.setScalar(size)
  ball.position.z = KNOB_Z
  const rim = new Mesh(KNOB, knobMat(0xffffff))
  rim.scale.setScalar(size * 1.22)
  rim.position.z = KNOB_Z
  rim.renderOrder = 8
  ball.renderOrder = 9
  const stem = new Mesh(STEM, knobMat(color))
  const hit = new Mesh(KNOB, HIT_MAT)
  hit.scale.setScalar(size * 2.4)
  hit.position.z = KNOB_Z
  g.add(rim, ball, stem, hit)
  g.traverse(o => { o.userData.grip = grip; o.layers.set(MAIN_ONLY) })
  return g
}
const STEM = new CylinderGeometry(0.012, 0.012, KNOB_Z, 6).rotateX(Math.PI / 2).translate(0, 0, KNOB_Z / 2)

function knobOf(o: Object3D | null): Object3D | null {
  for (; o; o = o.parent) if (o.userData.knob) return o
  return null
}

/** A wall around a circle, see-through: the area a keep-out or a zone covers, with its height. */
function circleWall(x: number, y: number, r: number, color: number, height: number, owned: BufferGeometry[]): Group {
  const g = new Group()
  const wall = new CylinderGeometry(r, r, height, 64, 1, true).rotateX(Math.PI / 2).translate(x, y, height / 2)
  owned.push(wall)
  g.add(new Mesh(wall, wallMat(color)))
  const rim: number[] = []
  for (let k = 0; k <= 64; k++) {
    const a = (k / 64) * Math.PI * 2
    rim.push(x + r * Math.cos(a), y + r * Math.sin(a), height)
  }
  const line = new BufferGeometry()
  line.setAttribute("position", new Float32BufferAttribute(rim, 3))
  owned.push(line)
  g.add(new Line(line, edgeMat(color)))
  return g
}

/** The same for a rectangle from its corner (x, y). */
function boxWall(x: number, y: number, w: number, h: number, color: number, height: number, owned: BufferGeometry[]): Group {
  const g = new Group()
  const box = new BoxGeometry(Math.max(w, 0.01), Math.max(h, 0.01), height).translate(x + w / 2, y + h / 2, height / 2)
  owned.push(box)
  g.add(new Mesh(box, wallMat(color)))
  const edges = new EdgesGeometry(box)
  owned.push(edges)
  g.add(new LineSegments(edges, edgeMat(color)))
  return g
}

/** Everything editable gets a handle; returns the geometries made, to dispose with the next build. */
function buildHandles(group: Group, p: Props): BufferGeometry[] {
  group.clear()
  const owned: BufferGeometry[] = []
  const sel = p.selected
  const isSel = (kind: NonNullable<Selection>["kind"], i: number) => sel?.kind === kind && sel.index === i
  const tag = (o: Object3D, grip: Grip) => { o.traverse(q => { q.userData.grip ??= grip; q.layers.set(MAIN_ONLY) }) }

  // Waypoints: a puck in their kind's color, a tick to a pose's heading.
  p.spec?.waypoints.forEach((w, i) => {
    const kind = kindOf(w)
    if (kind === "unknown") return
    const g = new Group()
    g.position.set(w.x, w.y, 0.04)
    g.add(new Mesh(PUCK, PUCK_MATS[kind] ?? PUCK_MATS.empty))
    if (kind === "pose" && w.headingDeg !== undefined) {
      const tick = new Mesh(TICK, TICK_MAT)
      tick.rotation.z = (w.headingDeg * Math.PI) / 180
      g.add(tick)
    }
    if (isSel("waypoint", i)) g.add(new Mesh(SELECTED_RING, SELECTED_MAT))
    g.add(new Mesh(PUCK_HIT, HIT_MAT))
    tag(g, { kind: "wp", index: i, part: "free", puck: true })
    group.add(g)
  })

  // Keep-outs: a red wall, a knob in the middle to move it and one on the edge to size it.
  p.keepOut.forEach((c, i) => {
    group.add(circleWall(c.x, c.y, c.radiusM, KEEP_OUT_COLOR, 0.35, owned))
    group.add(knob(c.x, c.y, isSel("keepout", i) ? 0xfacc15 : KEEP_OUT_COLOR, { kind: "keepout", index: i, part: "move" }))
    group.add(knob(c.x + c.radiusM, c.y, 0xffffff, { kind: "keepout", index: i, part: "size" }, 0.12))
  })

  // Slow zones: an amber box (or drum); move from the middle, size from the far corner (or the edge).
  p.zones.forEach((z, i) => {
    const color = isSel("zone", i) ? 0xfacc15 : ZONE_COLOR
    if (z.shape === "rectangle") {
      group.add(boxWall(z.x, z.y, z.widthM, z.heightM, ZONE_COLOR, 0.15, owned))
      group.add(knob(z.x + z.widthM / 2, z.y + z.heightM / 2, color, { kind: "zone", index: i, part: "move" }))
      group.add(knob(z.x + z.widthM, z.y + z.heightM, 0xffffff, { kind: "zone", index: i, part: "size" }, 0.12))
    } else {
      group.add(circleWall(z.x, z.y, z.radiusM, ZONE_COLOR, 0.15, owned))
      group.add(knob(z.x, z.y, color, { kind: "zone", index: i, part: "move" }))
      group.add(knob(z.x + z.radiusM, z.y, 0xffffff, { kind: "zone", index: i, part: "size" }, 0.12))
    }
  })

  // The constraints' shapes: the point a side faces, the circles and the rectangle.
  p.spec?.scoped.forEach((c, i) => {
    if (c.enabled === false || !("x" in c)) return
    const color = isSel("constraint", i) ? 0xfacc15 : CONSTRAINT_COLOR
    const move = { kind: "shape", index: i, part: "move" } as const
    const size = { kind: "shape", index: i, part: "size" } as const
    if (c.type === "pointAt") group.add(knob(c.x, c.y, color, move, 0.2))
    else if (c.type === "keepInRectangle") {
      group.add(boxWall(c.x, c.y, c.widthM, c.heightM, CONSTRAINT_COLOR, 0.25, owned))
      group.add(knob(c.x + c.widthM / 2, c.y + c.heightM / 2, color, move))
      group.add(knob(c.x + c.widthM, c.y + c.heightM, 0xffffff, size, 0.12))
    } else {
      group.add(circleWall(c.x, c.y, c.radiusM, c.type === "keepOutCircle" ? KEEP_OUT_COLOR : CONSTRAINT_COLOR, 0.25, owned))
      group.add(knob(c.x, c.y, color, move))
      group.add(knob(c.x + c.radiusM, c.y, 0xffffff, size, 0.12))
    }
  })

  // Manual segments: a cyan knob on each control point, on a line from its waypoint, as in 2D.
  p.spec?.waypoints.forEach((w, i) => {
    const next = p.spec!.waypoints[i + 1]
    if (!w.manualNext || !next || !w.nextControl || !next.prevControl) return
    for (const [from, at, index, side] of [[w, w.nextControl, i, "next"], [next, next.prevControl, i + 1, "prev"]] as const) {
      const arm = new BufferGeometry().setFromPoints([new Vector3(from.x, from.y, 0.08), new Vector3(at[0], at[1], 0.08)])
      owned.push(arm)
      group.add(new Line(arm, edgeMat(CONTROL_COLOR)))
      group.add(knob(at[0], at[1], CONTROL_COLOR, { kind: "control", index, side }, 0.13))
    }
  })

  // Rotation targets: a big arrow on the path at their heading; grab it anywhere to turn it.
  if (p.spec) {
    (p.spec.rotationTargets ?? []).forEach((r, i) => {
      const at = rotationPoint(p.spec!, p.traj, r)
      if (!at) return
      const color = isSel("rotation", i) ? 0xfacc15 : CONSTRAINT_COLOR
      const g = new Group()
      g.userData.knob = true
      g.position.set(at.x, at.y, 0)
      const arrow = new Group()
      arrow.position.z = 0.3
      arrow.rotation.z = (r.headingDeg * Math.PI) / 180
      const shaft = new Mesh(ARROW_SHAFT, knobMat(color))
      const head = new Mesh(ARROW_HEAD, knobMat(color))
      const hub = new Mesh(KNOB, knobMat(color))
      hub.scale.setScalar(0.11)
      const hit = new Mesh(ARROW_HIT, HIT_MAT)
      for (const m of [shaft, head, hub]) m.renderOrder = 9
      arrow.add(shaft, head, hub, hit)
      g.add(arrow, new Mesh(STEM_LOW, knobMat(color)))
      tag(g, { kind: "rotation", index: i })
      group.add(g)
    })
  }
  // Editing aids: the main view's, not what a camera sees.
  group.traverse(o => o.layers.set(MAIN_ONLY))
  return owned
}
const ARROW_SHAFT = new CylinderGeometry(0.035, 0.035, 0.55, 10).rotateZ(-Math.PI / 2).translate(0.275, 0, 0)
const ARROW_HEAD = new ConeGeometry(0.12, 0.28, 20).rotateZ(-Math.PI / 2).translate(0.69, 0, 0)
const ARROW_HIT = new BoxGeometry(1.0, 0.4, 0.4).translate(0.4, 0, 0)
const STEM_LOW = new CylinderGeometry(0.012, 0.012, 0.3, 6).rotateX(Math.PI / 2).translate(0, 0, 0.15)

/** The slow zone being drawn with the zone tool. */
function drawDraft(group: Group, a: [number, number], b: [number, number], done: boolean) {
  group.children.forEach(o => o.traverse(q => { if ((q as Mesh).geometry) (q as Mesh).geometry.dispose() }))
  group.clear()
  if (done) return
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1])
  const owned: BufferGeometry[] = []
  const g = boxWall(x, y, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), ZONE_COLOR, 0.15, owned)
  g.traverse(o => o.layers.set(MAIN_ONLY))
  group.add(g)
}

// --- Floating labels -----------------------------------------------------------------------

const labelTextures = new Map<string, { texture: CanvasTexture; aspect: number }>()

/** A label as a picture: a rounded chip, crisp at the size it floats. */
function labelTexture(l: DecalLabel): { texture: CanvasTexture; aspect: number } {
  const key = `${l.text}|${l.color}|${l.filled}`
  const hit = labelTextures.get(key)
  if (hit) return hit
  if (labelTextures.size > 400) {
    for (const t of labelTextures.values()) t.texture.dispose()
    labelTextures.clear()
  }
  const font = "600 40px 'Segoe UI', Arial, sans-serif"
  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")!
  ctx.font = font
  const w = Math.ceil(ctx.measureText(l.text).width) + 36, h = 60
  canvas.width = w
  canvas.height = h
  ctx.font = font
  ctx.beginPath()
  ctx.roundRect(3, 3, w - 6, h - 6, 12)
  ctx.fillStyle = l.filled ? l.color : "rgba(255,255,255,0.96)"
  ctx.fill()
  ctx.lineWidth = 5
  ctx.strokeStyle = l.color
  ctx.stroke()
  ctx.fillStyle = l.filled ? "#ffffff" : l.color
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(l.text, w / 2, h / 2 + 2)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  const made = { texture, aspect: w / h }
  labelTextures.set(key, made)
  return made
}

/** The 2D drawing's labels, floating: over the waypoint they are about when one is near, stacked
 * when several are over the same place, each on a thin stem down to the carpet. */
function buildLabels(group: Group, list: DecalLabel[], spec: PathSpec | null) {
  for (const o of group.children) if (o instanceof Sprite) o.material.dispose()
  group.clear()
  const anchors: [number, number][] = []
  const count: number[] = []
  for (const l of list) {
    let ax = l.x, ay = l.y
    let near = 1.0
    spec?.waypoints.forEach(w => {
      const d = Math.hypot(w.x - l.x, w.y - l.y)
      if (d < near) { near = d; ax = w.x; ay = w.y }
    })
    let k = anchors.findIndex(([x, y]) => Math.hypot(x - ax, y - ay) < 0.45)
    if (k < 0) { anchors.push([ax, ay]); count.push(0); k = anchors.length - 1 }
    ;[ax, ay] = anchors[k]
    const n = count[k]++
    const { texture, aspect } = labelTexture(l)
    const sprite = new Sprite(new SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true }))
    sprite.center.set(0.5, 0)
    sprite.renderOrder = 12
    sprite.userData = { label: true, ax, ay, n, aspect, grip: l.select ? { kind: "label", select: l.select } : undefined }
    sprite.layers.set(MAIN_ONLY)
    group.add(sprite)
    if (n === 0) {
      const stem = new Line(LABEL_STEM, edgeMat(new Color(l.color).getHex()))
      stem.userData = { stem: true, ax, ay }
      stem.layers.set(MAIN_ONLY)
      group.add(stem)
    }
  }
}
const LABEL_STEM = new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, 1)])

/** Each frame: the labels' size and height follow the camera's distance, so they read the same near and far. */
function placeLabels(group: Group, camera: PerspectiveCamera) {
  const v = new Vector3()
  for (const o of group.children) {
    const u = o.userData
    v.set(u.ax, u.ay, 0)
    const f = Math.min(2.6, Math.max(0.5, camera.position.distanceTo(v) / 10))
    const h = 0.2 * f, base = 0.85 * f
    if (u.label) {
      o.scale.set(h * u.aspect, h, 1)
      o.position.set(u.ax, u.ay, base + u.n * h * 1.2)
    } else if (u.stem) {
      o.position.set(u.ax, u.ay, 0)
      o.scale.set(1, 1, base)
    }
  }
}

/** What of the gizmo is grabbed: an arrow (that axis only), the center (anywhere), the ring (turn). */
type GizmoPart = "x" | "y" | "free" | "rot"

interface Gizmo {
  root: Group
  /** The turning ring: only for a pose. */
  ring: Group
  /** The heading arrow and the ring's arrowheads, turned to the waypoint's heading. */
  pointer: Group
  looks: Map<GizmoPart, { mat: MeshBasicMaterial; base: number }[]>
}

/** Drawn over everything, so the handles are never behind the carpet or the robot. */
function onTop(color: number, opacity = 1): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false })
}

/** Invisible, fatter than what is drawn: so the pointer does not have to be exact. */
const HIT_MAT = onTop(0x000000, 0)

const GIZMO_RADIUS = 1.45

function makeGizmo(): Gizmo {
  const root = new Group()
  const looks: Gizmo["looks"] = new Map()
  const add = (parent: Group, part: GizmoPart, mesh: Mesh, look = false) => {
    mesh.userData.part = part
    mesh.renderOrder = 10
    mesh.layers.set(MAIN_ONLY)
    parent.add(mesh)
    if (look) {
      const mat = mesh.material as MeshBasicMaterial
      looks.set(part, [...(looks.get(part) ?? []), { mat, base: mat.color.getHex() }])
    }
  }
  // The center: drag it anywhere.
  add(root, "free", new Mesh(new CircleGeometry(0.24, 40), onTop(0xffffff, 0.6)), true)
  add(root, "free", new Mesh(new CircleGeometry(0.34, 24), HIT_MAT))
  // The arrows along the field's X (red) and Y (green). Three's cylinders and cones stand on +Y: a
  // quarter turn about Z lays them along +X.
  for (const [part, color, angle] of [["x", 0xef4444, 0], ["y", 0x22c55e, Math.PI / 2]] as const) {
    const arm = new Group()
    arm.rotation.z = angle
    root.add(arm)
    const mat = onTop(color)
    const shaft = new Mesh(new CylinderGeometry(0.045, 0.045, 0.8, 12), mat)
    const tip = new Mesh(new ConeGeometry(0.13, 0.32, 24), mat)
    const hit = new Mesh(new CylinderGeometry(0.18, 0.18, 1.2, 8), HIT_MAT)
    for (const [m, at] of [[shaft, 0.3 + 0.4], [tip, 1.26], [hit, 0.3 + 0.6]] as const) {
      m.rotation.z = -Math.PI / 2
      m.position.x = at
    }
    add(arm, part, shaft, true)
    add(arm, part, tip)
    add(arm, part, hit)
  }
  // The ring, with an arrow to the heading and arrowheads that say it turns.
  const ring = new Group()
  root.add(ring)
  const ringMat = onTop(0xf59e0b)
  add(ring, "rot", new Mesh(new TorusGeometry(GIZMO_RADIUS, 0.05, 10, 96), ringMat), true)
  add(ring, "rot", new Mesh(new TorusGeometry(GIZMO_RADIUS, 0.2, 6, 64), HIT_MAT))
  const pointer = new Group()
  ring.add(pointer)
  const shaft = new Mesh(new CylinderGeometry(0.03, 0.03, GIZMO_RADIUS - 0.35, 10), ringMat)
  shaft.rotation.z = -Math.PI / 2
  shaft.position.x = 0.35 + (GIZMO_RADIUS - 0.35) / 2
  const head = new Mesh(new ConeGeometry(0.17, 0.4, 24), ringMat)
  head.rotation.z = -Math.PI / 2
  head.position.x = GIZMO_RADIUS + 0.2
  add(pointer, "rot", shaft)
  add(pointer, "rot", head)
  // Along the ring: a cone at angle a pointing counterclockwise is a cone on +Y turned by a.
  for (const [a, turn] of [[0.55, 0.55], [-0.55, -0.55 + Math.PI]]) {
    const cone = new Mesh(new ConeGeometry(0.14, 0.34, 20), ringMat)
    cone.position.set(GIZMO_RADIUS * Math.cos(a), GIZMO_RADIUS * Math.sin(a), 0)
    cone.rotation.z = turn
    add(pointer, "rot", cone)
  }
  root.visible = false
  return { root, ring, pointer, looks }
}

/** The part under the pointer, lighter. */
function lightGizmo(g: Gizmo, part: GizmoPart | "wp" | null) {
  for (const [p, list] of g.looks) for (const { mat, base } of list) mat.color.setHex(p === part ? 0xfff7d6 : base)
}

/** Whether the object and everything above it is shown: the raycaster does not check. */
function shown(o: Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false
  return true
}

// A waypoint's puck: big enough to grab, in its kind's color, a tick to a pose's heading.
const PUCK = new CylinderGeometry(0.22, 0.22, 0.07, 32).rotateX(Math.PI / 2)
const PUCK_HIT = new CylinderGeometry(0.4, 0.4, 0.3, 16).rotateX(Math.PI / 2)
const PUCK_MATS: Record<string, MeshBasicMaterial> = {
  pose: new MeshBasicMaterial({ color: 0xe95420 }),
  translation: new MeshBasicMaterial({ color: 0x2f6fdb }),
  empty: new MeshBasicMaterial({ color: 0x9ca3af }),
}
const TICK = new BoxGeometry(0.36, 0.06, 0.08).translate(0.2, 0, 0.03)
const TICK_MAT = new MeshBasicMaterial({ color: 0xffffff })
const SELECTED_RING = new TorusGeometry(0.3, 0.035, 8, 48)
const SELECTED_MAT = new MeshBasicMaterial({ color: 0xfacc15 })

function remembered(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === "1"
  } catch { return fallback }
}

function remember(key: string, on: boolean) {
  try { localStorage.setItem(key, on ? "1" : "0") } catch { /* not remembered */ }
}
