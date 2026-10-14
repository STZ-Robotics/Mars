#!/usr/bin/env python3
"""Everything pulled out of the 2026 field mesh: FUEL and hitboxes.

    python sim/worlds/field_2026.py

The 2026 field carries 456 FUEL BAKED INTO the glTF: they are nodes of the
model, with no collision and no mass, pure scenery. Simulating them for real
takes two things and both live here:

  1. KNOWING WHERE THEY ARE. The staged positions come from the .glb itself,
     not from a hand-written table: that way the physical balls land exactly
     where the official model draws them, and if another version of the field
     is installed the positions move on their own.

  2. REMOVING THEM FROM THE VISUAL. Otherwise you see two balls in every spot
     --- the baked one, which never moves, and the physical one on top. A copy
     of the .glb without those nodes is written; the original is not touched
     because the other worlds still use it as scenery.

THE CUT: the FUEL nodes are direct children of the scene root, with no
children of their own, so taking their indices out of `children` is enough.
Nothing is reindexed and no meshes are deleted: a mesh no node references is
not drawn, and reindexing 3363 nodes for 456 extra ones is the kind of
operation that breaks an 18 MB file without saying where.

AND HITBOXES. The field mesh goes into the world as a VISUAL and nothing more:
it is 2.9 M triangles, and using it as collision would have the solver resolve
mesh-mesh contact, the most expensive thing a physics engine does. Without
collision, the robot drives through the driver station wall, the HUB and
everything else. The boxes here are the field's physics, and their sizes come
from the AABBs of the glTF's own nodes: there is not a single hand-written
number that could drift from the model.

FRAMES: the glTF comes Y-up and the world places it with a 90 degree roll, so
a point (x, y, z) of the glTF lands at (x, -z, y) in Gazebo. The conversion
happens here and nowhere else.
"""
import io
import json
import math
import struct
import sys
from pathlib import Path

HERE = Path(__file__).parent
SIM = HERE.parent

# The node-name prefix of the FUEL in the 2026 field. The full name is
# "GE-26900: Fuel", with the manual's part number in front.
FUEL_PREFIX = "GE-26900"

# Field dimensions, the same as protocol/topics.toml. They decide what is
# "inside": what falls outside the perimeter are the FEEDER balls, which sit
# on the other side of the wall, stacked almost a meter high.
FIELD = (16.54, 8.21)

# FUEL radius, from models/fuel/model.sdf. Used to rest them on the floor when
# the glTF node comes with a slightly different z.
FUEL_RADIUS = 0.075


def read_glb(path):
    """Returns (json, json_offset, json_length, bytes) of a .glb."""
    data = Path(path).read_bytes()
    magic, version, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError(f"{path} is not a version 2 binary glTF")
    length, kind = struct.unpack_from("<II", data, 12)
    if kind != 0x4E4F534A:
        raise ValueError(f"{path}: the first chunk is not JSON")
    js = json.loads(data[20:20 + length].decode("utf-8"))
    return js, 20, length, data


def fuel_indices(js):
    """Indices of the nodes that are FUEL."""
    return [i for i, n in enumerate(js["nodes"])
            if n.get("name", "").startswith(FUEL_PREFIX)]


def positions(glb_path):
    """The field's staged FUEL, in meters and in GAZEBO's frame.

    Returns a list of (x, y, z). The z is the model's, which for the ones on
    the floor is already the radius.
    """
    js, _, _, _ = read_glb(glb_path)
    out = []
    for i in fuel_indices(js):
        t = js["nodes"][i].get("translation", [0.0, 0.0, 0.0])
        out.append((t[0], -t[2], t[1]))
    return out


def inside_the_field(p):
    """Whether the ball is inside the perimeter.

    The ones that are not are the FEEDER's: they live behind the driver
    station wall, stacked on a ramp the world does not model. Simulating them
    would be dropping 48 dynamic bodies inside a wall that does not exist.
    """
    x, y, _ = p
    return abs(x) <= FIELD[0] / 2 and abs(y) <= FIELD[1] / 2


def write_without_fuel(origin, dest):
    """Copies the .glb without the FUEL nodes. Returns how many it removed."""
    js, off, length, data = read_glb(origin)
    remove = set(fuel_indices(js))
    if not remove:
        raise ValueError(f"{origin}: has no {FUEL_PREFIX}* node")

    for node in js["nodes"]:
        if "children" in node:
            node["children"] = [c for c in node["children"] if c not in remove]
            if not node["children"]:
                del node["children"]
    for scene in js.get("scenes", []):
        scene["nodes"] = [n for n in scene.get("nodes", []) if n not in remove]

    # The JSON chunk is padded with SPACES to a multiple of 4; the BIN one,
    # with zeros. The specification says so and it is not cosmetic: a viewer
    # that validates alignment rejects the whole file.
    new = json.dumps(js, separators=(",", ":")).encode("utf-8")
    new += b" " * (-len(new) % 4)
    binary = data[off + length:]   # BIN chunk header included, untouched

    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(new) + len(binary))
    out += struct.pack("<II", len(new), 0x4E4F534A)
    out += new
    out += binary
    Path(dest).write_bytes(out)
    return len(remove)


def ensure_without_fuel(field_rel):
    """Generates the FUEL-less copy if it is missing or the original is newer.

    Returns the copy's path relative to `sim/`, or None if the field is not
    installed.
    """
    origin = SIM / field_rel
    if not origin.is_file():
        return None
    dest = origin.with_name(origin.stem + "-no-fuel.glb")
    if not dest.is_file() or dest.stat().st_mtime < origin.stat().st_mtime:
        n = write_without_fuel(origin, dest)
        print(f"wrote {dest.relative_to(SIM)} ({n} FUEL removed from the visual)")
    return str(dest.relative_to(SIM)).replace("\\", "/")


# --- the optimized field ---------------------------------------------------
#
# The official mesh is 4.28 M triangles in 2929 meshes, and the split is not
# the one you would expect:
#
#     679 k   410 PEM nuts of 5 mm
#     422 k     4 REV-21-2246 parts, 11 cm each
#     395 k   220 3/16" rivets
#     295 k   456 FUEL
#     289 k    32 wheel bushings
#     ...
#
# It is a CAD model with every rivet modelled. Removing BIG parts does
# nothing --- the whole HUB is 47% of the triangles and it is exactly what
# needs to be seen. What is extra is what cannot be seen: nothing 5 mm across
# is visible from a camera looking at a 70 cm robot, but every nut costs its
# 1656 triangles and its draw call all the same.
#
# So the filter is by SIZE, not by part. Everything whose diagonal measures
# less than `min_size` goes. Measured on this field:
#
#     threshold  meshes out   triangles out   remaining
#       2 cm        586           985 k         3.29 M
#       5 cm        870         1 266 k         3.01 M
#       8 cm        964         1 596 k         2.68 M
#      12 cm       1162         2 112 k         2.16 M
#
# And the binary is also COMPACTED: a mesh that is no longer drawn still
# takes its vertices in the file, and the whole .glb gets loaded into memory
# anyway. The buffer is rewritten with only what remains.
MIN_VISIBLE = 0.12

# Sizes from the glTF specification, to copy an accessor without guessing.
COMPONENT_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4,
              "MAT2": 4, "MAT3": 9, "MAT4": 16}


def _diagonal(js, idx, m):
    """Diagonal of the node's world AABB, in meters."""
    box = _accumulate(js, idx, m, [[math.inf] * 3, [-math.inf] * 3])
    if box[0][0] > box[1][0]:
        return 0.0
    return math.dist(box[0], box[1])


def write_optimized(origin, dest, min_size=MIN_VISIBLE, without_fuel=True):
    """Writes a copy of the field with only what can be seen.

    Returns (meshes, triangles, bytes) of the copy.

    Removes the mesh nodes smaller than `min_size` and, if `without_fuel`,
    the baked FUEL. Then rebuilds accessors, bufferViews and the binary with
    whatever survives: without that the file would still weigh 18 MB of
    vertices nobody draws, and the load time --- which is what you feel when
    opening the world --- would not drop at all.
    """
    js, off, length, data = read_glb(origin)
    binary = data[off + length + 8:]
    nodes = js["nodes"]

    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    alive = set()

    def prune(idx, m):
        """True if the node stays. Prunes bottom-up."""
        n = nodes[idx]
        m_child = _multiply(m, _matrix(n))
        children = [h for h in n.get("children", []) if prune(h, m_child)]
        if children:
            n["children"] = children
        else:
            n.pop("children", None)

        if without_fuel and n.get("name", "").startswith(FUEL_PREFIX):
            n.pop("mesh", None)
            return False
        if "mesh" in n and _diagonal(js, idx, m) < min_size:
            n.pop("mesh", None)
        # A node with no mesh and no children draws nothing: it is an empty
        # group that only makes the engine walk it every frame.
        if "mesh" not in n and not children:
            return False
        alive.add(idx)
        return True

    js["scenes"][0]["nodes"] = [i for i in js["scenes"][0]["nodes"]
                                if prune(i, identity)]

    # --- compact: meshes, accessors, bufferViews and the binary ------------
    used_meshes, used_accs = {}, {}
    new_meshes, new_accs, new_views = [], [], []
    new_binary = bytearray()

    def view_of(i_acc):
        """Copies ONE accessor into its own bufferView. Returns the new index.

        Per accessor and not per bufferView, which is what seemed natural:
        this field puts its 4000 accessors inside THREE 17 MB bufferViews, so
        copying the whole view for every accessor would give a file of several
        gigabytes --- and the first attempt did, until the size no longer fit
        in the glb header's u32.

        Copying per element also undoes interleaving: if the bufferView had a
        byteStride, here it comes out packed and takes less space.
        """
        if i_acc in used_accs:
            return used_accs[i_acc]
        a = dict(js["accessors"][i_acc])
        if "sparse" in a:
            raise ValueError("sparse accessor: not supported")
        if "bufferView" in a:
            v = js["bufferViews"][a["bufferView"]]
            elem = COMPONENT_SIZE[a["componentType"]] * COMPONENTS[a["type"]]
            stride = v.get("byteStride") or elem
            base = v.get("byteOffset", 0) + a.get("byteOffset", 0)
            chunk = b"".join(binary[base + i * stride: base + i * stride + elem]
                             for i in range(a["count"]))
            # Every bufferView starts at a multiple of 4: otherwise a
            # Float32Array mounted on it reads one byte off and the mesh comes
            # out exploded.
            new_binary.extend(b"\x00" * (-len(new_binary) % 4))
            new_views.append({"buffer": 0,
                              "byteOffset": len(new_binary),
                              "byteLength": len(chunk)})
            if "target" in v:
                new_views[-1]["target"] = v["target"]
            new_binary.extend(chunk)
            a["bufferView"] = len(new_views) - 1
            a.pop("byteOffset", None)
        new_accs.append(a)
        used_accs[i_acc] = len(new_accs) - 1
        return used_accs[i_acc]

    for idx in sorted(alive):
        n = nodes[idx]
        if "mesh" not in n:
            continue
        i_mesh = n["mesh"]
        if i_mesh not in used_meshes:
            mesh = {"primitives": []}
            if "name" in js["meshes"][i_mesh]:
                mesh["name"] = js["meshes"][i_mesh]["name"]
            for prim in js["meshes"][i_mesh]["primitives"]:
                new = dict(prim)
                new["attributes"] = {k: view_of(v)
                                     for k, v in prim["attributes"].items()}
                if "indices" in prim:
                    new["indices"] = view_of(prim["indices"])
                mesh["primitives"].append(new)
            new_meshes.append(mesh)
            used_meshes[i_mesh] = len(new_meshes) - 1
        n["mesh"] = used_meshes[i_mesh]

    js["meshes"] = new_meshes
    js["accessors"] = new_accs
    js["bufferViews"] = new_views
    js["buffers"] = [{"byteLength": len(new_binary)}]

    text = json.dumps(js, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    new_binary.extend(b"\x00" * (-len(new_binary) % 4))

    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2,
                       12 + 8 + len(text) + 8 + len(new_binary))
    out += struct.pack("<II", len(text), 0x4E4F534A)
    out += text
    out += struct.pack("<II", len(new_binary), 0x004E4942)
    out += new_binary
    Path(dest).write_bytes(out)

    triangles = 0
    for mesh in new_meshes:
        for prim in mesh["primitives"]:
            i = prim.get("indices", prim["attributes"]["POSITION"])
            triangles += new_accs[i]["count"] // 3
    return len(new_meshes), triangles, len(out)


def ensure_optimized(field_rel, min_size=MIN_VISIBLE):
    """Generates the optimized copy if it is missing or the original is newer."""
    origin = SIM / field_rel
    if not origin.is_file():
        return None
    dest = origin.with_name(origin.stem + "-lite.glb")
    if not dest.is_file() or dest.stat().st_mtime < origin.stat().st_mtime:
        meshes, tris, size = write_optimized(origin, dest, min_size)
        print(f"wrote {dest.relative_to(SIM)} "
              f"({meshes} meshes, {tris:,} triangles, {size / 1e6:.1f} MB)")
    return str(dest.relative_to(SIM)).replace("\\", "/")


# --- hitboxes --------------------------------------------------------------
#
# What goes in and what does not. Each entry is (name in the SDF, node name
# in the glTF); the box comes from that node's AABB, with all its children and
# all its transforms applied.
#
# THE SIX DRIVER STATIONS AND THE TWO GUARDRAILS are the perimeter. The three
# DS at each end do not close the wall on their own: two gaps remain between
# them, and they are covered by the TOWER (which also reaches 1.2 m into the
# field, so it is a real obstacle) and the OUTPOST. With the five per end the
# wall is closed from side to side, except for a finger of 11 cm at each
# corner that on the real field is covered by the corner support.
#
# THE TWO HUBS are the scoring structure: 1.53 x 1.49 m and 3.08 tall.
#
# WHAT IS NOT HERE, on purpose:
#
#   Trench   its AABB is 1.19 x 8.37 x 1.02, i.e. it crosses the whole field
#            from side to side. As a solid box it would not be an obstacle, it
#            would be a WALL splitting the field in two --- and you drive
#            under the trench. It needs several boxes (the legs and the roof),
#            not one.
#   Depot    3 cm. It is a floor marking, not an obstacle.
#
# THE FOUR BUMPS go separately, in BUMPS, because they are not boxes: they are
# ramps and each one comes out as two tilted slabs. See _ramps().
#
# The names carry the official model's suffix (<1>, <2>) instead of red and
# blue: they are the ones shown in Gazebo's entity tree, and that way nobody
# has to be trusted on which side each alliance is. To get your bearings: in
# WPILib's convention the origin is the BLUE corner, so the blue wall is the
# one at negative x in Gazebo's frame, which has its origin at the center.
PARTS = [
    ("guardrail_1", "Configurable Guardrail <1>"),
    ("guardrail_2", "Configurable Guardrail <2>"),
    ("driver_station_1", "Driver Station <1>"),
    ("driver_station_2", "Driver Station <2>"),
    ("driver_station_3", "Driver Station <3>"),
    ("driver_station_4", "Driver Station <4>"),
    ("driver_station_5", "Driver Station <5>"),
    ("driver_station_6", "Driver Station <6>"),
    ("tower_1", "GE-26500: Tower <1>"),
    ("tower_2", "GE-26500: Tower <2>"),
    ("outpost_1", "GE-26000: Outpost <1>"),
    ("outpost_2", "GE-26000: Outpost <2>"),
    ("hub_1", "GE-26300: Hub <1>"),
    ("hub_2", "GE-26300: Hub <2>"),
]

# The BUMPS: the humps you drive over. Each one gives two boxes.
BUMPS = [
    ("bump_1", "GE-26100: Bump <1>"),
    ("bump_2", "GE-26100: Bump <2>"),
    ("bump_3", "GE-26100: Bump <3>"),
    ("bump_4", "GE-26100: Bump <4>"),
]


def _multiply(a, b):
    return [sum(a[i * 4 + k] * b[k * 4 + j] for k in range(4))
            for i in range(4) for j in range(4)]


def _matrix(n):
    """A node's local transform, row-major."""
    if "matrix" in n:
        # glTF stores matrices COLUMN-major. Reading them as rows gives a
        # transpose that almost works: the translations land in the wrong
        # place and the rotations come out inverted.
        m = n["matrix"]
        return [m[0], m[4], m[8], m[12],
                m[1], m[5], m[9], m[13],
                m[2], m[6], m[10], m[14],
                m[3], m[7], m[11], m[15]]
    t = n.get("translation", [0, 0, 0])
    x, y, z, w = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    r = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
         2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
         2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
    return [r[0] * s[0], r[1] * s[1], r[2] * s[2], t[0],
            r[3] * s[0], r[4] * s[1], r[5] * s[2], t[1],
            r[6] * s[0], r[7] * s[1], r[8] * s[2], t[2],
            0, 0, 0, 1]


def _apply(m, p):
    return (m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11])


def _accumulate(js, idx, m, box):
    """AABB of the subtree, still in the glTF's frame.

    Each mesh carries its own AABB in the `min`/`max` of its POSITION
    accessor, so not a single vertex has to be read: there are 2929 meshes and
    walking the whole binary for this would take longer than loading the
    field.

    From a rotated AABB the EIGHT corners are taken and enclosed again. That
    gives a box somewhat bigger than the tight one when the part sits
    diagonally; on this field everything is at 0 or 90 degrees and the
    difference is zero.
    """
    n = js["nodes"][idx]
    m = _multiply(m, _matrix(n))
    if "mesh" in n:
        for prim in js["meshes"][n["mesh"]]["primitives"]:
            a = js["accessors"][prim["attributes"]["POSITION"]]
            lo, hi = a["min"], a["max"]
            for i in range(8):
                q = _apply(m, [lo[0] if i & 1 else hi[0],
                               lo[1] if i & 2 else hi[1],
                               lo[2] if i & 4 else hi[2]])
                for k in range(3):
                    box[0][k] = min(box[0][k], q[k])
                    box[1][k] = max(box[1][k], q[k])
    for h in n.get("children", []):
        _accumulate(js, h, m, box)
    return box


def _find(js, name):
    """(index, parents' matrix) of the node with that name."""
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

    def descend(idx, m):
        n = js["nodes"][idx]
        if n.get("name") == name:
            return idx, m
        m_child = _multiply(m, _matrix(n))
        for h in n.get("children", []):
            found = descend(h, m_child)
            if found:
                return found
        return None

    for root in js["scenes"][0]["nodes"]:
        found = descend(root, identity)
        if found:
            return found
    return None


def hitboxes(glb_path):
    """The field's collision boxes, in GAZEBO's frame.

    Returns a list of (name, center, size, rpy), in meters and radians. Almost
    all are axis-aligned (rpy = 0,0,0); the BUMP ramps carry pitch. A part
    that is not in the model is skipped silently: another year's field has no
    reason to carry the same ones.
    """
    js, _, _, _ = read_glb(glb_path)
    boxes = []
    for name, node in PARTS:
        box = _box_of(js, node)
        if box:
            boxes.append((name, box[0], box[1], (0.0, 0.0, 0.0)))
    for name, node in BUMPS:
        box = _box_of(js, node)
        if box:
            boxes.extend(_ramps(name, *box))
    return boxes


def _box_of(js, node):
    """(center, size) of that node's AABB, in Gazebo's frame."""
    found = _find(js, node)
    if not found:
        return None
    idx, m = found
    lo, hi = _accumulate(js, idx, m, [[math.inf] * 3, [-math.inf] * 3])
    # glTF (x, y, z) -> Gazebo (x, -z, y), same as the FUEL.
    center = ((lo[0] + hi[0]) / 2, -(lo[2] + hi[2]) / 2, (lo[1] + hi[1]) / 2)
    size = (hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1])
    return center, size


# Thickness of the slab that acts as a ramp. It is not the real BUMP's: it is
# the thickness of the box being tilted, and all it has to do is have its top
# face lie on the slope and its bottom face stay buried.
RAMP_THICKNESS = 0.08


def _ramps(name, center, size):
    """A BUMP as TWO tilted boxes, not as one box.

    The model's profile, measured vertex by vertex, is a symmetric hump: it
    rises from 0 to 16.5 cm over the 56 cm half-width and comes back down. A
    16.5 cm box in its place would be a STEP --- the robot would hit a wall the
    height of the ramp head-on instead of climbing it, which is exactly the
    opposite of what the bump does on the field.

    Each half is a slab rotated by its slope angle, placed so that its TOP FACE
    is the slope. The bottom one stays under the floor and does not get in the
    way: the floor's <plane> is infinite but both are static.
    """
    cx, cy, _ = center
    width, depth, height = size
    half = width / 2
    angle = math.atan2(height, half)
    length = math.hypot(half, height)      # the hypotenuse: the slab's length

    out = []
    for i, sign in enumerate((-1, 1), start=1):
        # Midpoint of this half's top face.
        mx = cx + sign * half / 2
        mz = height / 2
        # The box's center is half a thickness below, along the slope's
        # NORMAL --- not the vertical, or the slab pokes out of the top edge
        # and leaves a lip a wheel catches on.
        # A pitch p sends local +x to (cos p, 0, -sin p) and local +z to
        # (sin p, 0, cos p). The left half (sign -1) RISES towards +x, so it
        # needs negative pitch; the right one descends and takes it positive.
        pitch = sign * angle
        normal = (math.sin(pitch), math.cos(pitch))
        out.append((
            f"{name}_{i}",
            (mx - normal[0] * RAMP_THICKNESS / 2, cy, mz - normal[1] * RAMP_THICKNESS / 2),
            (length, depth, RAMP_THICKNESS),
            (0.0, pitch, 0.0),
        ))
    return out


def push_out_of_boxes(pos, boxes, radius=FUEL_RADIUS):
    """Takes a FUEL out of a hitbox, by the shortest side.

    The 14 balls the model rests against the driver station wall end up 12 mm
    inside the driver station's AABB. Twelve millimeters sounds like nothing,
    but a body that is BORN penetrating another is energy the solver has to
    take from somewhere, and it does it by spitting the ball out. A world that
    starts with fourteen balls flying off looks broken even if it is not.

    It pushes along the axis of LEAST penetration, which is the shortest push
    that gets it out --- and in this case it leaves it resting right against
    the wall, which is where the model draws it.
    """
    pos = list(pos)
    for _, center, size, _rpy in boxes:
        clearance = [abs(pos[k] - center[k]) - (size[k] / 2 + radius)
                     for k in range(3)]
        if max(clearance) >= 0:
            continue    # already outside along some axis
        k = max(range(3), key=lambda i: clearance[i])
        sign = 1.0 if pos[k] >= center[k] else -1.0
        pos[k] = center[k] + sign * (size[k] / 2 + radius + 0.001)
    return tuple(pos)


if __name__ == "__main__":
    field = SIM / "fields/2026-rebuilt/model.glb"
    if not field.is_file():
        sys.exit(f"the field is not installed: {field}")
    every = positions(field)
    inside = [p for p in every if inside_the_field(p)]
    outside = [p for p in every if not inside_the_field(p)]
    print(f"{len(every)} FUEL in the mesh")
    print(f"  {len(inside)} inside the perimeter")
    print(f"  {len(outside)} in the feeder (x from {min(abs(p[0]) for p in outside):.2f} "
          f"to {max(abs(p[0]) for p in outside):.2f}, z up to {max(p[2] for p in outside):.2f})")
    center = [p for p in inside if abs(p[0]) < 2.0]
    print(f"  of the ones inside, {len(center)} are the center band and "
          f"{len(inside) - len(center)} sit by the alliances")
    print()
    boxes = hitboxes(field)
    squeezed = [p for p in inside if push_out_of_boxes(p, boxes) != p]
    print(f"{len(squeezed)} FUEL are born inside a hitbox and get pushed out")
    print(f"{len(boxes)} hitboxes:")
    for name, c, size, rpy in boxes:
        tilt = "" if not any(rpy) else f"  pitch {math.degrees(rpy[1]):5.1f} deg"
        print(f"  {name:18} center({c[0]:7.3f},{c[1]:7.3f},{c[2]:6.3f})"
              f"  size({size[0]:6.3f} x {size[1]:6.3f} x {size[2]:5.3f}){tilt}")
