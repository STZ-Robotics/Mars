//! The C boundary to `nlp/ares_nlp.cpp`. Mirrors `nlp/ares_nlp.h`; change one,
//! change both.

use std::os::raw::{c_double, c_int};

pub const WP_POSITION: c_int = 1;
pub const WP_HEADING: c_int = 2;
pub const WP_STOP: c_int = 4;

pub const C_MAX_VELOCITY: c_int = 1;
pub const C_MAX_ACCELERATION: c_int = 2;
pub const C_MAX_OMEGA: c_int = 3;
pub const C_POINT_AT: c_int = 4;
pub const C_KEEP_IN_CIRCLE: c_int = 5;
pub const C_KEEP_IN_RECT: c_int = 6;
pub const C_KEEP_IN_LANE: c_int = 7;
pub const C_KEEP_OUT_CIRCLE: c_int = 8;
pub const C_ON_BEZIER: c_int = 9;
pub const C_HEADING: c_int = 10;
pub const C_VELOCITY: c_int = 11;

/// A constraint over samples `from..=to`; `p` as `ares_nlp.h` documents per kind.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Constraint {
    pub kind: c_int,
    pub from: c_int,
    pub to: c_int,
    pub p: [c_double; 8],
}

#[repr(C)]
struct RawProblem {
    mass_kg: c_double,
    moi_kg_m2: c_double,
    gravity: c_double,
    cog_height_m: c_double,
    min_load_n: c_double,
    wheel_cof: c_double,
    modules: c_int,
    module_xy: *const c_double,
    wheel_free_speed_mps: c_double,
    f_current_n: c_double,
    f_volt_n: c_double,
    f_emf_n_per_mps: c_double,
    bumper_length_m: c_double,
    bumper_width_m: c_double,
    segments: c_int,
    intervals: *const c_int,
    waypoints: c_int,
    wp_flags: *const c_int,
    wp_values: *const c_double,
    max_velocity_mps: c_double,
    max_omega_radps: c_double,
    field_length_m: c_double,
    field_width_m: c_double,
    circles: c_int,
    circle_xyr: *const c_double,
    constraints: c_int,
    constraint: *const Constraint,
    guess: [*const c_double; 9],
    guess_dt: *const c_double,
    tolerance: c_double,
    max_iterations: c_int,
    timeout_s: c_double,
}

#[repr(C)]
struct RawResult {
    status: c_int,
    iterations: c_int,
    out: [*mut c_double; 9],
    fx: *mut c_double,
    fy: *mut c_double,
    dt: *mut c_double,
}

extern "C" {
    fn ares_nlp_solve(problem: *const RawProblem, result: *mut RawResult) -> c_int;
}

/// The problem, borrowed from Rust buffers. `guess` is x, y, θ, vx, vy, ω, ax,
/// ay, α, one value per sample each.
pub struct Problem<'a> {
    pub mass_kg: f64,
    pub moi_kg_m2: f64,
    pub gravity: f64,
    pub cog_height_m: f64,
    pub min_load_n: f64,
    pub wheel_cof: f64,
    pub module_xy: &'a [f64],
    pub wheel_free_speed_mps: f64,
    pub f_current_n: f64,
    pub f_volt_n: f64,
    pub f_emf_n_per_mps: f64,
    pub bumper_length_m: f64,
    pub bumper_width_m: f64,
    pub intervals: &'a [i32],
    pub wp_flags: &'a [i32],
    pub wp_values: &'a [f64],
    pub max_velocity_mps: f64,
    pub max_omega_radps: f64,
    pub field_length_m: f64,
    pub field_width_m: f64,
    pub circle_xyr: &'a [f64],
    pub constraints: &'a [Constraint],
    pub guess: [&'a [f64]; 9],
    pub guess_dt: &'a [f64],
    pub tolerance: f64,
    pub max_iterations: i32,
    pub timeout_s: f64,
}

pub struct Solution {
    pub status: i32,
    pub iterations: i32,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub theta: Vec<f64>,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    pub omega: Vec<f64>,
    pub ax: Vec<f64>,
    pub ay: Vec<f64>,
    pub alpha: Vec<f64>,
    pub fx: Vec<f64>,
    pub fy: Vec<f64>,
    pub dt: Vec<f64>,
}

pub fn solve(p: &Problem) -> Solution {
    let samples = 1 + p.intervals.iter().map(|&n| n as usize).sum::<usize>();
    let modules = p.module_xy.len() / 2;
    assert!(p.intervals.iter().all(|&n| n >= 1));
    assert_eq!(p.wp_flags.len(), p.intervals.len() + 1);
    assert_eq!(p.wp_values.len(), 3 * p.wp_flags.len());
    assert!(p.guess.iter().all(|g| g.len() == samples));
    assert_eq!(p.guess_dt.len(), p.intervals.len());
    assert_eq!(p.circle_xyr.len() % 3, 0);

    let raw = RawProblem {
        mass_kg: p.mass_kg,
        moi_kg_m2: p.moi_kg_m2,
        gravity: p.gravity,
        cog_height_m: p.cog_height_m,
        min_load_n: p.min_load_n,
        wheel_cof: p.wheel_cof,
        modules: modules as c_int,
        module_xy: p.module_xy.as_ptr(),
        wheel_free_speed_mps: p.wheel_free_speed_mps,
        f_current_n: p.f_current_n,
        f_volt_n: p.f_volt_n,
        f_emf_n_per_mps: p.f_emf_n_per_mps,
        bumper_length_m: p.bumper_length_m,
        bumper_width_m: p.bumper_width_m,
        segments: p.intervals.len() as c_int,
        intervals: p.intervals.as_ptr(),
        waypoints: p.wp_flags.len() as c_int,
        wp_flags: p.wp_flags.as_ptr(),
        wp_values: p.wp_values.as_ptr(),
        max_velocity_mps: p.max_velocity_mps,
        max_omega_radps: p.max_omega_radps,
        field_length_m: p.field_length_m,
        field_width_m: p.field_width_m,
        circles: (p.circle_xyr.len() / 3) as c_int,
        circle_xyr: p.circle_xyr.as_ptr(),
        constraints: p.constraints.len() as c_int,
        constraint: p.constraints.as_ptr(),
        guess: p.guess.map(|g| g.as_ptr()),
        guess_dt: p.guess_dt.as_ptr(),
        tolerance: p.tolerance,
        max_iterations: p.max_iterations,
        timeout_s: p.timeout_s,
    };

    let mut state: [Vec<f64>; 9] = std::array::from_fn(|_| vec![0.0; samples]);
    let mut fx = vec![0.0; samples * modules];
    let mut fy = vec![0.0; samples * modules];
    let mut dt = vec![0.0; p.intervals.len()];
    let mut res = RawResult {
        status: 0,
        iterations: 0,
        out: std::array::from_fn(|i| state[i].as_mut_ptr()),
        fx: fx.as_mut_ptr(),
        fy: fy.as_mut_ptr(),
        dt: dt.as_mut_ptr(),
    };
    // SAFETY: every pointer refers to a live buffer of the length the header
    // promises (checked above), and the C++ side neither keeps nor frees them.
    unsafe { ares_nlp_solve(&raw, &mut res) };
    let [x, y, theta, vx, vy, omega, ax, ay, alpha] = state;
    Solution { status: res.status, iterations: res.iterations, x, y, theta, vx, vy, omega, ax, ay, alpha, fx, fy, dt }
}
