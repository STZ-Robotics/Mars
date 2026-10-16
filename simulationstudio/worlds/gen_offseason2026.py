#!/usr/bin/env python3
"""Generates offseason2026.sdf and its robot-map: STZ's Offseason2026 swerve.

    python sim/worlds/gen_offseason2026.py

Reuses gen_swerve.py whole (the module geometry, the MarsLink, the field
hitboxes) and only changes the numbers that belong to THIS robot. It does not
touch swerve.sdf nor models/swerve/: the generic world stays as it was.

Every number below says where it comes from. If it changes there, change it
here and run the script again --- a simulation with another mass or another
current limit gives a robot that is not yours, and tuning against that is
useless.

  Offseason2026-main/src/main/java/frc/robot/configuration/constants/TunerConstants.java
  Offseason2026-main/src/main/deploy/pathplanner/settings.json

Some names here are a contract with tools in the robot's repository and stay
as they are: `models/offseason2026/mecanismo.json` and its keys (written by
convertir_mecanismo.py), the `cargador_NN` FUEL (moved by
cargador_virtual.py) and the `offseason2026_cancha.sdf` world.
"""
import io
import json
import re

import gen_swerve as g

# --- from TunerConstants.java -----------------------------------------------
IN = 0.0254
g.POS = 10.875 * IN                     # kFrontLeftXPos/YPos = 10.875 in
g.CORNERS = [("fl", g.POS, g.POS), ("fr", g.POS, -g.POS),
             ("bl", -g.POS, g.POS), ("br", -g.POS, -g.POS)]
g.WHEEL_RADIUS = 2.0 * IN               # kWheelRadius = 2 in (MK5n, 4" wheel)
g.DRIVE_RATIO = 5.2734375               # kDriveGearRatio
g.STEER_RATIO = 26.09090909090909       # kSteerGearRatio
# kCoupleRatio (3.375) does not go here: MarsSimGlue adds it, reading it from TunerConstants.

# kSlipCurrent = 120 A: CTRE applies it as the drive motor's STATOR limit, so
# it is the limit the real TalonFX has set. It is copied as is instead of
# computing the slip current like gen_swerve.py does: if the real robot starts
# out slipping with 120 A, the simulation has to slip the same, not hide it.
g.DRIVE_CURRENT_LIMIT = 120
# steerInitialConfigs: StatorCurrentLimit = 60 A.
g.STEER_CURRENT_LIMIT = 60

# CTRE's swerve leaves the drive TalonFX in Brake.
g.DRIVE_NEUTRAL = "brake"

# --- mass and inertia (PathPlanner's settings.json) --------------------------
# 58 kg with battery and bumpers: the CAD gives 43.3 kg without bumper, battery
# or unmodelled parts; the team estimates 54-62.
TOTAL_MASS = 58.0
# The CAD's Lzz (8693 in^2*kg = 5.61 kg*m^2 for 43.3 kg) + bumpers (~0.66) +
# battery (~0.1) + the rest (~0.3) = ~6.7; scaling proportionally gives 7.5.
# 7.0 is used.
TOTAL_MOI = 7.0

g.WHEEL_MASS = 0.8
g.STEER_MASS = 1.2
g.CHASSIS_MASS = TOTAL_MASS - 4 * (g.WHEEL_MASS + g.STEER_MASS)

# --- chassis measurements ----------------------------------------------------
# 27 in frame: an SDS wheel center sits 2.625 in from the frame's edge, and
# 10.875 + 2.625 = 13.5 in of half side. Plus 3.25 in bumpers per side =
# 33.5 in = 0.851 m. The collision box is the BUMPERS', which is what touches
# the walls.
FRAME = 2 * (10.875 + 2.625) * IN
BUMPER = 3.25 * IN
SIDE = FRAME + 2 * BUMPER
g.CHASSIS = (round(SIDE, 4), round(SIDE, 4), 0.15)

# --- world -------------------------------------------------------------------
# No physical FUEL and no field mesh: what matters here is the real-time
# factor (the robot code runs on wall time; if the physics runs at 0.5x,
# trajectory tracking looks worse than it is). The field hitboxes stay: walls
# and HUB still exist.
g.FUEL = 0
g.FIELD_VISUAL = "none"
g.HITBOXES = True

# Spawn shifted 1.25 m towards the blue HUB: the trajectory tuner
# (PathFollowingTuner) drives 2.5 m forward and back. From (0,0) the bumper
# would hit the red HUB (x = 2.73..4.26); from -1.25 the stretch goes from
# -1.68 to +1.68 bumpers included, clear between the two HUBs (+-2.73).
g.ROBOT_POSE = (-1.25, 0.0, 0.0, 0.0, 0.0, 0.0)

# The chassis' inertia does not come from "a 50 kg box": it is adjusted so the
# whole robot's about Z is TOTAL_MOI. The modules contribute m*r^2 for sitting
# at the corners (plus their own inertia, negligible next to it).
_original_box_inertia = g.box_inertia


def _chassis_inertia(m, x, y, z):
    ix, iy, iz = _original_box_inertia(m, x, y, z)
    if m != g.CHASSIS_MASS:
        return ix, iy, iz
    r2 = 2 * g.POS ** 2
    modules = 4 * (g.WHEEL_MASS + g.STEER_MASS) * r2
    iz = TOTAL_MOI - modules
    # A valid tensor needs iz <= ix + iy.
    return max(ix, iz / 2 * 1.02), max(iy, iz / 2 * 1.02), iz


g.box_inertia = _chassis_inertia


# The floor's mu exactly as gen_swerve.py writes it. The wheel's is 1.1 and the
# lower of the two wins, so varying the floor's varies the grip.
FLOOR_MU = "<mu>0.9</mu><mu2>0.9</mu2>"


def apply_mass(mass):
    """Changes the total mass. The inertia scales with it: same distribution."""
    global TOTAL_MASS, TOTAL_MOI
    TOTAL_MOI = TOTAL_MOI * mass / TOTAL_MASS
    TOTAL_MASS = mass
    g.CHASSIS_MASS = TOTAL_MASS - 4 * (g.WHEEL_MASS + g.STEER_MASS)


def to_lockstep(text):
    """The same physics without a real-time cap.

    In lockstep the robot code sets the pace (bridge with --lockstep-port,
    MarsLink waiting for every command); with real_time_factor 1 gz-sim would
    sleep between steps and lockstep would never go past real time. It opens
    with `run`: with no robot connected it runs free, at ~3x.
    """
    rtf = "<real_time_factor>1.0</real_time_factor>"
    assert rtf in text, "gen_swerve changed the <physics> block"
    return text.replace(rtf, "<real_time_factor>0</real_time_factor>")


# --- the real robot: CAD meshes and mechanisms ---------------------------------
# If models/offseason2026/mecanismo.json exists (written by
# Offseason2026-main/simustudio/gazebo/convertir_mecanismo.py from MARS
# Desktop's Mechanism3D), the chassis stops being an orange box: it carries the
# CAD meshes, the bumper and the tower as collision, and on top the mechanisms
# --- intake, dumper, shooter, box, rollers --- as links with their joint and
# their actuator. The swerve's physics does NOT change: same wheels, same
# reductions.
#
# Without the file the world comes out as before.
MECHANISM = g.SIM / "models" / "offseason2026" / "mecanismo.json"
# Physical FUEL in offseason2026_cancha.sdf. Each one is a dynamic body; see
# FUEL in gen_swerve.py before raising it.
FIELD_FUEL = 12
# The VIRTUAL LOADER (Offseason2026-main/simustudio/gazebo/cargador_virtual.py)
# needs two things from the world with the field:
#   - ApplyLinkWrench, to give a FUEL its exit velocity with a one-physics-step
#     impulse;
#   - the FUEL the robot carries PRELOADED: real bodies, parked away from the
#     field, that the loader teleports to the shooter's exit. The ones the
#     intake picks up end up in the same parking lot.
# The parking lot is a grid on the floor, outside the field (which measures
# 16.5 x 8.2 m around the origin): the floor is an infinite plane.
LOADER_PRELOAD = 8
PARKING = (30.0, 30.0)          # the grid's corner, in m
PARKING_STEP = 0.4              # spacing between balls, in m
PARKING_COLUMNS = 10


def parking_spot(i):
    """Where ball number i is kept. cargador_virtual.py uses the same grid."""
    x0, y0 = PARKING
    return (x0 + PARKING_STEP * (i % PARKING_COLUMNS),
            y0 + PARKING_STEP * (i // PARKING_COLUMNS))


def with_loader(text):
    """Adds ApplyLinkWrench and the preloaded FUEL to the world."""
    scene = '<plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"/>'
    assert scene in text, "gen_swerve changed the world's plugins"
    text = text.replace(scene, scene + '\n    <plugin filename="gz-sim-apply-link-wrench-system"'
                        ' name="gz::sim::systems::ApplyLinkWrench"/>', 1)
    L = ["    <!-- The robot's preloaded FUEL, parked outside the field. The",
         "         virtual loader moves them (simustudio/gazebo/cargador_virtual.py). -->"]
    for i in range(LOADER_PRELOAD):
        x, y = parking_spot(i)
        L += ["    <include>",
              "      <uri>model://fuel</uri>",
              f"      <name>cargador_{i + 1:02d}</name>",
              f"      <pose>{x:.2f} {y:.2f} {g.FUEL_RADIUS:.4f} 0 0 0</pose>",
              "    </include>"]
    robot = '    <model name="robot">'
    assert robot in text
    return text.replace(robot, "\n".join(L) + "\n\n" + robot, 1)


# Dry friction of the rollers and flywheels, in N*m on the joint. The Kraken
# delivers 7 N*m at stall: 0.03 is less than 1% of that.
ROLLER_FRICTION = 0.03
MODEL_URI = "model://offseason2026"


def load_mechanism():
    if not MECHANISM.is_file():
        return None
    return json.loads(MECHANISM.read_text(encoding="utf-8"))


def adjust_masses(mec):
    """The mechanisms weigh something: theirs is taken off the chassis and the robot stays at TOTAL_MASS.

    A prismatic also carries its motor's REFLECTED mass (J_rotor * n^2, which on
    a linear axis is kg): without it the motor's PD pushes a 2 kg box with
    800 N and the solver diverges, just like the steer did before gen_swerve
    added the reflected inertia.
    """
    total = 0.0
    for p in mec["piezas"]:
        p["link_mass"] = p["masa"]
        if p["tipo"] == "prismatic":
            p["link_mass"] += g.J_ROTOR * p["reduccion"] ** 2
        total += p["link_mass"]
    g.CHASSIS_MASS -= total
    if g.CHASSIS_MASS < 20:
        raise SystemExit(f"the mechanisms weigh {total:.1f} kg and leave the chassis at {g.CHASSIS_MASS:.1f}")
    # The chassis' collision is the CAD's bumper, not the 33.5 in estimate.
    g.CHASSIS = tuple(round(v, 4) for v in mec["bumper"]["tamano"])


def _part_inertia(p):
    """The link's tensor with the motor's reflected inertia on the joint axis."""
    i = list(p["inercia"])
    if p["tipo"] != "revolute":
        return i
    axis = [abs(c) for c in p["eje"]]
    k = axis.index(max(axis))
    if max(axis) < 0.999:
        raise SystemExit(f"{p['nombre']}: axis {p['eje']} is not aligned with X, Y or Z")
    i[k] += g.J_ROTOR * p["reduccion"] ** 2
    # Triangle inequality, same as with_reflected() in gen_swerve.
    minimum = i[k] / 2 * 1.02
    return [v if a == k else max(v, minimum) for a, v in enumerate(i)]


def _material(color):
    r, gr, b = color
    return (f"<material><ambient>{r * 0.45:.3f} {gr * 0.45:.3f} {b * 0.45:.3f} 1</ambient>"
            f"<diffuse>{r:.3f} {gr:.3f} {b:.3f} 1</diffuse>"
            f"<specular>0.15 0.15 0.15 1</specular></material>")


def with_mechanism(text, mec):
    """Puts the meshes and the mechanisms into the SDF gen_swerve generated."""
    z = g.CHASSIS_Z
    cx, cy, cz = g.CHASSIS

    # 1. The chassis' visual: the orange box becomes the CAD.
    box = re.compile(r'\s*<visual name="visual">\s*<geometry><box><size>'
                     + re.escape(f"{cx} {cy} {cz}") + r"</size></box></geometry>.*?</visual>", re.S)
    visuals = []
    for n, v in enumerate(mec["visuales_chasis"]):
        visuals.append(
            f'\n        <visual name="cad_{n}">'
            f"\n          <pose>0 0 {-z:.4f} 0 0 0</pose>"
            f"\n          <geometry><mesh><uri>{MODEL_URI}/{v['malla']}</uri></mesh></geometry>"
            f"\n          {_material(v['color'])}"
            f"\n        </visual>")
    text, n = box.subn(lambda _: "".join(visuals), text, count=1)
    assert n == 1, "gen_swerve changed the chassis' visual"

    # 2. The collision: the bumper at its real height, and the tower on top.
    old = f'<collision name="collision"><geometry><box><size>{cx} {cy} {cz}</size></box></geometry></collision>'
    assert old in text, "gen_swerve changed the chassis' collision"
    b, t = mec["bumper"], mec["colision_superior"]
    new = (
        f'<collision name="bumper"><pose>{b["centro"][0]} {b["centro"][1]} {b["centro"][2] - z:.4f} 0 0 0</pose>'
        f'<geometry><box><size>{cx} {cy} {cz}</size></box></geometry></collision>\n'
        f'        <collision name="tower"><pose>{t["centro"][0]} {t["centro"][1]} {t["centro"][2] - z:.4f} 0 0 0</pose>'
        f'<geometry><box><size>{" ".join(str(v) for v in t["tamano"])}</size></box></geometry></collision>')
    text = text.replace(old, new, 1)

    # 3. The modules' cylinders are not needed: the wheels are already in the
    #    CAD mesh. The links and their physics stay; only the drawings go.
    text, n = re.subn(r'\n\s*<visual name="visual">\s*<geometry><cylinder>.*?</visual>', "", text, flags=re.S)
    assert n == 8, f"expected 8 module visuals, there are {n}"

    # 4. The mechanisms, before the plugin.
    L = []
    w = L.append
    w("")
    w("      <!-- MECHANISMS. They come from MARS Desktop's Mechanism3D")
    w(f"           ({mec['fuente']}) via convertir_mecanismo.py: the pivot, the axis")
    w("           and the limits are the ones from there. Visual and mass only: they")
    w("           collide with nothing, so an arm does not push its own robot. -->")
    for p in mec["piezas"]:
        name = p["nombre"]
        px, py, pz = p["pivote"]
        ix, iy, iz = _part_inertia(p)
        mx, my, mz = p["centro_masa"]
        w("")
        w(f"      <!-- {p['pieza']} -> {name} ({p['control']}) -->")
        w(f'      <link name="{name}">')
        w(f"        <pose>{px} {py} {pz} 0 0 0</pose>")
        w("        <inertial>")
        w(f"          <pose>{mx} {my} {mz} 0 0 0</pose>")
        w(f"          <mass>{p['link_mass']:.4f}</mass>")
        w(f"          <inertia><ixx>{ix:.6f}</ixx><iyy>{iy:.6f}</iyy><izz>{iz:.6f}</izz>")
        w("            <ixy>0</ixy><ixz>0</ixz><iyz>0</iyz></inertia>")
        w("        </inertial>")
        w('        <visual name="cad">')
        w(f"          <pose>{-px} {-py} {-pz} 0 0 0</pose>")
        w(f"          <geometry><mesh><uri>{MODEL_URI}/{p['malla']}</uri></mesh></geometry>")
        w(f"          {_material(p['color'])}")
        w("        </visual>")
        w("      </link>")
        w(f'      <joint name="{name}_joint" type="{p["tipo"]}">')
        w(f"        <parent>chassis</parent><child>{name}</child>")
        w(f"        <axis><xyz>{' '.join(str(c) for c in p['eje'])}</xyz>")
        # A roller is light and spins at hundreds of rad/s: 0.01 N*m*s/rad there
        # is 5 N*m of braking at 500 rad/s, more than the torque the Kraken
        # delivers with its current limit, and the shooter did not get past
        # half its free speed. Measured: 0.0005 lets it reach ~95%.
        #
        # But with NOTHING else, a roller in coast never stops: any jolt of the
        # chassis sets it spinning and 0.0005 barely brakes it (measured: the
        # indexer oscillating at +-10 rad/s with duty 0, never stopping). What
        # stops it on the real robot is the DRY friction of bearings and belts,
        # which does not grow with speed: it fully stops a slow part and takes
        # almost nothing from the shooter at 500 rad/s.
        damping = 0.01 if p["control"] == "position" else 0.0005
        dry = "" if p["control"] == "position" else f"<friction>{ROLLER_FRICTION}</friction>"
        w(f"          <dynamics><damping>{damping}</damping>{dry}</dynamics>")
        lo, hi = p["limites"] if p["limites"] else (-1e16, 1e16)
        w(f"          <limit><lower>{lo}</lower><upper>{hi}</upper></limit></axis>")
        w("      </joint>")
    w("")
    mark = "\n      <!-- The ORDER is the contract"
    assert mark in text, "gen_swerve changed the plugin's comment"
    text = text.replace(mark, "\n".join(L) + mark, 1)

    # 5. Their actuators, at the end of the plugin: the order is the robot-map's.
    acts = []
    for p in mec["piezas"]:
        a = (f'        <actuator joint="{p["nombre"]}_joint" motor="{p["motor"]}"'
             f' gearRatio="{p["reduccion"]}" currentLimit="{p["limite_corriente"]}"')
        if p["control"] == "position":
            a += f' control="position" kp="{p["kp"]}" kd="{p["kd"]}"'
        acts.append(a + "/>")
    end = "      </plugin>"
    assert text.count(end) == 1
    return text.replace(end, "\n".join(acts) + "\n" + end, 1)


def map_with_mechanism(robot_map, mec):
    """The mechanisms' actuators go AFTER the swerve's eight, in the SDF's order."""
    for p in mec["piezas"]:
        robot_map["actuators"].append({
            "name": p["nombre"],
            "joint": f"{p['nombre']}_joint",
            "motor": p["motor"],
            "gearRatio": p["reduccion"],
            "inverted": False,
            "control": p["control"],
            "hal": {"kind": "pwm", "channel": len(robot_map["actuators"])},
        })
        robot_map["encoders"].append({
            "name": f"{p['nombre']}_enc",
            "joint": f"{p['nombre']}_joint",
            "countsPerRevolution": 42 if p["motor"].startswith("neo") else 2048,
            "hal": {"kind": "encoder", "index": len(robot_map["encoders"])},
        })
    return robot_map


def write(path, text):
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    print(f"wrote {path.relative_to(g.SIM)}")


# What MARS Simulation Studio offers for this world (see gen_swerve.py's OPTIONS
# for the contract). The mass and the floor's grip are the two numbers the
# trajectory autotune varies; everything else is this robot's and is fixed above.
OPTIONS = [
    {
        "name": "mass",
        "label": "Total mass",
        "type": "int",
        "min": 40,
        "max": 80,
        "unit": "kg",
        "help": "With battery and bumpers. The inertia scales with it, same"
                " distribution. The team's estimate is 54-62 kg.",
    },
    {
        "name": "floor_mu",
        "label": "Floor grip",
        "type": "int",
        "min": 50,
        "max": 120,
        "unit": "mu x 100",
        "help": "The carpet's friction coefficient, times 100. The wheel declares"
                " 1.1 and the lower of the two wins, so above 110 nothing"
                " changes.",
    },
]


def main():
    import argparse

    cli = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    # --masa and --sufijo are the names the robot repository's autotune used
    # before this script was in English; they stay as aliases.
    cli.add_argument("--mass", "--masa", dest="mass", type=float, default=None,
                     help=f"total mass in kg (default {TOTAL_MASS}); the inertia scales the same")
    cli.add_argument("--mu", type=float, default=None,
                     help="the floor's friction coefficient (default 0.9)")
    cli.add_argument("--suffix", "--sufijo", dest="suffix", default=None,
                     help="writes ONLY worlds/offseason2026_<suffix>_lockstep.sdf, "
                          "a variant for the robust autotune, without touching the "
                          "nominal world or the robot-map")
    # For MARS Simulation Studio, like gen_swerve.py: --options says what can
    # be changed and --set changes it.
    cli.add_argument("--options", action="store_true",
                     help="print this generator's options as JSON and exit")
    cli.add_argument("--set", dest="sets", action="append", metavar="KEY=VALUE",
                     default=[], help="set one option by name; repeatable")
    args = cli.parse_args()

    if args.options:
        print(json.dumps({
            "file": "offseason2026",
            "generates": ["worlds/offseason2026.sdf", "worlds/offseason2026_lockstep.sdf",
                          "worlds/offseason2026_cancha.sdf", "models/offseason2026/robot-map.json"],
            "options": [dict(OPTIONS[0], default=round(TOTAL_MASS)),
                        dict(OPTIONS[1], default=90)],
        }, indent=2))
        raise SystemExit(0)

    for item in args.sets:
        key, _, value = item.partition("=")
        if key == "mass":
            args.mass = float(value)
        elif key == "floor_mu":
            args.mu = int(value) / 100
        else:
            raise SystemExit(f"unknown option: {key}")

    if args.mass is not None:
        apply_mass(args.mass)
    mec = load_mechanism()
    if mec is not None:
        adjust_masses(mec)
    text = g.generate_sdf()
    if mec is not None:
        text = with_mechanism(text, mec)
    if args.mu is not None:
        assert FLOOR_MU in text, "gen_swerve changed the floor's <friction>"
        text = text.replace(FLOOR_MU, f"<mu>{args.mu}</mu><mu2>{args.mu}</mu2>")

    mechanism_mass = sum(p["link_mass"] for p in mec["piezas"]) if mec is not None else 0.0
    summary = (f"mass {g.CHASSIS_MASS + 4 * (g.WHEEL_MASS + g.STEER_MASS) + mechanism_mass:.1f} kg, "
               f"robot izz {TOTAL_MOI:.2f}, mu {args.mu if args.mu is not None else 0.9}")

    if args.suffix:
        write(g.SIM / "worlds" / f"offseason2026_{args.suffix}_lockstep.sdf", to_lockstep(text))
        print(summary)
        return

    write(g.SIM / "worlds" / "offseason2026.sdf", text)
    write(g.SIM / "worlds" / "offseason2026_lockstep.sdf", to_lockstep(text))

    # The same robot on the drawn 2026 field with FUEL in front: the world for
    # DRIVING and watching the mechanisms. The nominal one above carries no
    # field mesh on purpose (it is the autotune's, and there the real-time
    # factor rules); this one does, in "lite", which a laptop holds at RTF ~1.
    if (g.SIM / g.FIELD).is_file():
        g.FIELD_VISUAL, g.FUEL = "lite", FIELD_FUEL
        field = g.generate_sdf()
        if mec is not None:
            field = with_mechanism(field, mec)
        write(g.SIM / "worlds" / "offseason2026_cancha.sdf", with_loader(field))
        g.FIELD_VISUAL, g.FUEL = "none", 0
    else:
        print(f"no {g.FIELD}: offseason2026_cancha.sdf is not written")

    robot_map = g.generate_robot_map()
    if mec is not None:
        robot_map = map_with_mechanism(robot_map, mec)
    robot_map["$comment"] = ("GENERATED by sim/worlds/gen_offseason2026.py together with "
                             "offseason2026.sdf. Do not edit by hand.")
    robot_map["robot"] = "offseason2026"
    robot_map["sdf"] = "worlds/offseason2026.sdf"
    path = g.SIM / "models" / "offseason2026" / "robot-map.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    write(path, json.dumps(robot_map, indent=2, ensure_ascii=False) + "\n")

    print(f"chassis {g.CHASSIS[0]:.3f} x {g.CHASSIS[1]:.3f} m, {summary}, "
          f"chassis izz {_chassis_inertia(g.CHASSIS_MASS, *g.CHASSIS)[2]:.2f}, "
          f"drive {g.DRIVE_CURRENT_LIMIT} A {g.DRIVE_NEUTRAL}")


if __name__ == "__main__":
    main()
