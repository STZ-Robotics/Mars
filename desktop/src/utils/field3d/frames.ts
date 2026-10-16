// Coordinate frames of the Field 3D.
//
// There are TWO frames in play and mixing them up is the number one source of
// robots that show up off the field or turned half around:
//
//  1. The frame the robot PUBLISHES in. WPILib chooses it and it changed over
//     the seasons: up to 2026 the origin is at the blue alliance's corner
//     ("wall-blue"), and from 2027 it moves to the field's center ("center-red").
//
//  2. The field MODEL's frame, which is the only one the scene understands:
//     origin at the CENTER of the playing area, +X towards the red alliance,
//     +Y to the left seen from blue, +Z up.
//
// Frame 2 is the same one AdvantageScope uses and the same one the AprilTag and
// driver station positions come in inside each field's config.json, so
// respecting it allows using its assets straight out of the .zip, without
// recomputing anything.

/** The four systems a 3D field's config.json declares. */
export type Field3dCoordinateSystem =
  | "wall-blue"       // origin at the blue corner, +X towards red (WPILib <= 2026)
  | "wall-alliance"   // the same, but the origin jumps to YOUR alliance's wall
  | "center-red"      // origin at the center, +X towards red (WPILib 2027+)
  | "center-rotated"  // FTC: origin at the center, turned 90 degrees

export const COORDINATE_SYSTEM_LABELS: Record<Field3dCoordinateSystem, string> = {
  "wall-blue": "Wall / blue corner (WPILib ≤2026)",
  "wall-alliance": "Wall / own alliance",
  "center-red": "Center, +X to red (WPILib 2027+)",
  "center-rotated": "Center rotated (FTC)",
}

export const COORDINATE_SYSTEMS: Field3dCoordinateSystem[] = [
  "wall-blue", "wall-alliance", "center-red", "center-rotated",
]

export type Alliance = "blue" | "red"

/**
 * A full 3D pose: translation in meters and rotation as a QUATERNION.
 *
 * The raw quaternion is kept and not Euler angles because it is exactly what
 * WPILib's `Pose3d` serializes: converting to roll/pitch/yaw to compose it
 * again introduces gimbal lock in perfectly valid poses (an arm pointing
 * straight up, for example).
 */
export interface Pose3D {
  x: number
  y: number
  z: number
  qw: number
  qx: number
  qy: number
  qz: number
}

export const IDENTITY_POSE: Pose3D = { x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0 }

// --- Cuaterniones -------------------------------------------------------------

export type Quat = [number, number, number, number] // [w, x, y, z]

/** A pure turn around +Z, which is how a Pose2d is lifted to 3D. */
export function quatFromYaw(yaw: number): Quat {
  return [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)]
}

/** `a` applied AFTER `b` (rotation composition does not commute). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a
  const [bw, bx, by, bz] = b
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ]
}

/** Yaw (turn in the field's plane) of a quaternion. */
export function yawOf(q: Quat): number {
  const [w, x, y, z] = q
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
}

/**
 * A quaternion arriving with zero norm (empty fields, a half-filled struct)
 * would leave the mesh's matrix degenerate and the piece invisible without any
 * error in sight, so it falls back to the identity.
 */
export function normalizeQuat(q: Quat): Quat {
  const norm = Math.hypot(q[0], q[1], q[2], q[3])
  if (!isFinite(norm) || norm < 1e-9) return [1, 0, 0, 0]
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm]
}

// --- Conversion to the model's frame -------------------------------------------

/** Length (X axis, long side) and width (Y axis) of the playing area, in meters. */
export interface FieldSize {
  length: number
  width: number
}

/**
 * The rotation and translation that take the published frame to the model's.
 *
 * The pair is returned instead of applying it right away because the scene
 * converts HUNDREDS of poses per frame (a long trajectory, an array of game
 * pieces): computing the frame once and reusing it avoids redoing the same
 * trigonometry at every point.
 */
export interface FrameTransform {
  /** Rotation of the published frame relative to the model's frame. */
  rotation: Quat
  /** Translation, already in the model's frame. */
  offset: [number, number, number]
}

export function frameTransform(
  system: Field3dCoordinateSystem,
  size: FieldSize,
  alliance: Alliance,
): FrameTransform {
  const halfLength = size.length / 2
  const halfWidth = size.width / 2

  switch (system) {
    // The origin is at the blue corner and the axes already point like the
    // model's: only the origin has to be moved to the center.
    case "wall-blue":
      return { rotation: [1, 0, 0, 0], offset: [-halfLength, -halfWidth, 0] }

    // The origin jumps to your own alliance's wall. For blue it is identical to
    // the previous case; for red the whole field is seen from the other end,
    // which is a half turn around the center.
    case "wall-alliance":
      return alliance === "red"
        ? { rotation: quatFromYaw(Math.PI), offset: [halfLength, halfWidth, 0] }
        : { rotation: [1, 0, 0, 0], offset: [-halfLength, -halfWidth, 0] }

    // It is already the model's frame.
    case "center-red":
      return { rotation: [1, 0, 0, 0], offset: [0, 0, 0] }

    // FTC publishes with +X towards the audience and +Y towards red: a quarter
    // turn relative to the model's frame.
    case "center-rotated":
      return { rotation: quatFromYaw(-Math.PI / 2), offset: [0, 0, 0] }
  }
}

/**
 * Turns a vector by a quaternion.
 *
 * It is done by hand instead of instantiating a three `Vector3` and
 * `Quaternion`: this runs for every point of every trajectory on every frame,
 * and the garbage those objects would generate shows in the collector.
 */
export function rotateVector(q: Quat, v: [number, number, number]): [number, number, number] {
  const [w, x, y, z] = q
  const [vx, vy, vz] = v

  // v' = v + 2w(u x v) + 2u x (u x v), with u = (x, y, z).
  const cx = y * vz - z * vy
  const cy = z * vx - x * vz
  const cz = x * vy - y * vx

  return [
    vx + 2 * (w * cx + y * cz - z * cy),
    vy + 2 * (w * cy + z * cx - x * cz),
    vz + 2 * (w * cz + x * cy - y * cx),
  ]
}

/** Applies a `FrameTransform` to a published pose. */
export function toFieldFrame(pose: Pose3D, transform: FrameTransform): Pose3D {
  const [rx, ry, rz] = rotateVector(transform.rotation, [pose.x, pose.y, pose.z])
  const rotated = quatMultiply(transform.rotation, [pose.qw, pose.qx, pose.qy, pose.qz])

  return {
    x: rx + transform.offset[0],
    y: ry + transform.offset[1],
    z: rz + transform.offset[2],
    qw: rotated[0], qx: rotated[1], qy: rotated[2], qz: rotated[3],
  }
}

/**
 * The inverse of `toFieldFrame`: from the model's frame back to the one the
 * robot publishes in. Used by the coordinate readout under the pointer, which
 * has to show the same numbers you would see in the robot code.
 */
export function fromFieldFrame(pose: Pose3D, transform: FrameTransform): Pose3D {
  const [w, x, y, z] = transform.rotation
  const inverse: Quat = [w, -x, -y, -z]

  const [rx, ry, rz] = rotateVector(inverse, [
    pose.x - transform.offset[0],
    pose.y - transform.offset[1],
    pose.z - transform.offset[2],
  ])
  const rotated = quatMultiply(inverse, [pose.qw, pose.qx, pose.qy, pose.qz])

  return {
    x: rx, y: ry, z: rz,
    qw: rotated[0], qx: rotated[1], qy: rotated[2], qz: rotated[3],
  }
}

/**
 * Chains two poses: `child` expressed in `parent`'s frame, taken to the frame
 * `parent` is in.
 *
 * It is WPILib's `Pose3d.transformBy` operation, and it is what is needed to
 * place an articulated component (which the robot publishes RELATIVE to
 * itself) on the field, or to know where a camera mounted on the robot is
 * looking from.
 */
export function composePose(parent: Pose3D, child: Pose3D): Pose3D {
  const parentQuat: Quat = [parent.qw, parent.qx, parent.qy, parent.qz]
  const [dx, dy, dz] = rotateVector(parentQuat, [child.x, child.y, child.z])
  const q = quatMultiply(parentQuat, [child.qw, child.qx, child.qy, child.qz])

  return {
    x: parent.x + dx,
    y: parent.y + dy,
    z: parent.z + dz,
    qw: q[0], qx: q[1], qy: q[2], qz: q[3],
  }
}
