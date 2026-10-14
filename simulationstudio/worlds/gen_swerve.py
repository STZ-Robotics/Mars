#!/usr/bin/env python3
"""Generates swerve.sdf and the robot map that goes with it.

    python sim/worlds/gen_swerve.py

It exists because a swerve is four modules identical except for their corner:
writing them by hand is ~400 lines of repeated XML where a flipped sign goes
unnoticed, and the inertias have to be computed anyway. Generating both files
from the same script also guarantees the ORDER of the actuators matches, which
is what check.py verifies afterwards.

Re-running it overwrites both files; if the robot needs a change by hand,
change this script and run it again.
"""
import io
import json
import math
from pathlib import Path

from field_2026 import (
    FUEL_RADIUS, ensure_optimized, ensure_without_fuel, hitboxes,
    inside_the_field, positions, push_out_of_boxes,
)

HERE = Path(__file__).parent
SIM = HERE.parent

# The 3D field, relative to sim/. If it is not installed (the Studio's Field
# Library) the world is generated anyway, with the usual plain floor.
FIELD = "fields/2026-rebuilt/model.glb"

# Which field mesh goes into the world. It is by far the most expensive thing
# the Gazebo window draws.
#
#   "lite"  the trimmed field: out go the baked FUEL and everything smaller
#           than 12 cm --- PEM nuts, rivets, bushings, hardware. 2929
#           instances and 4.28 M triangles become 1321 and 2.29 M, and you
#           cannot tell by looking: nothing 5 mm across is visible from a
#           camera framing a 70 cm robot. field_2026.py generates it.
#   "full"  the whole official mesh, with every rivet modelled.
#   "none"  no field: the usual plain floor. It is the real lever for a
#           machine that is struggling.
#
# The HITBOXES do not depend on this and always come from the OFFICIAL model,
# not the trimmed one: the physics has to be the real field's even if the
# drawing has six millimeters less of bolt.
FIELD_VISUAL = "lite"

# --- FUEL with physics -----------------------------------------------------
# HOW MANY FUEL with physics the world carries. 0 = none.
#
# The number matters more than anything else in this file, because each ball
# is a dynamic body and they are the only thing that grows by the hundreds.
# Measured on this machine, 10 s of simulation not counting startup:
#
#   FUEL = 0 or 1    10 s of wall time  ->  RTF 1.00
#   FUEL = 408       21 s of wall time  ->  RTF 0.48
#
# At RTF 0.48 the world does not just run at half real time: the Gazebo window
# has to draw 408 moving bodies, and between the two the robot does not
# respond. Seeding the whole field looks great in a screenshot and cannot be
# driven.
#
# The ones closest to the spawn point are chosen, skipping those that would
# land under the robot: with FUEL = 1 you get the one right in front of you to
# test an intake.
FUEL = 1

# Whether the field mesh keeps its 456 BAKED FUEL (glTF nodes, with no
# collision and no mass). With False a copy without them is used, which is
# right when this generator places the real ones: otherwise there are two
# balls in every spot, the fake one that never moves and the physical one on
# top.
#
# Setting it to True only makes sense with FUEL = 0 and FIELD_VISUAL = "full",
# to see the whole field as scenery.
DECORATIVE_FUEL = False

# --- field hitboxes --------------------------------------------------------
# The field mesh is ONLY visual: 2.9 M triangles, and using it as collision
# would have the solver resolve mesh-mesh contact, the most expensive thing a
# physics engine does. Without this the robot drives through the driver
# station wall, the HUB and everything else.
#
# They are boxes, and they come from the glTF's own AABBs --- see
# field_2026.py, which also explains which ones go in and why the trench and
# the bumps do not.
#
# VISIBLE_HITBOXES draws them translucent over the mesh. It is for checking
# that each box lands where it should; for driving, they get in the way.
# (Gazebo also shows them from the entity tree, right click > View >
# Collisions, but that has to be done on every start.)
HITBOXES = True
VISIBLE_HITBOXES = False

# --- robot geometry --------------------------------------------------------
# ALL of these numbers come from the robot project's TunerConstants.java. If
# they change there, they change here too: a simulation with another
# reduction or another wheel radius gives speeds that are not the robot's, and
# tuning against that is useless.
#
#   kFrontLeftXPos/YPos  = 10.8545 in = 0.27570 m
#   kWheelRadius         = 2 in       = 0.05080 m
#   kDriveGearRatio      = 5.2734375
#   kSteerGearRatio      = 26.09090909090909
POS = 0.27570           # half the distance between wheels, in X and in Y
CORNERS = [("fl", POS, POS), ("fr", POS, -POS),
           ("bl", -POS, POS), ("br", -POS, -POS)]

WHEEL_RADIUS = 0.0508   # kWheelRadius: 2 inches of RADIUS
WHEEL_WIDTH = 0.045
WHEEL_MASS = 0.8
STEER_MASS = 1.2        # the body of the module that rotates
CHASSIS_MASS = 45.0
# Chassis somewhat bigger than the wheel footprint, like a real bumper.
CHASSIS = (0.72, 0.72, 0.15)
CHASSIS_Z = 0.20

# Where the robot spawns. Besides being written into the <include>, it decides
# which FUEL are seeded: the ones closest to this point.
ROBOT_POSE = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

DRIVE_RATIO = 5.2734375            # kDriveGearRatio
STEER_RATIO = 26.09090909090909    # kSteerGearRatio
CPR = 2048              # Kraken integrated encoder

# --- current limit ---------------------------------------------------------
# The SLIP CURRENT: the one that makes the wheel deliver exactly the force the
# carpet can hold. It is the same number CTRE calls kSlipCurrent in
# TunerConstants, and it is what separates a robot launch from a launch
# burning rubber.
#
# Without a limit, the DC model delivers the Kraken's 366 A stall: 736 N per
# wheel against ~117 N of grip. The simulated robot ALWAYS slips on launch and
# the real one does not, because its TalonFX has the limit set and the
# simulation had not heard about it.
#
# It is computed here and not written by hand so it stays true if the mass,
# the radius or the reduction change.
CARPET_MU = 0.9         # the floor's mu; the wheel declares 1.1 and the lower wins
KRAKEN_KT = 7.09 / 366  # stall torque / stall current, from MarsLink.cc


def slip_current():
    mass = CHASSIS_MASS + 4 * (WHEEL_MASS + STEER_MASS)
    force_per_wheel = CARPET_MU * mass * 9.81 / 4
    motor_torque = force_per_wheel * WHEEL_RADIUS / DRIVE_RATIO
    return motor_torque / KRAKEN_KT


DRIVE_CURRENT_LIMIT = round(slip_current())

# The steering does not have to put anything on the ground: its limit is the
# hardware's, not the floor's. 60 A is what CTRE's swerve template sets, and
# with the joint's reflected inertia it still reaches 90 degrees in ~0.15 s.
STEER_CURRENT_LIMIT = 60

# What the drive motor does when nothing is asked of it.
#
#   "coast"  open circuit: the wheel spins free. It is a TalonFX's factory
#            default and it is what makes the robot roll when the stick is
#            released.
#   "brake"  shorts the motor and its back-EMF brakes it. Measured: it brakes
#            at 8.8 m/s^2, which is ALL of the carpet's grip, i.e. an
#            emergency stop every time the stick is centered.
#
# The steering does not carry it: a module in position mode is always asking
# for something, so its neutral does not exist in practice.
DRIVE_NEUTRAL = "coast"

# Kraken X60 rotor inertia, in kg*m^2. Approximate: the exact value is not
# published and this one is of the right order for a rotor of that class.
#
# It is NOT a detail. MarsLink multiplies the TORQUE by the reduction, but the
# INERTIA the motor presents to the joint goes with the reduction SQUARED
# (J_reflected = J_rotor * n^2), and that has to come from the model because
# the motor cannot touch the ECS's inertias.
#
# Without it, a 12.8:1 steering gets 90 N*m on a 0.0015 kg*m^2 body: 60000
# rad/s^2, i.e. 240 rad/s in a single 4 ms step. The solver diverges on the
# first cycle and the robot flies off. With the reflected one, that same
# steering has 164 times the inertia and behaves.
J_ROTOR = 4.2e-5

# Viscous friction of the joints, in N*m*s/rad.
#
# CAREFUL WITH THIS NUMBER. A motor's dominant damping is not the gearbox's
# friction: it is its own back-EMF, and MarsLink already applies it. For the
# Kraken on the steering it is
#
#   b_bemf = Kt * n^2 / (Kv * R) = 0.0194 * 26.09^2 / (52.7 * 0.0328)
#          = 7.6 N*m*s/rad
#
# so the joint ALREADY comes damped from the factory. This here is only the
# gearbox's mechanical loss, which is small.
#
# There used to be 1.5 here, which sounded conservative and was not: added to
# the motor's 7.6 it left the position loop with a time constant of 1.7 s ---
# measured with `bridge/src/bin/swerve-step.rs`, the steering reached 73 of 90
# degrees in THREE seconds. A robot whose wheels take a second to point drags
# them sideways on every change of direction: it looks like slipping and feels
# like an inertia the robot does not have.
STEER_DAMPING = 0.05
#
# And the drive one is not free either: 0.02 N*m*s/rad is 2.2 N*m per wheel at
# top speed, i.e. 177 N against a 53 kg robot --- 3.3 m/s^2 of braking from the
# joint's damping alone, with the motor asking for nothing. A real drivetrain
# drags quite a bit less: 0.004 leaves about 0.7 m/s^2, which is what a swerve
# rolling in neutral loses.
DRIVE_DAMPING = 0.004

# Gains of the position loop the motor closes, in duty per radian and per
# rad/s OF THE JOINT.
#
# Sized against what is really on the steering joint: reflected inertia
# J = J_rotor * n^2 + the body's = 0.031 kg*m^2, and 185 N*m per unit of duty
# (7.09 N*m of stall times 26.09 of reduction).
#
#   k  = KP * 185 = 166 N*m/rad
#   b  = 7.6 (bemf) + KD * 185 (1.9) + 0.05 (joint) = 9.5 N*m*s/rad
#   -> zeta = b / (2*sqrt(k*J)) = 2.1   (overdamped, no overshoot)
#   -> slow pole k/b = 17.5 1/s, i.e. a ~0.06 s time constant
#
# KP=0.9 saturates the duty for errors above ~64 degrees, and that is RIGHT:
# a real TalonFX puts full voltage on a 90 degree error and gets there in
# ~0.15 s, limited by the motor's free speed (24 rad/s at the joint), not by
# the gain.
STEER_KP = 0.9
STEER_KD = 0.01


def box_inertia(m, x, y, z):
    return (m / 12 * (y * y + z * z), m / 12 * (x * x + z * z), m / 12 * (x * x + y * y))


def cylinder_inertia(m, r, h):
    """Axis along local Z: axial = m r^2/2, perpendicular = m(3r^2 + h^2)/12."""
    perp = m * (3 * r * r + h * h) / 12
    return (perp, perp, m * r * r / 2)


def with_reflected(ix, iy, iz, j_ref):
    """Adds the rotor's reflected inertia without breaking the tensor.

    The reflected inertia acts ONLY on the joint's axis, but no rigid body can
    have a tensor like that: the principal moments have to satisfy the
    triangle inequality (each one <= the sum of the other two). Adding it to
    izz alone gives `Error Code 19: A link has invalid inertia` and the world
    does not load.

    The way out is to also raise the perpendicular ones to the minimum that
    makes the tensor valid. It exaggerates the link's off-axis inertia, but
    these are ~1 kg parts next to a 45 kg chassis: next to the reflected
    inertia that was being lost, the error is negligible.
    """
    iz += j_ref
    # The 2% margin is not cosmetic: the values are printed rounded, and with
    # a finer margin the rounding itself violates the inequality again.
    minimum = iz / 2 * 1.02
    return (max(ix, minimum), max(iy, minimum), iz)


def pick_fuel(count):
    """The `count` staged FUEL closest to the robot's spawn.

    By proximity and not by file order because with few balls the only thing
    that matters is having them AT HAND: with just one, the one that comes out
    is the one the robot has in front of it to test an intake, not one lost
    at the other end.

    The ones that would land UNDER the robot are skipped. The center band
    goes right through the spawn, and a ball born inside the chassis flies off
    on the first step --- the solver has to separate them and can only do it
    by shoving.
    """
    # Half the chassis diagonal plus the ball's radius: the circle the robot
    # really occupies, not its side.
    clear = math.hypot(CHASSIS[0], CHASSIS[1]) / 2 + FUEL_RADIUS

    def distance(p):
        return math.hypot(p[0] - ROBOT_POSE[0], p[1] - ROBOT_POSE[1])

    inside = [p for p in positions(SIM / FIELD)
              if inside_the_field(p) and distance(p) > clear]
    inside.sort(key=distance)
    return inside[:count]


def generate_sdf():
    ix, iy, iz = box_inertia(CHASSIS_MASS, *CHASSIS)
    rix, riy, riz = cylinder_inertia(WHEEL_MASS, WHEEL_RADIUS, WHEEL_WIDTH)
    six, siy, siz = cylinder_inertia(STEER_MASS, 0.05, 0.12)
    # The joint axis is local Z in both cases.
    six, siy, siz = with_reflected(six, siy, siz, J_ROTOR * STEER_RATIO ** 2)
    rix, riy, riz = with_reflected(rix, riy, riz, J_ROTOR * DRIVE_RATIO ** 2)
    cx, cy, cz = CHASSIS

    L = []
    w = L.append
    w('<?xml version="1.0" ?>')
    w("<!--")
    w("  Four-module swerve on Kraken X60.")
    w("")
    w("  GENERATED by sim/worlds/gen_swerve.py. To change the robot, change the")
    w("  script and run it again, not this file.")
    w("")
    w("  Each module is TWO joints: a steering one about Z (the whole module")
    w("  body rotates) and a drive one about the wheel's axle. The wheel link")
    w("  hangs from the steering one and not from the chassis, because turning")
    w("  the steering has to drag the wheel along with it.")
    w("")
    w("  The steering joints have NO stop and NO spring: with zero torque they")
    w("  are free and lateral forces move them, just like a real module with no")
    w("  current. The robot code has to close the position loop.")
    w("  sim/bridge/fake-robot.py does it with a P so it can be tested.")
    w("")
    w("  The field's limits are collision boxes taken from the official model:")
    w("  guardrails, the six driver stations, the towers, the outposts and both")
    w("  HUBs. They are turned off with HITBOXES in the generator.")
    w("-->")
    w('<sdf version="1.11">')
    w('  <world name="mars">')
    w("")
    w('    <physics name="250hz" type="ignored">')
    w("      <max_step_size>0.004</max_step_size>")
    w("      <real_time_factor>1.0</real_time_factor>")
    w("    </physics>")
    w("")
    w('    <plugin filename="gz-sim-physics-system" name="gz::sim::systems::Physics"/>')
    w('    <plugin filename="gz-sim-user-commands-system" name="gz::sim::systems::UserCommands"/>')
    w('    <plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"/>')
    w("")
    w("    <gravity>0 0 -9.8</gravity>")
    w("")
    w('    <light type="directional" name="sun">')
    w("      <pose>0 0 10 0 0 0</pose>")
    w("      <diffuse>0.8 0.8 0.8 1</diffuse>")
    w("      <direction>-0.5 0.1 -0.9</direction>")
    w("    </light>")
    w("")
    # The real FRC field, if it is installed in sim/fields/. It is a VISUAL
    # and nothing more: it is ~2.9 M triangles and using it as collision would
    # have the solver resolve mesh-mesh contact, the most expensive thing a
    # physics engine does. Collision still comes from the plane and, if
    # needed, the walls. The robot starts at 0,0, which is the CENTER of the
    # field; the bridge is the one that translates to WPILib's corner origin.
    has_field = (SIM / FIELD).is_file()
    field = None
    if has_field and FIELD_VISUAL != "none":
        if FIELD_VISUAL == "lite":
            field = ensure_optimized(FIELD)
        elif DECORATIVE_FUEL:
            field = FIELD
        else:
            field = ensure_without_fuel(FIELD)

    # The physical FUEL replace the baked ones: the visual becomes the copy
    # without them, or you would see two balls in every spot --- the glTF's,
    # which never moves, and the real one on top.
    fuel = []
    if FUEL > 0 and has_field:
        fuel = pick_fuel(FUEL)
        if HITBOXES:
            # Twelve of the ones against the driver station wall land 12 mm
            # inside its hitbox. See push_out_of_boxes().
            prior_boxes = hitboxes(SIM / FIELD)
            fuel = [push_out_of_boxes(p, prior_boxes) for p in fuel]

    w('    <model name="ground_plane">')
    w("      <static>true</static>")
    w('      <link name="link">')
    w('        <collision name="collision">')
    w("          <geometry><plane><normal>0 0 1</normal></plane></geometry>")
    w("          <surface><friction><ode><mu>0.9</mu><mu2>0.9</mu2></ode></friction></surface>")
    w("        </collision>")
    if field is None:
        # With the field in place the floor loses its visual: two surfaces at
        # z = 0 produce z-fighting, that striped flicker that looks like a
        # renderer bug and is duplicated geometry.
        w('        <visual name="visual">')
        w("          <geometry><plane><normal>0 0 1</normal><size>16.54 8.21</size></plane></geometry>")
        w("          <material><ambient>0.16 0.17 0.19 1</ambient><diffuse>0.30 0.32 0.36 1</diffuse></material>")
        w("        </visual>")
    w("      </link>")
    w("    </model>")
    w("")

    if field is not None:
        # 90 degrees of roll because the glTF comes Y-up and Gazebo is Z-up.
        w('    <model name="frc_field">')
        w("      <static>true</static>")
        w("      <pose>0 0 0 1.570796 0 0</pose>")
        w('      <link name="link">')
        w('        <visual name="visual">')
        w("          <cast_shadows>false</cast_shadows>")
        w(f"          <geometry><mesh><uri>{field}</uri></mesh></geometry>")
        w("        </visual>")
        w("      </link>")
        w("    </model>")
        w("")

    if HITBOXES and has_field:
        boxes = hitboxes(SIM / FIELD)
        w("    <!-- The field's PHYSICS: the mesh above has no collision at all,")
        w("         so without these boxes the robot drives through the driver")
        w("         station wall and the HUB.")
        w("")
        w("         The sizes come from the AABBs of the official glTF's nodes,")
        w("         not from a hand-written table. Which ones go in and why the")
        w("         trench and the bumps are NOT here: worlds/field_2026.py. -->")
        w('    <model name="field_collision">')
        w("      <static>true</static>")
        w('      <link name="link">')
        # WATCH the names: `cx, cy, cz` are the CHASSIS size and are used
        # further down. Reusing them here gave the robot a 3.49 x -0.005 x
        # 1.54 collision box --- which sdformat rejects as negative and
        # replaces with 1x1x1, i.e. a one-meter chassis half buried in the
        # floor. The robot got stuck burning rubber and the only trace was an
        # sdformat warning in the middle of startup.
        for name, (hx, hy, hz), (dx, dy, dz), (rr, rp, ry) in boxes:
            box = f"<box><size>{dx:.4f} {dy:.4f} {dz:.4f}</size></box>"
            pose = f"{hx:.4f} {hy:.4f} {hz:.4f} {rr:.5f} {rp:.5f} {ry:.5f}"
            w(f'        <collision name="{name}">')
            w(f"          <pose>{pose}</pose>")
            w(f"          <geometry>{box}</geometry>")
            w("        </collision>")
            if VISIBLE_HITBOXES:
                w(f'        <visual name="{name}_visual">')
                w(f"          <pose>{pose}</pose>")
                w(f"          <geometry>{box}</geometry>")
                w("          <transparency>0.65</transparency>")
                w("          <material>")
                w("            <ambient>0.91 0.39 0.16 0.35</ambient>")
                w("            <diffuse>0.91 0.39 0.16 0.35</diffuse>")
                w("          </material>")
                w("        </visual>")
        w("      </link>")
        w("    </model>")
        w("")

    if fuel:
        w(f"    <!-- {len(fuel)} FUEL with physics, in the exact spot where the")
        w("         field mesh used to draw them: the positions come from the")
        w("         glTF's nodes, not from a hand-written table. They are the")
        w("         ones closest to the robot's spawn; the feeder's are not here.")
        w("")
        w("         Each one is a dynamic body: with 408 the world runs at half")
        w("         real time and cannot be driven. The count is FUEL, in")
        w("         gen_swerve.py. -->")
        for i, (x, y, z) in enumerate(fuel, 1):
            w("    <include>")
            w("      <uri>model://fuel</uri>")
            w(f"      <name>fuel_{i:03d}</name>")
            w(f"      <pose>{x:.4f} {y:.4f} {max(z, FUEL_RADIUS):.4f} 0 0 0</pose>")
            w("    </include>")
        w("")
    w('    <model name="robot">')
    w(f"      <pose>{' '.join(str(v) for v in ROBOT_POSE)}</pose>")
    w("")
    w('      <link name="chassis">')
    w(f"        <pose>0 0 {CHASSIS_Z} 0 0 0</pose>")
    w("        <inertial>")
    w(f"          <mass>{CHASSIS_MASS}</mass>")
    w(f"          <inertia><ixx>{ix:.4f}</ixx><iyy>{iy:.4f}</iyy><izz>{iz:.4f}</izz>")
    w("            <ixy>0</ixy><ixz>0</ixz><iyz>0</iyz></inertia>")
    w("        </inertial>")
    w(f'        <collision name="collision"><geometry><box><size>{cx} {cy} {cz}</size></box></geometry></collision>')
    w('        <visual name="visual">')
    w(f"          <geometry><box><size>{cx} {cy} {cz}</size></box></geometry>")
    w("          <material>")
    w("            <ambient>0.35 0.15 0.06 1</ambient>")
    w("            <diffuse>0.91 0.39 0.16 1</diffuse>")
    w("            <specular>0.3 0.3 0.3 1</specular>")
    w("          </material>")
    w("        </visual>")
    w("      </link>")

    for side, x, y in CORNERS:
        w("")
        w(f"      <!-- module {side} -->")
        w(f'      <link name="{side}_steer">')
        w(f"        <pose>{x} {y} 0.12 0 0 0</pose>")
        w("        <inertial>")
        w(f"          <mass>{STEER_MASS}</mass>")
        w(f"          <inertia><ixx>{six:.6f}</ixx><iyy>{siy:.6f}</iyy><izz>{siz:.6f}</izz>")
        w("            <ixy>0</ixy><ixz>0</ixz><iyz>0</iyz></inertia>")
        w("        </inertial>")
        w('        <visual name="visual">')
        w("          <geometry><cylinder><radius>0.05</radius><length>0.12</length></cylinder></geometry>")
        w("          <material><ambient>0.25 0.26 0.3 1</ambient><diffuse>0.62 0.65 0.72 1</diffuse></material>")
        w("        </visual>")
        w("      </link>")
        w("")
        w(f'      <link name="{side}_wheel">')
        w(f"        <pose>{x} {y} {WHEEL_RADIUS} -1.5707963 0 0</pose>")
        w("        <inertial>")
        w(f"          <mass>{WHEEL_MASS}</mass>")
        w(f"          <inertia><ixx>{rix:.6f}</ixx><iyy>{riy:.6f}</iyy><izz>{riz:.6f}</izz>")
        w("            <ixy>0</ixy><ixz>0</ixz><iyz>0</iyz></inertia>")
        w("        </inertial>")
        w('        <collision name="collision">')
        w(f"          <geometry><cylinder><radius>{WHEEL_RADIUS}</radius><length>{WHEEL_WIDTH}</length></cylinder></geometry>")
        w("          <surface><friction><ode><mu>1.1</mu><mu2>1.1</mu2></ode></friction></surface>")
        w("        </collision>")
        w('        <visual name="visual">')
        w(f"          <geometry><cylinder><radius>{WHEEL_RADIUS}</radius><length>{WHEEL_WIDTH}</length></cylinder></geometry>")
        w("          <material><ambient>0.05 0.05 0.06 1</ambient><diffuse>0.13 0.13 0.15 1</diffuse></material>")
        w("        </visual>")
        w("      </link>")
        w("")
        w(f'      <joint name="{side}_steer_joint" type="revolute">')
        w(f"        <parent>chassis</parent><child>{side}_steer</child>")
        w("        <axis><xyz>0 0 1</xyz>")
        w(f"          <dynamics><damping>{STEER_DAMPING}</damping></dynamics>")
        w("          <limit><lower>-1e16</lower><upper>1e16</upper></limit></axis>")
        w("      </joint>")
        w(f'      <joint name="{side}_drive_joint" type="revolute">')
        w(f"        <parent>{side}_steer</parent><child>{side}_wheel</child>")
        w("        <axis><xyz>0 0 1</xyz>")
        w(f"          <dynamics><damping>{DRIVE_DAMPING}</damping></dynamics>")
        w("          <limit><lower>-1e16</lower><upper>1e16</upper></limit></axis>")
        w("      </joint>")

    w("")
    w("      <!-- The ORDER is the contract: it defines the index inside")
    w("           gz.msgs.Actuators.normalized. The robot map lists its own in")
    w("           the same order and check.py verifies it.")
    w("")
    w(f"           Current limit: {DRIVE_CURRENT_LIMIT} A on drive (the slip")
    w("           current, computed from the mass and the mu) and")
    w(f"           {STEER_CURRENT_LIMIT} A on steering.")
    w("")
    w(f"           The robot's real reductions: {DRIVE_RATIO} drive,")
    w(f"           {STEER_RATIO:.3f} steering. They come from TunerConstants.java. -->")
    w('      <plugin filename="MarsLink" name="mars::MarsLink">')
    for side, _, _ in CORNERS:
        # neutralMode="coast": with no command, the motor opens the circuit
        # and the wheel spins free, like a factory TalonFX. With "brake" the
        # robot brakes at the grip limit as soon as the driver lets go of the
        # stick.
        w(f'        <actuator joint="{side}_drive_joint" motor="kraken_x60"'
          f' gearRatio="{DRIVE_RATIO}" currentLimit="{DRIVE_CURRENT_LIMIT}"'
          f' neutralMode="{DRIVE_NEUTRAL}"/>')
        # The steering closes POSITION in the motor, like a real TalonFX. The
        # robot code sends it an angle, not a duty.
        w(f'        <actuator joint="{side}_steer_joint" motor="kraken_x60"'
          f' gearRatio="{STEER_RATIO}" control="position"'
          f' currentLimit="{STEER_CURRENT_LIMIT}"'
          f' kp="{STEER_KP}" kd="{STEER_KD}"/>')
    w("      </plugin>")
    w("    </model>")
    w("")
    w("  </world>")
    w("</sdf>")
    return "\n".join(L) + "\n"


def generate_robot_map():
    actuators, encoders = [], []
    for side, _, _ in CORNERS:
        # The order has to be the same as the SDF's <actuator>s.
        for kind, ratio in (("drive", DRIVE_RATIO), ("steer", STEER_RATIO)):
            name = f"{side}_{kind}"
            actuators.append({
                "name": name,
                "joint": f"{name}_joint",
                "motor": "kraken_x60",
                "gearRatio": ratio,
                "inverted": False,
                # The steering goes in position mode; the drive, in duty. It
                # has to match the SDF's `control` attribute and check.py
                # verifies it: if they diverge, the motor reads a field the
                # bridge does not fill and the actuator stays still without
                # any error.
                "control": "position" if kind == "steer" else "duty",
                "hal": {"kind": "pwm", "channel": len(actuators)},
            })
            encoders.append({
                "name": f"{name}_enc",
                "joint": f"{name}_joint",
                "countsPerRevolution": CPR,
                "hal": {"kind": "encoder", "index": len(encoders)},
            })

    return {
        "$comment": "GENERATED by sim/worlds/gen_swerve.py together with swerve.sdf. "
                    "They are generated by the same script so the ORDER of the "
                    "actuators cannot diverge between the two.",
        "protocol": "0.1.0",
        "robot": "swerve",
        "world": "mars",
        "model": "robot",
        "profile": "vendor",
        "$comment_profile": "vendor: CAN motors (Kraken on TalonFX). The hardware "
                            "loop goes through the glue over NT4 because HALSim "
                            "WebSocket does not cover CAN.",
        "sdf": "worlds/swerve.sdf",
        "base_link": "chassis",
        "actuators": actuators,
        "encoders": encoders,
        "$comment_imu": "No IMU yet: the yaw comes from the true pose. A "
                        "perfect gyro hides odometry errors, so adding the "
                        "<sensor type=\"imu\"> with noise is the next step in "
                        "fidelity.",
        "imu": None,
    }


# --- the options, declared once ---------------------------------------------
#
# This list is the source of ALL THREE ways of changing the world: the
# command-line flags, the `--options` that MARS Simulation Studio reads to
# draw its panel, and the defaults above.
#
# Declaring them once and generating the rest is not convenience: an option
# that exists in the terminal and not in the app --- or the other way round ---
# is an option someone will look for where it is not. `type` is what the app
# needs to know which control to draw. Each `name` is the lowercase of the
# module constant it sets.
OPTIONS = [
    {
        "name": "fuel",
        "label": "Physical FUEL",
        "type": "int",
        "min": 0,
        "max": 408,
        "unit": "balls",
        "help": "How many FUEL are seeded with real physics, nearest the robot"
                " first. 408 is every one inside the field and takes the"
                " real-time factor down to 0.48, which is not driveable.",
    },
    {
        "name": "decorative_fuel",
        "label": "Keep the painted FUEL",
        "type": "bool",
        "help": "The field mesh ships 456 FUEL baked in: no collision, no mass."
                " Only worth it with 0 physical ones, or you see two balls in"
                " every spot.",
    },
    {
        "name": "field_visual",
        "label": "Field mesh",
        "type": "choice",
        "choices": [
            ["lite", "Lite - trimmed, 2.3 M triangles"],
            ["full", "Full - every modelled rivet, 4.0 M"],
            ["none", "None - plain carpet"],
        ],
        "help": "The visual only. Collision boxes are the same in all three:"
                " with None you still have walls, HUB and ramps, just nothing"
                " drawn. It is the lever for a machine that struggles.",
    },
    {
        "name": "hitboxes",
        "label": "Field collision",
        "type": "bool",
        "help": "Guardrails, the six driver stations, towers, outposts, both"
                " HUBs and the four ramps. Off means the robot drives through"
                " the field.",
    },
    {
        "name": "visible_hitboxes",
        "label": "Draw the collision boxes",
        "type": "bool",
        "help": "Translucent over the mesh, to check a box lands where it"
                " should. In the way while driving.",
    },
    {
        "name": "drive_neutral",
        "label": "Drive neutral mode",
        "type": "choice",
        "choices": [["coast", "Coast - the wheel spins free"],
                    ["brake", "Brake - the motor shorts itself"]],
        "help": "What the drive motors do with no command. Coast is a stock"
                " TalonFX. Brake stops the robot at 8.8 m/s^2 -- the whole grip"
                " of the carpet -- every time the stick is centred, and that"
                " reads as a robot made of lead.",
    },
]


def _values():
    """The current values of everything OPTIONS declares."""
    here = globals()
    return {o["name"]: here[o["name"].upper()] for o in OPTIONS}


def _apply(values):
    """Puts values from the manifest into the module constants."""
    here = globals()
    for o in OPTIONS:
        if o["name"] not in values:
            continue
        v = values[o["name"]]
        if o["type"] == "int":
            v = max(o.get("min", 0), min(o.get("max", 10 ** 9), int(v)))
        elif o["type"] == "bool":
            v = v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes")
        elif o["type"] == "choice":
            valid = [x[0] for x in o["choices"]]
            if v not in valid:
                raise SystemExit(f"{o['name']}: {v!r} is not one of {valid}")
        here[o["name"].upper()] = v


if __name__ == "__main__":
    # The flags are so the file does not have to be edited every time you want
    # to look at something: the values above are the default.
    import argparse

    cli = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    cli.add_argument("--fuel", dest="fuel", type=int, metavar="N", default=None,
                     help=f"how many physical FUEL to seed (default {FUEL}); "
                          "408 is every one inside the field and drops the "
                          "real-time factor to 0.48")
    cli.add_argument("--no-fuel", dest="fuel", action="store_const", const=0,
                     help="no physical FUEL")
    cli.add_argument("--decorative-fuel", dest="deco", action="store_true", default=None,
                     help="keep the 456 FUEL baked into the field mesh (visual only)")
    cli.add_argument("--hitboxes", dest="hitboxes", action="store_true", default=None,
                     help="field collision boxes (default)")
    cli.add_argument("--no-hitboxes", dest="hitboxes", action="store_false",
                     help="no field collision: the robot drives through walls")
    cli.add_argument("--field-mesh", dest="mesh", default=None,
                     choices=("lite", "full", "none"),
                     help="lite (default): the trimmed field, half the triangles "
                          "and half the draw calls. full: every modelled rivet. "
                          "none: no field visual at all -- collision boxes stay "
                          "either way")
    cli.add_argument("--no-field-mesh", dest="mesh", action="store_const", const="none",
                     help="same as --field-mesh none")
    cli.add_argument("--show-hitboxes", dest="show", action="store_true", default=None,
                     help="draw the collision boxes translucent over the mesh")
    cli.add_argument("--hide-hitboxes", dest="show", action="store_false",
                     help="collision only, nothing drawn (default)")
    cli.add_argument("--neutral-mode", dest="neutral", default=None,
                     choices=("coast", "brake"),
                     help="what the drive motors do with no command (default "
                          f"{DRIVE_NEUTRAL})")
    # The two below are for MARS Simulation Studio, not for typing by hand:
    # with --options it reads what can be changed and with --set it changes it.
    cli.add_argument("--options", action="store_true",
                     help="print this generator's options as JSON and exit")
    cli.add_argument("--set", dest="sets", action="append", metavar="KEY=VALUE",
                     default=[], help="set one option by name; repeatable")
    args = cli.parse_args()

    if args.options:
        # Only the JSON on stdout: the app parses it.
        print(json.dumps({
            "file": "swerve",
            "generates": ["worlds/swerve.sdf", "models/swerve/robot-map.json"],
            "options": [dict(o, default=_values()[o["name"]]) for o in OPTIONS],
        }, indent=2))
        raise SystemExit(0)

    if args.fuel is not None:
        FUEL = max(0, args.fuel)
    if args.deco is not None:
        DECORATIVE_FUEL = args.deco
    if args.mesh is not None:
        FIELD_VISUAL = args.mesh
    if args.hitboxes is not None:
        HITBOXES = args.hitboxes
    if args.show is not None:
        VISIBLE_HITBOXES = args.show
    if args.neutral is not None:
        DRIVE_NEUTRAL = args.neutral

    if args.sets:
        raw = {}
        for pair in args.sets:
            if "=" not in pair:
                raise SystemExit(f"--set expects KEY=VALUE, not {pair!r}")
            key, _, value = pair.partition("=")
            raw[key.strip()] = value.strip()
        _apply(raw)

    sdf = SIM / "worlds" / "swerve.sdf"
    io.open(sdf, "w", encoding="utf-8", newline="\n").write(generate_sdf())
    print(f"wrote {sdf.relative_to(SIM)}")

    robot_map = SIM / "models" / "swerve" / "robot-map.json"
    robot_map.parent.mkdir(parents=True, exist_ok=True)
    io.open(robot_map, "w", encoding="utf-8", newline="\n").write(
        json.dumps(generate_robot_map(), indent=2, ensure_ascii=False) + "\n"
    )
    print(f"wrote {robot_map.relative_to(SIM)}")
