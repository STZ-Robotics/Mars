/* The boundary between Rust and the C++ optimizer: plain C, flat arrays.
 *
 * Rust owns every buffer. It fills AresNlpProblem (the robot reduced to the
 * numbers the physics needs, the waypoints, the obstacles and a warm start for
 * every variable) and sizes AresNlpResult's arrays; C++ builds the problem on
 * Sleipnir, solves it and writes the answer back into those arrays.
 *
 * Samples are numbered 0..samples-1 across the whole path. Segment j spans
 * samples [start_j, start_j + intervals_j], so consecutive segments share
 * their boundary sample, which is where waypoint j+1 sits.
 */
#ifndef ARES_NLP_H
#define ARES_NLP_H

#ifdef __cplusplus
extern "C" {
#endif

enum {
  ARES_WP_POSITION = 1, /* x, y fixed */
  ARES_WP_HEADING = 2,  /* heading fixed */
  ARES_WP_STOP = 4,     /* at rest: v = 0, omega = 0 */
};

typedef struct {
  /* Robot */
  double mass_kg;
  double moi_kg_m2;
  double gravity;
  /* 0 = every wheel carries the same weight. */
  double cog_height_m;
  /* The least load any wheel may carry, newtons (a margin from tipping). */
  double min_load_n;
  double wheel_cof;
  int modules;
  /* 2 * modules: x, y of each module in the robot frame. */
  const double* module_xy;
  /* Fastest a wheel can roll (motor free speed). */
  double wheel_free_speed_mps;
  /* The drive, as force along the wheel versus wheel speed s:
   *   pushing  F <= min(f_current, f_volt - f_emf * s)
   *   braking  F >= -min(f_current, f_volt + f_emf * s)
   * f_current <= 0 means no current limit. */
  double f_current_n;
  double f_volt_n;
  double f_emf_n_per_mps;
  /* Bumper, for the field walls and the obstacles. */
  double bumper_length_m;
  double bumper_width_m;

  /* Path */
  int segments;
  const int* intervals; /* per segment, >= 1 */
  int waypoints;        /* segments + 1 */
  const int* wp_flags;
  const double* wp_values; /* 3 * waypoints: x, y, heading */
  double max_velocity_mps; /* <= 0: none */
  double max_omega_radps;  /* <= 0: none */

  /* Field: the bumper stays inside [0, length] x [0, width]. 0 = no walls. */
  double field_length_m;
  double field_width_m;
  /* Keep-out circles: 3 * circles (x, y, radius). */
  int circles;
  const double* circle_xyr;

  /* Warm start, one value per sample (dt: one per segment). */
  const double* guess_x;
  const double* guess_y;
  const double* guess_theta;
  const double* guess_vx;
  const double* guess_vy;
  const double* guess_omega;
  const double* guess_ax;
  const double* guess_ay;
  const double* guess_alpha;
  const double* guess_dt;

  /* Solver */
  double tolerance;
  int max_iterations;
  double timeout_s;
} AresNlpProblem;

typedef struct {
  /* Sleipnir's ExitStatus: 0 is success, negative is failure. */
  int status;
  int iterations;
  /* Per sample. */
  double* x;
  double* y;
  double* theta;
  double* vx;
  double* vy;
  double* omega;
  double* ax;
  double* ay;
  double* alpha;
  /* samples * modules, sample-major: force each module puts on the carpet,
   * field frame. */
  double* fx;
  double* fy;
  /* Per segment. */
  double* dt;
} AresNlpResult;

/* Returns the status as well; never throws. */
int ares_nlp_solve(const AresNlpProblem* problem, AresNlpResult* result);

#ifdef __cplusplus
}
#endif

#endif
