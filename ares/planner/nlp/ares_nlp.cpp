// Ares' trajectory optimizer: the whole trajectory as one nonlinear program,
// solved with Sleipnir's interior-point method.
//
// The decision variables are the robot's state at every sample (pose, velocity,
// acceleration), the force each module puts on the carpet, and the time step
// of each segment. The cost is the total time. Nothing ties the robot to the
// spline the user's waypoints suggest: the spline is only the warm start, and
// the optimizer moves the path wherever the physics makes it faster.
//
// What it asks of every sample, beyond the dynamics:
//
// - Grip, per wheel, with the weight on that wheel: when the center of mass
//   height is known, accelerating moves load to the trailing wheels (and a
//   wheel cannot carry negative load, so the robot never tips).
// - The drive motor, per wheel, along the wheel: current limit and back-EMF,
//   so pushing fades toward free speed while braking does not.
// - Wheel speed below the motor's free speed.
// - Bumper inside the field walls and clear of the keep-out circles.
//
// Notation: x position, v velocity, a acceleration, θ heading (as cos/sin),
// ω angular velocity, α angular acceleration, F force, N normal load.

#include "ares_nlp.h"

#include <chrono>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <vector>

#include <sleipnir/autodiff/variable.hpp>
#include <sleipnir/optimization/problem.hpp>

namespace {

using Var = slp::Variable<double>;

struct V2 {
  Var x, y;
};

// Smoothing for |v| at rest, m/s: sqrt is not differentiable at 0.
constexpr double kSpeedEps = 1e-3;
// Stall detection: iterations between checks, and the relative change in the
// total time below which the solver is considered done moving.
constexpr int kStallWindow = 100;
constexpr double kStallTolerance = 1e-4;

}  // namespace

extern "C" int ares_nlp_solve(const AresNlpProblem* p, AresNlpResult* out) {
  try {
    const int M = p->modules;
    int samples = 1;
    std::vector<int> start(p->segments + 1);
    for (int j = 0; j < p->segments; ++j) {
      start[j] = samples - 1;
      samples += p->intervals[j];
    }
    start[p->segments] = samples - 1;

    slp::Problem<double> problem;

    std::vector<Var> x, y, c, s, vx, vy, w, ax, ay, al;
    std::vector<std::vector<Var>> Fx(samples), Fy(samples);
    std::vector<Var> dt;
    // The acceleration in the robot's frame, only with a center of mass
    // height: it makes the load transfer linear, where written with the field
    // acceleration it is a product of three variables that the interior point
    // cannot work through once the robot accelerates off an axis.
    std::vector<Var> abx, aby;
    const bool transfer = p->cog_height_m > 0;
    for (int k = 0; k < samples; ++k) {
      x.push_back(problem.decision_variable());
      y.push_back(problem.decision_variable());
      c.push_back(problem.decision_variable());
      s.push_back(problem.decision_variable());
      vx.push_back(problem.decision_variable());
      vy.push_back(problem.decision_variable());
      w.push_back(problem.decision_variable());
      ax.push_back(problem.decision_variable());
      ay.push_back(problem.decision_variable());
      al.push_back(problem.decision_variable());
      for (int i = 0; i < M; ++i) {
        Fx[k].push_back(problem.decision_variable());
        Fy[k].push_back(problem.decision_variable());
      }
      if (transfer) {
        abx.push_back(problem.decision_variable());
        aby.push_back(problem.decision_variable());
      }
    }
    for (int j = 0; j < p->segments; ++j) {
      dt.push_back(problem.decision_variable());
    }

    // Load transfer. With the modules at pᵢ (robot frame) and S = Σ pᵢpᵢᵀ,
    // the loads that balance the pitch and roll moments m·h·a are
    //   Nᵢ = m·g/n − m·h · a_robotᵀ S⁻¹ pᵢ,
    // and a_robot·qᵢ = a_field·R(θ)qᵢ, with qᵢ = S⁻¹pᵢ.
    double Sxx = 0, Sxy = 0, Syy = 0;
    for (int i = 0; i < M; ++i) {
      double px = p->module_xy[2 * i], py = p->module_xy[2 * i + 1];
      Sxx += px * px;
      Sxy += px * py;
      Syy += py * py;
    }
    const double det = Sxx * Syy - Sxy * Sxy;
    std::vector<double> qx(M), qy(M);
    for (int i = 0; i < M; ++i) {
      double px = p->module_xy[2 * i], py = p->module_xy[2 * i + 1];
      qx[i] = (Syy * px - Sxy * py) / det;
      qy[i] = (-Sxy * px + Sxx * py) / det;
    }
    const double static_load = p->mass_kg * p->gravity / M;
    const double mh = p->mass_kg * p->cog_height_m;

    // Warm start.
    for (int k = 0; k < samples; ++k) {
      x[k].set_value(p->guess_x[k]);
      y[k].set_value(p->guess_y[k]);
      c[k].set_value(std::cos(p->guess_theta[k]));
      s[k].set_value(std::sin(p->guess_theta[k]));
      vx[k].set_value(p->guess_vx[k]);
      vy[k].set_value(p->guess_vy[k]);
      w[k].set_value(p->guess_omega[k]);
      ax[k].set_value(p->guess_ax[k]);
      ay[k].set_value(p->guess_ay[k]);
      al[k].set_value(p->guess_alpha[k]);
      if (transfer) {
        const double gc = std::cos(p->guess_theta[k]), gs = std::sin(p->guess_theta[k]);
        abx[k].set_value(gc * p->guess_ax[k] + gs * p->guess_ay[k]);
        aby[k].set_value(-gs * p->guess_ax[k] + gc * p->guess_ay[k]);
      }
      // Forces as the physics would split them: m·a in proportion to each
      // wheel's load (so every wheel uses the same fraction of its grip),
      // plus I·α as the least-squares torque split. An even split would ask
      // the unloaded wheels for more than they have, and the interior point
      // spends hundreds of iterations climbing out of that.
      {
        const double gc = std::cos(p->guess_theta[k]), gs = std::sin(p->guess_theta[k]);
        const double gax = p->guess_ax[k], gay = p->guess_ay[k];
        const double bx = gc * gax + gs * gay, by = -gs * gax + gc * gay;
        std::vector<double> load(M);
        double total = 0, r2 = 0;
        for (int i = 0; i < M; ++i) {
          load[i] = std::fmax(static_load - mh * (bx * qx[i] + by * qy[i]), p->min_load_n);
          total += load[i];
          const double px = p->module_xy[2 * i], py = p->module_xy[2 * i + 1];
          r2 += px * px + py * py;
        }
        const double torque = p->moi_kg_m2 * p->guess_alpha[k];
        for (int i = 0; i < M; ++i) {
          const double px = p->module_xy[2 * i], py = p->module_xy[2 * i + 1];
          const double rx = gc * px - gs * py, ry = gs * px + gc * py;
          const double share = load[i] / total;
          Fx[k][i].set_value(p->mass_kg * gax * share - torque * ry / r2);
          Fy[k][i].set_value(p->mass_kg * gay * share + torque * rx / r2);
        }
      }
    }
    for (int j = 0; j < p->segments; ++j) {
      dt[j].set_value(p->guess_dt[j]);
    }

    // Cost: total time.
    Var total = 0.0;
    for (int j = 0; j < p->segments; ++j) {
      total += dt[j] * static_cast<double>(p->intervals[j]);
      problem.subject_to(dt[j] >= 1e-4);
      // A ceiling relative to the guess: with few samples spread over a long
      // time, the constraints (checked only at samples) stop meaning much,
      // and the solver can wander into a slow, looping local optimum.
      problem.subject_to(dt[j] <= std::fmax(4.0 * p->guess_dt[j], 0.02));
    }
    problem.minimize(total);

    // Dynamics: constant acceleration over each interval.
    for (int j = 0; j < p->segments; ++j) {
      const Var& h = dt[j];
      for (int k = start[j]; k < start[j + 1]; ++k) {
        problem.subject_to(x[k + 1] == x[k] + vx[k] * h + 0.5 * ax[k] * h * h);
        problem.subject_to(y[k + 1] == y[k] + vy[k] * h + 0.5 * ay[k] * h * h);
        problem.subject_to(vx[k + 1] == vx[k] + ax[k] * h);
        problem.subject_to(vy[k + 1] == vy[k] + ay[k] * h);
        problem.subject_to(w[k + 1] == w[k] + al[k] * h);
        // The heading as a rotation, so it never wraps: θₖ₊₁ = θₖ + φ.
        Var phi = w[k] * h + 0.5 * al[k] * h * h;
        Var cp = slp::cos(phi), sp = slp::sin(phi);
        problem.subject_to(c[k + 1] == c[k] * cp - s[k] * sp);
        problem.subject_to(s[k + 1] == s[k] * cp + c[k] * sp);
      }
    }
    // The composition keeps |(c, s)| = 1 once the first one is.
    problem.subject_to(c[0] * c[0] + s[0] * s[0] == 1.0);

    const double mu = p->wheel_cof;
    const double vmax = p->wheel_free_speed_mps;
    const bool has_current = p->f_current_n > 0;

    for (int k = 0; k < samples; ++k) {
      Var Fx_net = 0.0, Fy_net = 0.0, tau = 0.0;
      for (int i = 0; i < M; ++i) {
        const double px = p->module_xy[2 * i], py = p->module_xy[2 * i + 1];
        // Module position, field frame, from the center.
        Var rx = c[k] * px - s[k] * py;
        Var ry = s[k] * px + c[k] * py;
        const Var& fx = Fx[k][i];
        const Var& fy = Fy[k][i];
        Fx_net += fx;
        Fy_net += fy;
        tau += rx * fy - ry * fx;

        // Wheel velocity, field frame: v + ω × r.
        Var wvx = vx[k] - w[k] * ry;
        Var wvy = vy[k] + w[k] * rx;
        Var speed2 = wvx * wvx + wvy * wvy;
        problem.subject_to(speed2 <= vmax * vmax);

        // Grip with the load this wheel carries: linear in the acceleration
        // in the robot's frame.
        Var load = static_load;
        if (mh > 0) {
          load = static_load - mh * (abx[k] * qx[i] + aby[k] * qy[i]);
          problem.subject_to(load >= p->min_load_n);
          // |F| <= μ·N, written as |F|²/(μN) <= μN: quadratic over linear,
          // convex and smooth while N > 0 (the floor above guarantees it).
          // Squared on both sides (|F|² <= μ²N²) it is the same set but not
          // convex, and as sqrt(|F|²) <= μN its curvature blows up when a
          // wheel pushes nothing; the interior point crawls through both.
          problem.subject_to((fx * fx + fy * fy) / (mu * load) <= mu * load);
        } else {
          problem.subject_to(fx * fx + fy * fy <= mu * mu * static_load * static_load);
        }

        // The drive motor, along the wheel. With P = F·v and the wheel speed
        // σ = |v|, the force along the wheel is P/σ; multiplying through by σ
        // keeps it smooth at rest.
        Var sigma = slp::sqrt(speed2 + kSpeedEps * kSpeedEps);
        Var P = fx * wvx + fy * wvy;
        problem.subject_to(P <= (p->f_volt_n - p->f_emf_n_per_mps * sigma) * sigma);
        problem.subject_to(P >= -(p->f_volt_n + p->f_emf_n_per_mps * sigma) * sigma);
        if (has_current) {
          problem.subject_to(P <= p->f_current_n * sigma);
          problem.subject_to(P >= -p->f_current_n * sigma);
        }
      }
      if (transfer) {
        problem.subject_to(ax[k] == c[k] * abx[k] - s[k] * aby[k]);
        problem.subject_to(ay[k] == s[k] * abx[k] + c[k] * aby[k]);
      }
      problem.subject_to(Fx_net == p->mass_kg * ax[k]);
      problem.subject_to(Fy_net == p->mass_kg * ay[k]);
      problem.subject_to(tau == p->moi_kg_m2 * al[k]);

      if (p->max_velocity_mps > 0) {
        problem.subject_to(vx[k] * vx[k] + vy[k] * vy[k] <=
                           p->max_velocity_mps * p->max_velocity_mps);
      }
      if (p->max_omega_radps > 0) {
        problem.subject_to(w[k] * w[k] <= p->max_omega_radps * p->max_omega_radps);
      }

      // Bumper corners inside the walls.
      const double hl = 0.5 * p->bumper_length_m, hw = 0.5 * p->bumper_width_m;
      if (p->field_length_m > 0 && p->field_width_m > 0) {
        for (double sx : {-1.0, 1.0}) {
          for (double sy : {-1.0, 1.0}) {
            Var cx = x[k] + c[k] * (sx * hl) - s[k] * (sy * hw);
            Var cy = y[k] + s[k] * (sx * hl) + c[k] * (sy * hw);
            problem.subject_to(cx >= 0.0);
            problem.subject_to(cx <= p->field_length_m);
            problem.subject_to(cy >= 0.0);
            problem.subject_to(cy <= p->field_width_m);
          }
        }
      }

      // Keep-out circles against the bumper, covered by four circles (one
      // per quadrant): tight on a square bumper, never inside it.
      if (p->circles > 0) {
        const double qr = 0.25 * std::hypot(p->bumper_length_m, p->bumper_width_m);
        for (int o = 0; o < p->circles; ++o) {
          const double ox = p->circle_xyr[3 * o], oy = p->circle_xyr[3 * o + 1];
          const double rr = p->circle_xyr[3 * o + 2] + qr;
          for (double sx : {-0.5, 0.5}) {
            for (double sy : {-0.5, 0.5}) {
              Var cx = x[k] + c[k] * (sx * hl) - s[k] * (sy * hw);
              Var cy = y[k] + s[k] * (sx * hl) + c[k] * (sy * hw);
              Var dx = cx - ox, dy = cy - oy;
              problem.subject_to(dx * dx + dy * dy >= rr * rr);
            }
          }
        }
      }
    }

    // Scoped constraints.
    {
      const double hl = 0.5 * p->bumper_length_m, hw = 0.5 * p->bumper_width_m;
      auto corner = [&](int k, double bx, double by) {
        return V2{x[k] + c[k] * bx - s[k] * by, y[k] + s[k] * bx + c[k] * by};
      };
      const double corners[4][2] = {{hl, hw}, {hl, -hw}, {-hl, hw}, {-hl, -hw}};
      for (int ci = 0; ci < p->constraints; ++ci) {
        const AresNlpConstraint& q = p->constraint[ci];
        const int from = std::max(0, std::min(q.from, samples - 1));
        const int to = std::max(from, std::min(q.to, samples - 1));
        for (int k = from; k <= to; ++k) {
          switch (q.kind) {
            case ARES_C_MAX_VELOCITY:
              problem.subject_to(vx[k] * vx[k] + vy[k] * vy[k] <= q.p[0] * q.p[0]);
              break;
            case ARES_C_MAX_ACCELERATION:
              problem.subject_to(ax[k] * ax[k] + ay[k] * ay[k] <= q.p[0] * q.p[0]);
              break;
            case ARES_C_MAX_OMEGA:
              problem.subject_to(w[k] * w[k] <= q.p[0] * q.p[0]);
              break;
            case ARES_C_POINT_AT: {
              // facing · (target − position) >= cos(tol)·|target − position|
              const double sign = q.p[3] > 0.5 ? -1.0 : 1.0;
              Var dx = q.p[0] - x[k], dy = q.p[1] - y[k];
              Var dist = slp::sqrt(dx * dx + dy * dy + 1e-6);
              problem.subject_to(sign * (c[k] * dx + s[k] * dy) >= std::cos(q.p[2]) * dist);
              break;
            }
            case ARES_C_KEEP_IN_CIRCLE:
              for (auto& b : corners) {
                V2 cc = corner(k, b[0], b[1]);
                Var dx = cc.x - q.p[0], dy = cc.y - q.p[1];
                problem.subject_to(dx * dx + dy * dy <= q.p[2] * q.p[2]);
              }
              break;
            case ARES_C_KEEP_IN_RECT:
              for (auto& b : corners) {
                V2 cc = corner(k, b[0], b[1]);
                problem.subject_to(cc.x >= q.p[0]);
                problem.subject_to(cc.x <= q.p[0] + q.p[2]);
                problem.subject_to(cc.y >= q.p[1]);
                problem.subject_to(cc.y <= q.p[1] + q.p[3]);
              }
              break;
            case ARES_C_KEEP_IN_LANE: {
              const double lx = q.p[2] - q.p[0], ly = q.p[3] - q.p[1];
              const double len = std::hypot(lx, ly);
              if (len < 1e-9) break;
              const double nx = -ly / len, ny = lx / len;
              Var off = (x[k] - q.p[0]) * nx + (y[k] - q.p[1]) * ny;
              problem.subject_to(off * off <= q.p[4] * q.p[4]);
              break;
            }
            case ARES_C_KEEP_OUT_CIRCLE: {
              const double qr = 0.25 * std::hypot(p->bumper_length_m, p->bumper_width_m);
              const double rr = q.p[2] + qr;
              for (double sx : {-0.5, 0.5}) {
                for (double sy : {-0.5, 0.5}) {
                  V2 cc = corner(k, sx * hl, sy * hw);
                  Var dx = cc.x - q.p[0], dy = cc.y - q.p[1];
                  problem.subject_to(dx * dx + dy * dy >= rr * rr);
                }
              }
              break;
            }
            default:
              break;
          }
        }
      }
    }

    // Waypoints.
    for (int j = 0; j < p->waypoints; ++j) {
      const int k = start[j];
      const int f = p->wp_flags[j];
      const double* v = p->wp_values + 3 * j;
      if (f & ARES_WP_POSITION) {
        problem.subject_to(x[k] == v[0]);
        problem.subject_to(y[k] == v[1]);
      }
      if (f & ARES_WP_HEADING) {
        const double ch = std::cos(v[2]), sh = std::sin(v[2]);
        problem.subject_to(s[k] * ch - c[k] * sh == 0.0);
        problem.subject_to(c[k] * ch + s[k] * sh >= 0.0);
      }
      if (f & ARES_WP_STOP) {
        problem.subject_to(vx[k] == 0.0);
        problem.subject_to(vy[k] == 0.0);
        problem.subject_to(w[k] == 0.0);
        // At rest the motor can push in any direction the module steers to,
        // up to its stall force (the P = F·v bound says nothing at v = 0).
        const double stall = has_current ? std::fmin(p->f_current_n, p->f_volt_n) : p->f_volt_n;
        for (int i = 0; i < M; ++i) {
          problem.subject_to(Fx[k][i] * Fx[k][i] + Fy[k][i] * Fy[k][i] <= stall * stall);
        }
      }
    }

    slp::Options options;
    options.tolerance = p->tolerance;
    options.max_iterations = p->max_iterations;
    if (p->timeout_s > 0) {
      options.timeout = std::chrono::duration<double>(p->timeout_s);
    }
    int iterations = 0;
    // ARES_TRACE=1: every 100 iterations, the total time the iterate implies
    // and how hard the constraints push back, on stderr. For debugging a
    // problem that will not converge.
    const bool trace = std::getenv("ARES_TRACE") != nullptr;
    // Some problems (load transfer off an axis, mostly) reach their optimum
    // and then stall short of the KKT tolerance: degenerate constraints keep
    // the duals from settling. When the total time has stopped moving for a
    // while, stop; Rust checks the result against the physics before using it.
    double guess_total = 0;
    for (int j = 0; j < p->segments; ++j) guess_total += p->guess_dt[j] * p->intervals[j];
    double last_t = -1;
    int last_check = 0;
    problem.add_callback([&](const slp::IterationInfo<double>& info) {
      ++iterations;
      const auto n = info.x.size();
      double t = 0;
      for (int j = 0; j < p->segments; ++j) t += info.x[n - p->segments + j] * p->intervals[j];
      if (info.iteration - last_check >= kStallWindow) {
        // Only once it beats the warm start: the spline is feasible, so an
        // iterate slower than it is still wandering, not finished.
        const bool stalled = last_t > 0 && std::fabs(t - last_t) <= kStallTolerance * t && t <= guess_total;
        last_t = t;
        last_check = info.iteration;
        if (stalled) return true;
      }
      if (trace && info.iteration % 100 == 0) {
        std::fprintf(stderr, "it %5d  T %.4f  |y|inf %.3g  |z|inf %.3g  min s %.3g\n", info.iteration, t,
                     info.y.size() ? info.y.cwiseAbs().maxCoeff() : 0.0,
                     info.z.size() ? info.z.cwiseAbs().maxCoeff() : 0.0,
                     info.s.size() ? info.s.minCoeff() : 0.0);
      }
      return false;
    });
    const int status = static_cast<int>(problem.solve(options));

    for (int k = 0; k < samples; ++k) {
      out->x[k] = x[k].value();
      out->y[k] = y[k].value();
      out->theta[k] = std::atan2(s[k].value(), c[k].value());
      out->vx[k] = vx[k].value();
      out->vy[k] = vy[k].value();
      out->omega[k] = w[k].value();
      out->ax[k] = ax[k].value();
      out->ay[k] = ay[k].value();
      out->alpha[k] = al[k].value();
      for (int i = 0; i < M; ++i) {
        out->fx[k * M + i] = Fx[k][i].value();
        out->fy[k * M + i] = Fy[k][i].value();
      }
    }
    for (int j = 0; j < p->segments; ++j) {
      out->dt[j] = dt[j].value();
    }
    out->status = status;
    out->iterations = iterations;
    return status;
  } catch (const std::exception&) {
    out->status = -100;
    return -100;
  } catch (...) {
    out->status = -100;
    return -100;
  }
}
