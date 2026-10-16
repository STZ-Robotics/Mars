//! The little 2D math the core needs. No dependency: it is a handful of lines
//! and the solver calls it millions of times.

use std::f64::consts::PI;
use std::ops::{Add, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Vec2 { x, y }
    }

    pub fn dot(self, o: Vec2) -> f64 {
        self.x * o.x + self.y * o.y
    }

    pub fn norm2(self) -> f64 {
        self.dot(self)
    }

    pub fn norm(self) -> f64 {
        self.norm2().sqrt()
    }

    /// Rotated +90°: `ω × r` in the plane is `ω * r.perp()`.
    pub fn perp(self) -> Vec2 {
        Vec2::new(-self.y, self.x)
    }

    pub fn rotate(self, angle: f64) -> Vec2 {
        let (s, c) = angle.sin_cos();
        Vec2::new(c * self.x - s * self.y, s * self.x + c * self.y)
    }

    /// The unit vector, or zero for a vector too short to have a direction.
    pub fn normalized(self) -> Vec2 {
        let n = self.norm();
        if n < 1e-12 {
            Vec2::ZERO
        } else {
            self * (1.0 / n)
        }
    }

    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x + o.x, self.y + o.y)
    }
}

impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x - o.x, self.y - o.y)
    }
}

impl Mul<f64> for Vec2 {
    type Output = Vec2;
    fn mul(self, k: f64) -> Vec2 {
        Vec2::new(self.x * k, self.y * k)
    }
}

impl Neg for Vec2 {
    type Output = Vec2;
    fn neg(self) -> Vec2 {
        Vec2::new(-self.x, -self.y)
    }
}

/// Brings an angle to (-π, π].
pub fn wrap_angle(a: f64) -> f64 {
    let mut r = (a + PI).rem_euclid(2.0 * PI) - PI;
    if r <= -PI {
        r += 2.0 * PI;
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_to_the_half_open_interval() {
        assert!((wrap_angle(3.0 * PI) - PI).abs() < 1e-12);
        assert!((wrap_angle(-PI) - PI).abs() < 1e-12);
        assert!((wrap_angle(0.5) - 0.5).abs() < 1e-12);
        assert!((wrap_angle(-7.0) - (-7.0 + 2.0 * PI)).abs() < 1e-12);
    }

    #[test]
    fn perp_is_a_quarter_turn() {
        let v = Vec2::new(1.0, 2.0);
        let r = v.rotate(PI / 2.0);
        assert!((r.x - v.perp().x).abs() < 1e-12 && (r.y - v.perp().y).abs() < 1e-12);
    }
}
