// The "evergreen" field: the carpet, the walls and the alliance zones drawn by
// hand, without any model.
//
// It exists so the tab is useful FROM THE MOMENT IT OPENS. A season's official
// model weighs ~20 MB and has to be downloaded; until then —and on a laptop in
// the pit, without internet— a real-scale schematic field already allows seeing
// the odometry, comparing the setpoint with the measured pose and reviewing a
// trajectory, which is 90 % of the use.
//
// Everything is built in the model's frame: origin at the center of the playing
// area, +X towards red, +Y to the left seen from blue, +Z up.

import {
  BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group,
  LineBasicMaterial, LineSegments, Mesh, MeshPhongMaterial, PlaneGeometry,
} from "three"
import { FieldSize } from "./frames"

/** Measurements of the modern FRC field, in case none is declared. */
export const DEFAULT_FIELD_SIZE: FieldSize = { length: 16.541, width: 8.069 }

const CARPET_COLOR = 0x6e727c
const WALL_COLOR = 0xd8d9de
const BLUE = 0x2f6fdb
const RED = 0xd63b3b

/** Height of the perimeter wall. The real one is around half a meter. */
const WALL_HEIGHT = 0.5
const WALL_THICKNESS = 0.05

/**
 * An alliance strip at each end, in meters of field length.
 *
 * It does not try to be any specific rule zone — that changes every season —
 * but to make it crystal clear at a glance which end is which, which is the
 * only thing a schematic field is looked at for.
 */
const ALLIANCE_BAND = 1.2

function carpet(size: FieldSize): Mesh {
  const mesh = new Mesh(
    new PlaneGeometry(size.length, size.width),
    new MeshPhongMaterial({ color: CARPET_COLOR, shininess: 0 }),
  )
  mesh.receiveShadow = true
  return mesh
}

function allianceBand(size: FieldSize, color: number, sign: number): Mesh {
  const mesh = new Mesh(
    new PlaneGeometry(ALLIANCE_BAND, size.width),
    new MeshPhongMaterial({
      color, shininess: 0,
      // Transparent and not opaque: the strip tints the carpet instead of
      // covering it, so it still reads as floor and not as a raised platform.
      transparent: true, opacity: 0.45,
    }),
  )
  // A hair above the carpet: at the same height both faces fight over the
  // z-buffer and the classic z-fighting mottling shows up.
  mesh.position.set(sign * (size.length / 2 - ALLIANCE_BAND / 2), 0, 0.002)
  mesh.receiveShadow = true
  return mesh
}

function wall(length: number, width: number, color: number): Mesh {
  const mesh = new Mesh(
    new BoxGeometry(length, width, WALL_HEIGHT),
    new MeshPhongMaterial({ color, shininess: 6 }),
  )
  mesh.position.z = WALL_HEIGHT / 2
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** A one-meter grid on the carpet, to read distances at a glance. */
export function makeFieldGrid(size: FieldSize, cell: number): LineSegments {
  const points: number[] = []
  const halfLength = size.length / 2
  const halfWidth = size.width / 2

  for (let x = -halfLength; x <= halfLength + 1e-6; x += cell) {
    points.push(x, -halfWidth, 0, x, halfWidth, 0)
  }
  for (let y = -halfWidth; y <= halfWidth + 1e-6; y += cell) {
    points.push(-halfLength, y, 0, halfLength, y, 0)
  }
  // The exact edges, which dividing by `cell` almost never reaches.
  points.push(halfLength, -halfWidth, 0, halfLength, halfWidth, 0)
  points.push(-halfLength, halfWidth, 0, halfLength, halfWidth, 0)

  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3))

  const grid = new LineSegments(geometry, new LineBasicMaterial({
    color: 0x8d8f99, transparent: true, opacity: 0.28, depthWrite: false,
  }))
  // Over the carpet and over the alliance strips.
  grid.position.z = 0.004
  grid.renderOrder = 1
  return grid
}

/**
 * The field's midline, in white. It is the reference everyone uses to know at
 * a glance which half the robot is in.
 */
function centerLine(size: FieldSize): LineSegments {
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new Float32BufferAttribute(
    [0, -size.width / 2, 0, 0, size.width / 2, 0], 3,
  ))
  const line = new LineSegments(geometry, new LineBasicMaterial({ color: 0xf2f2f5 }))
  line.position.z = 0.005
  line.renderOrder = 2
  return line
}

/** The complete schematic field, ready to hang from the scene. */
export function makeEvergreenField(size: FieldSize): Group {
  const group = new Group()
  group.name = "evergreen-field"

  group.add(carpet(size))
  group.add(allianceBand(size, BLUE, -1))
  group.add(allianceBand(size, RED, 1))
  group.add(centerLine(size))

  const halfLength = size.length / 2 + WALL_THICKNESS / 2
  const halfWidth = size.width / 2 + WALL_THICKNESS / 2

  // The end walls take their alliance's color: it is the cheapest signal of
  // which end the robot is at when the camera looks from the side.
  const blueWall = wall(WALL_THICKNESS, size.width + WALL_THICKNESS * 2, BLUE)
  blueWall.position.x = -halfLength
  const redWall = wall(WALL_THICKNESS, size.width + WALL_THICKNESS * 2, RED)
  redWall.position.x = halfLength
  group.add(blueWall, redWall)

  const near = wall(size.length, WALL_THICKNESS, WALL_COLOR)
  near.position.y = -halfWidth
  const far = wall(size.length, WALL_THICKNESS, WALL_COLOR)
  far.position.y = halfWidth
  group.add(near, far)

  return group
}

/**
 * Positions of a schematic field's six driver stations.
 *
 * An asset with a model carries them in its config; the schematic one does
 * not, so they are spread in thirds along each end wall, which is how they are
 * on the real field. The order matches AdvantageScope's config: first the
 * three blue ones, then the three red ones.
 */
export function evergreenDriverStations(size: FieldSize): [number, number][] {
  const x = size.length / 2
  const offsets = [size.width / 3, 0, -size.width / 3]
  return [
    ...offsets.map((y): [number, number] => [-x, y]),
    ...offsets.map((y): [number, number] => [x, -y]),
  ]
}

/** Alliance color, shared with the objects painted by alliance. */
export const ALLIANCE_COLORS: Record<"blue" | "red", Color> = {
  blue: new Color(BLUE),
  red: new Color(RED),
}
