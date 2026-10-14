#!/usr/bin/env python3
"""Verifies that the protocol contract is consistent with itself.

    python sim/protocol/check.py [robot-map.json ...]

With no arguments it validates the manifest and every robot map in the
repository. It exists because a contract that contradicts itself is worse
than no contract: both sides believe they agree. Run it in CI before building
either of them.

Needs Python 3.11+ for tomllib. The mars-sim environment's one works.
"""
import io
import json
import re
import sys
import tomllib
from pathlib import Path

HERE = Path(__file__).parent
SIM = HERE.parent
GROUPS = ("gz", "nt", "glue")
REQUIRED_KEYS = {"topic", "type", "dir", "desc"}


def check_manifest(manifest, readme, fails):
    """The manifest and the README cannot say different things."""
    version = manifest["protocol_version"]
    declared = {t["topic"] for g in GROUPS for t in manifest[g]}

    # The README is documentation, the manifest is the truth. If the README
    # cites a topic that does not exist, someone renamed it on one side only.
    for cited in set(re.findall(r"`(/(?:mars|MARS|SmartDashboard)/[^`]+)`", readme)):
        if cited not in declared:
            fails.append(f"README cites {cited}, which is not in topics.toml")
    if f"**{version}**" not in readme:
        fails.append(f"README does not declare the manifest's version {version}")

    for group in GROUPS:
        for entry in manifest[group]:
            topic = entry.get("topic", "?")
            missing = REQUIRED_KEYS - set(entry)
            if missing:
                fails.append(f"[[{group}]] {topic}: missing {sorted(missing)}")
            if entry.get("dir") not in ("in", "out"):
                fails.append(f"{topic}: invalid dir {entry.get('dir')!r}")
            # gz-sim's standard topics carry the world name embedded. If the
            # manifest's and the topic's drift apart, the bridge subscribes to
            # a name nobody publishes and there is no error, only silence
            # until discovery times out.
            in_topic = re.match(r"/world/([^/]+)/", topic)
            if in_topic and in_topic.group(1) != manifest["world"]:
                fails.append(
                    f"{topic}: carries the world '{in_topic.group(1)}',"
                    f" the manifest says '{manifest['world']}'"
                )

    return declared


def check_worlds(manifest, fails):
    """The world name in the SDF is part of the contract.

    gz-sim's standard topics carry it embedded (/world/<w>/pose/info). If it
    does not match, the bridge subscribes to a topic nobody publishes and there
    is no error anywhere, only a discovery timeout.
    """
    sdfs = sorted((SIM / "worlds").glob("*.sdf"))
    if not sdfs:
        fails.append(f"there is no .sdf in {SIM / 'worlds'}")
    for sdf in sdfs:
        text = io.open(sdf, encoding="utf-8").read()
        names = re.findall(r'<world\s+name="([^"]+)"', text)
        if not names:
            fails.append(f"{sdf.name}: declares no <world name=...>")
        for n in names:
            if n != manifest["world"]:
                fails.append(
                    f"{sdf.name}: world '{n}' != manifest '{manifest['world']}'"
                )

        # Both sides need the field's dimensions: the SDF for the ground plane
        # and the bridge to translate from Gazebo's frame to WPILib's. If they
        # diverge the poses come out shifted by half the difference, without
        # any error anywhere.
        field = manifest["field"]
        for size in re.findall(r"<plane>.*?<size>([^<]+)</size>.*?</plane>", text, re.S):
            try:
                length, width = (float(v) for v in size.split())
            except ValueError:
                fails.append(f"{sdf.name}: the plane's <size> is not two numbers: {size!r}")
                continue
            if abs(length - field["length_m"]) > 1e-6 or abs(width - field["width_m"]) > 1e-6:
                fails.append(
                    f"{sdf.name}: plane {length}x{width} != manifest "
                    f"{field['length_m']}x{field['width_m']}"
                )


def check_actuator_order(rm, tag, fails):
    """The most fragile part of the contract: the ORDER of the actuators.

    In the SDF it is the order of the <plugin>'s <actuator>s; in the robot
    map, the order of the list. That index is the position inside
    gz.msgs.Actuators' `normalized` field, so if they diverge the robot gets
    its commands crossed -- the left wheel with the right one's value --
    without a single error anywhere.
    """
    if not rm.get("sdf"):
        return
    sdf_path = SIM / rm["sdf"]
    if not sdf_path.exists():
        fails.append(f"{tag}: sdf {rm['sdf']} does not exist")
        return

    text = io.open(sdf_path, encoding="utf-8").read()
    plugin = re.search(r'<plugin[^>]*name="mars::MarsLink".*?</plugin>', text, re.S)
    if not plugin:
        fails.append(f"{tag}: {rm['sdf']} does not declare the mars::MarsLink plugin")
        return

    entries = re.findall(r"<actuator\s+([^>]*?)/>", plugin.group(0))
    sdf_joints, sdf_inverted = [], []
    for attrs in entries:
        joint = re.search(r'joint="([^"]+)"', attrs)
        sdf_joints.append(joint.group(1) if joint else "?")
        inv = re.search(r'inverted="([^"]+)"', attrs)
        sdf_inverted.append(inv is not None and inv.group(1) == "true")

    map_joints = [a["joint"] for a in rm["actuators"]]
    if sdf_joints != map_joints:
        fails.append(
            f"{tag}: the actuator order does not match"
            f" | sdf={sdf_joints} | map={map_joints}"
        )
        return

    # `inverted` lives on both sides and has to say the same thing, or the
    # robot spins in place when asked to go forward.
    map_inverted = [bool(a.get("inverted", False)) for a in rm["actuators"]]
    if sdf_inverted != map_inverted:
        fails.append(
            f"{tag}: 'inverted' does not match"
            f" | sdf={sdf_inverted} | map={map_inverted}"
        )

    # The CONTROL MODE also lives on both sides, and diverging is worse than
    # `inverted`: the bridge fills the gz.msgs.Actuators field the robot map
    # says, and the engine reads the one the SDF says. If they do not match,
    # the engine reads an array of zeros and the actuator stays still without
    # a single error.
    sdf_control = []
    for attrs in entries:
        mode = re.search(r'control="([^"]+)"', attrs)
        sdf_control.append(mode.group(1) if mode else "duty")
    map_control = [a.get("control", "duty") for a in rm["actuators"]]
    if sdf_control != map_control:
        fails.append(
            f"{tag}: the control mode does not match"
            f" | sdf={sdf_control} | map={map_control}"
        )
    for m in map_control:
        if m not in ("duty", "position"):
            fails.append(f"{tag}: invalid control mode {m!r}")


def check_robot_map(path, manifest, fails):
    rm = json.load(io.open(path, encoding="utf-8"))
    tag = Path(path).name

    if rm["protocol"] != manifest["protocol_version"]:
        fails.append(
            f"{tag}: protocol {rm['protocol']} != manifest"
            f" {manifest['protocol_version']}"
        )
    if rm["world"] != manifest["world"]:
        fails.append(f"{tag}: world {rm['world']} != manifest {manifest['world']}")
    if rm["profile"] not in ("hal", "vendor"):
        fails.append(f"{tag}: invalid profile {rm['profile']!r}")

    # Each encoder takes its gearRatio from the actuator that shares its
    # joint. Without that actuator the bridge cannot convert counts to meters.
    joints = {a["joint"] for a in rm["actuators"]}
    for e in rm["encoders"]:
        if e["joint"] not in joints:
            fails.append(f"{tag}: encoder {e['name']} points at {e['joint']}, with no actuator")

    # Two devices on the same HAL channel: the second overwrites the first and
    # the symptom shows up miles from the cause.
    for label, items in (("actuators", rm["actuators"]), ("encoders", rm["encoders"])):
        seen = {}
        for i in items:
            key = json.dumps(i["hal"], sort_keys=True)
            if key in seen:
                fails.append(
                    f"{tag}: {label} {seen[key]} and {i['name']} share channel {key}"
                )
            seen[key] = i["name"]

    names = [i["name"] for i in rm["actuators"] + rm["encoders"]]
    if len(names) != len(set(names)):
        fails.append(f"{tag}: duplicate names between actuators and encoders")

    check_actuator_order(rm, tag, fails)


def check(robot_maps):
    manifest = tomllib.load(open(HERE / "topics.toml", "rb"))
    readme = io.open(HERE / "README.md", encoding="utf-8").read()
    fails = []

    declared = check_manifest(manifest, readme, fails)
    check_worlds(manifest, fails)
    for path in robot_maps:
        check_robot_map(path, manifest, fails)

    return fails, len(declared)


def default_maps():
    """Every robot map in the repository, so adding one does not leave it unchecked."""
    found = [HERE / "robot-map.example.json"]
    found += sorted((SIM / "models").rglob("robot-map*.json"))
    return [str(p) for p in found]


if __name__ == "__main__":
    maps = sys.argv[1:] or default_maps()
    fails, n = check(maps)
    for f in fails:
        print(f"FAIL: {f}", file=sys.stderr)
    if fails:
        sys.exit(1)
    print(f"protocol consistent: {n} topics, {len(maps)} robot map(s)")
