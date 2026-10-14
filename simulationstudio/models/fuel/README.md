# FUEL

REBUILT's (FRC 2026) scoring element: a 15 cm high-density foam ball, the
AndyMark am-5801.

This directory is the model **with physics**. The 456 FUEL you see on the 2026
field are baked into the glTF as scenery: they have no collision or mass and
cannot be pushed or picked up. The real ones are seeded by the World Editor
(the *FUEL (game pieces)* group), which writes one `<include>` of
`model://fuel` per ball.

## Where each number comes from

| Quantity | Value | Source |
|---|---|---|
| Diameter | 15.0 cm (5.91 in) | game manual, 5.10.1 |
| Mass | 0.215 kg | manual: 0.448–0.500 lb, nominal |
| Inertia | 4.8375e-4 kg·m² | solid sphere, `2/5·m·r²` |
| Color | 0.956 0.597 0.056 | `baseColorFactor` of the material of the official `.glb`'s 456 FUEL |
| Friction | μ = 0.85 | **a starting point, not a measurement** |

The solid sphere is not a simplification: a foam ball is practically
homogeneous. It matters more than it looks — that inertia is what decides how
much it spins when rubbing against an intake roller.

## What needs calibrating

**μ = 0.85** is the only thing in the model that does not come from the
manual. It decides whether the FUEL rolls or drags when a robot pushes it, and
whether an intake grabs it or slips against it. High-density foam grips more
than smooth plastic and less than a wheel's rubber; the FRC carpet on the
floor is at 0.9.

`worlds/fuel-drop.sdf` is the bench: its fourth ball goes down a 20° ramp.
With the right μ it rolls; with a low μ it slides and reaches the bottom
spinning less than it should.

## Bounce does not exist, and that is measured

The model used to carry `<bounce><restitution_coefficient>0.35</...>`. It was
removed after measuring it: with `bridge/src/bin/fuel-bounce.rs` against
`worlds/fuel-drop.sdf`, the three balls give **e = 0.000** with both DART and
bullet-featherstone. This gz-physics build ignores `<bounce>` entirely.

Leaving it in would have been worse than not having it: a number that can be
"tuned" for a whole afternoon without anything changing.

Practical consequence: the FUEL drops and stays. For a foam ball on carpet that
is fairly close to reality, but **it is no use for studying a shot that
bounces off the HUB's rim**. Getting real bounce requires setting the
restitution per contact from a C++ system — gz-physics exposes
`SetContactPropertiesCallbackFeature` —, i.e. work for `MarsLink`, not an SDF
tag.

## Cost

Each seeded FUEL is one more dynamic body in the solver's loop. It is the
first thing to cut if the real-time factor drops below ~0.95: below that the
control loop is no longer representative of the real robot, and gains tuned
against this simulation do not transfer.
