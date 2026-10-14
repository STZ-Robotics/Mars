//! Translation between Gazebo's frame and WPILib's.
//!
//! Gazebo has its origin at the CENTER of the field; WPILib has it at the
//! corner of the blue alliance wall, with +X towards the opposite wall and +Y
//! to the left. Both are right-handed with Z up and yaw positive
//! counter-clockwise, so the conversion is a pure translation: there is no
//! rotation and no mirroring.
//!
//! The bridge publishes in WPILib's convention, not Gazebo's, and that is
//! deliberate: that way the simulation is indistinguishable from a real robot
//! from the app's side, which already knows how to convert between
//! `wall_blue`, `center` and `center_rotated` with its COORDS selector.
//! Publishing in Gazebo coordinates would force a "sim mode" special case into
//! the renderer.

/// Field dimensions. They have to match the world's `<plane><size>`: if they
/// diverge, the poses come out shifted and there is no error.
/// `sim/protocol/check.py` verifies they match.
#[derive(Debug, Clone, Copy)]
pub struct Field {
    pub length_m: f64,
    pub width_m: f64,
}

impl Field {
    /// Moves a position from Gazebo's frame to WPILib's.
    pub fn to_wpilib(&self, gz_x: f64, gz_y: f64) -> (f64, f64) {
        (gz_x + self.length_m / 2.0, gz_y + self.width_m / 2.0)
    }
}

/// Yaw in radians from a quaternion, in the range [-pi, pi].
///
/// It is the only component that survives going to Pose2d. It is computed
/// with atan2 and not by solving for the angle from a single term, so it works
/// in all four quadrants and does not break near +-90 degrees.
pub fn yaw_from_quaternion(w: f64, x: f64, y: f64, z: f64) -> f64 {
    let siny_cosp = 2.0 * (w * z + x * y);
    let cosy_cosp = 1.0 - 2.0 * (y * y + z * z);
    siny_cosp.atan2(cosy_cosp)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 16.54 x 8.21 field, the same the repository's worlds use.
    fn field() -> Field {
        Field { length_m: 16.54, width_m: 8.21 }
    }

    #[test]
    fn gazebo_center_is_the_field_center() {
        let (x, y) = field().to_wpilib(0.0, 0.0);
        assert!((x - 8.27).abs() < 1e-9);
        assert!((y - 4.105).abs() < 1e-9);
    }

    #[test]
    fn the_blue_corner_is_the_wpilib_origin() {
        // The blue wall's corner is at (-length/2, -width/2) in Gazebo.
        let (x, y) = field().to_wpilib(-8.27, -4.105);
        assert!(x.abs() < 1e-9, "x = {x}");
        assert!(y.abs() < 1e-9, "y = {y}");
    }

    #[test]
    fn yaw_comes_out_in_all_four_quadrants() {
        // Identity: facing +X.
        assert!(yaw_from_quaternion(1.0, 0.0, 0.0, 0.0).abs() < 1e-9);

        // 90 degrees counter-clockwise about Z: q = (cos45, 0, 0, sin45).
        let h = std::f64::consts::FRAC_1_SQRT_2;
        let yaw = yaw_from_quaternion(h, 0.0, 0.0, h);
        assert!((yaw - std::f64::consts::FRAC_PI_2).abs() < 1e-9, "yaw = {yaw}");

        // -90 degrees. A naive asin solve would give the same value as +90.
        let yaw = yaw_from_quaternion(h, 0.0, 0.0, -h);
        assert!((yaw + std::f64::consts::FRAC_PI_2).abs() < 1e-9, "yaw = {yaw}");

        // 180 degrees: the case where cosy_cosp changes sign.
        let yaw = yaw_from_quaternion(0.0, 0.0, 0.0, 1.0);
        assert!((yaw.abs() - std::f64::consts::PI).abs() < 1e-9, "yaw = {yaw}");
    }
}
