// A repertoire of equations ready to insert.
//
// Each preset carries the variable names it expects; if they are not bound yet,
// the equation is inserted anyway and says which symbol is missing. The idea is
// for it to work as a starting point and a reminder of the formula, not to work
// magically without configuring anything.

export interface EquationPreset {
  name: string
  expression: string
  unit: string
  description: string
  /** Variables that have to be bound to a topic for it to give a number. */
  needs: string[]
}

export interface PresetCategory {
  category: string
  presets: EquationPreset[]
}

export const EQUATION_LIBRARY: PresetCategory[] = [
  {
    category: "Drivetrain",
    presets: [
      {
        name: "speed",
        expression: "hypot(vx, vy)",
        unit: "m/s",
        description: "Linear speed from chassis components",
        needs: ["vx", "vy"],
      },
      {
        name: "speed_pct",
        expression: "hypot(vx, vy) / v_max * 100",
        unit: "%",
        description: "Fraction of the maximum achievable speed",
        needs: ["vx", "vy", "v_max"],
      },
      {
        name: "accel",
        expression: "d(hypot(vx, vy))",
        unit: "m/s²",
        description: "Linear acceleration by differentiating speed",
        needs: ["vx", "vy"],
      },
      {
        name: "wheel_rpm",
        expression: "wheel_speed / (2 * pi * wheel_radius) * 60",
        unit: "RPM",
        description: "Wheel angular speed from surface speed",
        needs: ["wheel_speed", "wheel_radius"],
      },
      {
        name: "motor_rpm",
        expression: "wheel_speed / (2 * pi * wheel_radius) * 60 * gear_ratio",
        unit: "RPM",
        description: "Motor speed upstream of the gearbox",
        needs: ["wheel_speed", "wheel_radius", "gear_ratio"],
      },
      {
        name: "turn_radius",
        expression: "hypot(vx, vy) / omega",
        unit: "m",
        description: "Instantaneous turning radius (∞ when driving straight)",
        needs: ["vx", "vy", "omega"],
      },
    ],
  },
  {
    category: "Control",
    presets: [
      {
        name: "feedforward",
        expression: "kS * sign(setpoint) + kV * setpoint + kA * d(setpoint)",
        unit: "V",
        description: "Standard WPILib SimpleMotorFeedforward",
        needs: ["kS", "kV", "kA", "setpoint"],
      },
      {
        name: "error",
        expression: "setpoint - measured",
        unit: "",
        description: "Tracking error",
        needs: ["setpoint", "measured"],
      },
      {
        name: "angle_error",
        expression: "wrap(setpoint - measured)",
        unit: "deg",
        description: "Shortest angular error, wrapped to ±180°",
        needs: ["setpoint", "measured"],
      },
      {
        name: "rms_error",
        expression: "rms(setpoint - measured, 5)",
        unit: "",
        description: "RMS of the error over the last 5 seconds",
        needs: ["setpoint", "measured"],
      },
      {
        name: "overshoot",
        expression: "peak(measured, 3) / setpoint",
        unit: "×",
        description: "Peak over setpoint in the last 3 s (1.0 = no overshoot)",
        needs: ["measured", "setpoint"],
      },
      {
        name: "settle_band",
        expression: "stddev(measured, 2)",
        unit: "",
        description: "Spread while settled — small means the loop is quiet",
        needs: ["measured"],
      },
    ],
  },
  {
    category: "Electrical",
    presets: [
      {
        name: "power",
        expression: "voltage * current",
        unit: "W",
        description: "Instantaneous electrical power",
        needs: ["voltage", "current"],
      },
      {
        name: "charge",
        expression: "int(current)",
        unit: "C",
        description: "Accumulated charge drawn over the buffer window",
        needs: ["current"],
      },
      {
        name: "battery_sag",
        expression: "v_open - current * r_internal",
        unit: "V",
        description: "Predicted loaded battery voltage",
        needs: ["v_open", "current", "r_internal"],
      },
      {
        name: "rms_current",
        expression: "rms(current, 10)",
        unit: "A",
        description: "RMS current over 10 s — what actually heats the motor",
        needs: ["current"],
      },
      {
        name: "duty_cycle",
        expression: "applied_volts / battery_volts",
        unit: "",
        description: "Effective duty cycle being commanded",
        needs: ["applied_volts", "battery_volts"],
      },
    ],
  },
  {
    category: "Mechanics",
    presets: [
      {
        name: "kinetic_energy",
        expression: "0.5 * mass * hypot(vx, vy) ^ 2",
        unit: "J",
        description: "Translational kinetic energy of the robot",
        needs: ["mass", "vx", "vy"],
      },
      {
        name: "torque",
        expression: "force * lever_arm",
        unit: "N·m",
        description: "Torque from a force at a distance",
        needs: ["force", "lever_arm"],
      },
      {
        name: "arm_gravity",
        expression: "mass * 9.81 * cog_distance * cos(rad(arm_angle))",
        unit: "N·m",
        description: "Gravity torque on an arm at a given angle",
        needs: ["mass", "cog_distance", "arm_angle"],
      },
      {
        name: "tipping_accel",
        expression: "9.81 * track_width / (2 * cog_height)",
        unit: "m/s²",
        description: "Lateral acceleration at which the robot tips",
        needs: ["track_width", "cog_height"],
      },
      {
        name: "projectile_range",
        expression: "launch_speed ^ 2 * sin(2 * rad(launch_angle)) / 9.81",
        unit: "m",
        description: "Ideal range of a projectile, no drag",
        needs: ["launch_speed", "launch_angle"],
      },
      {
        name: "launch_angle",
        expression: "solve(launch_speed ^ 2 * sin(2 * rad(a)) / 9.81 - target_range, a, 45)",
        unit: "deg",
        description: "Angle needed to hit a range, solved numerically",
        needs: ["launch_speed", "target_range"],
      },
    ],
  },
  {
    category: "Matrices",
    presets: [
      {
        name: "rotate_vector",
        expression: "rot2(rad(heading)) * [[vx], [vy]]",
        unit: "m/s",
        description: "Rotate a robot-frame velocity into the field frame",
        needs: ["heading", "vx", "vy"],
      },
      {
        name: "swerve_module_matrix",
        expression: "[[1, 0, -y1], [0, 1, x1], [1, 0, -y2], [0, 1, x2]]",
        unit: "",
        description: "Inverse-kinematics matrix rows for two modules",
        needs: ["x1", "y1", "x2", "y2"],
      },
      {
        name: "chassis_from_modules",
        expression: "inv(T(A) * A) * T(A) * b",
        unit: "",
        description: "Least-squares chassis solve — the pseudo-inverse, written out",
        needs: ["A", "b"],
      },
      {
        name: "covariance_trace",
        expression: "trace(P)",
        unit: "",
        description: "Total uncertainty of a filter — small means confident",
        needs: ["P"],
      },
      {
        name: "determinant",
        expression: "det(M)",
        unit: "",
        description: "Zero determinant means the matrix is singular",
        needs: ["M"],
      },
    ],
  },
  {
    category: "WPILib MathUtil",
    presets: [
      {
        name: "joystick",
        expression: "deadband(stick, 0.1)",
        unit: "",
        description: "applyDeadband — rescaled so there is no jump at the edge",
        needs: ["stick"],
      },
      {
        name: "joystick_curve",
        expression: "copyDirPow(deadband(stick, 0.1), 2)",
        unit: "",
        description: "Squared input shaping that keeps the sign",
        needs: ["stick"],
      },
      {
        name: "wrapped_angle",
        expression: "deg(angleModulus(rad(heading)))",
        unit: "deg",
        description: "angleModulus — heading folded into ±180°",
        needs: ["heading"],
      },
      {
        name: "encoder_wrap",
        expression: "inputModulus(raw_angle, 0, 360)",
        unit: "deg",
        description: "inputModulus — fold an absolute encoder into one turn",
        needs: ["raw_angle"],
      },
      {
        name: "at_setpoint",
        expression: "isNear(setpoint, measured, 0.05)",
        unit: "",
        description: "1 when the loop is inside tolerance, 0 otherwise",
        needs: ["setpoint", "measured"],
      },
      {
        name: "ramp",
        expression: "lerp(v_start, v_end, progress)",
        unit: "",
        description: "interpolate — t is clamped to [0, 1]",
        needs: ["v_start", "v_end", "progress"],
      },
      {
        name: "progress",
        expression: "invLerp(t_start, t_end, now)",
        unit: "",
        description: "inverseInterpolate — where a value sits in a range",
        needs: ["t_start", "t_end", "now"],
      },
    ],
  },
  {
    category: "State space",
    presets: [
      {
        name: "discretize",
        expression: "mexp(A * dt)",
        unit: "",
        description: "Matrix exponential — continuous A to discrete Ad",
        needs: ["A", "dt"],
      },
      {
        name: "next_state",
        expression: "A * x + B * u",
        unit: "",
        description: "State-space update ẋ = Ax + Bu",
        needs: ["A", "x", "B", "u"],
      },
      {
        name: "least_squares",
        expression: "msolve(A, b)",
        unit: "",
        description: "Solve A·x = b, pseudo-inverse when A is not square",
        needs: ["A", "b"],
      },
      {
        name: "std_devs",
        expression: "elemPow(diag(P), 0.5)",
        unit: "",
        description: "Standard deviations from a covariance diagonal",
        needs: ["P"],
      },
      {
        name: "cholesky",
        expression: "chol(P)",
        unit: "",
        description: "Lower-triangular factor of a covariance matrix",
        needs: ["P"],
      },
      {
        name: "worst_residual",
        expression: "maxAbs(A * x - b)",
        unit: "",
        description: "Largest single-equation error of a fit",
        needs: ["A", "x", "b"],
      },
    ],
  },
  {
    category: "Calculus",
    presets: [
      {
        name: "symbolic_derivative",
        expression: "diff(x ^ 3 + 2 * x, x)",
        unit: "",
        description: "Symbolic derivative — shows 3x² + 2, not just a number",
        needs: ["x"],
      },
      {
        name: "second_derivative",
        expression: "diff(diff(sin(x), x), x)",
        unit: "",
        description: "Nested symbolic derivative",
        needs: ["x"],
      },
      {
        name: "jerk",
        expression: "d(d(velocity))",
        unit: "m/s³",
        description: "Numeric second derivative — noisy, use with care",
        needs: ["velocity"],
      },
      {
        name: "root",
        expression: "solve(x ^ 2 - 2, x, 1)",
        unit: "",
        description: "Newton solve — converges to √2",
        needs: [],
      },
    ],
  },
]
