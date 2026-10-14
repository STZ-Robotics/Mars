//! Serialization of the WPILib structs the bridge publishes.
//!
//! A `struct:Pose2d` topic in NT4 carries raw little-endian bytes, with no
//! header and no length: the consumer knows how to read them because it first
//! read the descriptor published at `/.schema/struct:Pose2d`. Publishing the
//! value without its schema leaves the app with a blob it cannot decode.
//!
//! The layouts are pinned against `STRUCT_DEFS` in
//! `src/utils/dashboard/valueDecoding.ts`, which is the app's ground truth and
//! has its own tests against the 21 WPILib types.

/// A schema that has to be published before the type is used.
pub struct Schema {
    pub name: &'static str,
    pub descriptor: &'static str,
}

/// Every schema Pose2d and Pose3d depend on, in dependency order.
///
/// The leaf types are published as well as the composite ones because
/// `Pose2d`'s descriptor NAMES them (`Translation2d translation;Rotation2d
/// rotation`): without them the consumer knows there is a field but not how
/// big it is.
pub const SCHEMAS: &[Schema] = &[
    Schema { name: "Translation2d", descriptor: "double x;double y" },
    Schema { name: "Rotation2d", descriptor: "double value" },
    Schema { name: "Pose2d", descriptor: "Translation2d translation;Rotation2d rotation" },
    Schema { name: "Translation3d", descriptor: "double x;double y;double z" },
    Schema { name: "Quaternion", descriptor: "double w;double x;double y;double z" },
    Schema { name: "Rotation3d", descriptor: "Quaternion q" },
    Schema { name: "Pose3d", descriptor: "Translation3d translation;Rotation3d rotation" },
];

/// Pose2d: 24 bytes = x, y, theta (rad), little-endian.
pub fn pose2d(x: f64, y: f64, theta_rad: f64) -> Vec<u8> {
    let mut out = Vec::with_capacity(24);
    for v in [x, y, theta_rad] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Pose3d: 56 bytes = x, y, z (24 B) + quaternion w, x, y, z (32 B).
///
/// Rotation3d serializes as a QUATERNION, not as roll/pitch/yaw. Sending three
/// angles here produces a value that decodes without error and points
/// anywhere.
pub fn pose3d(x: f64, y: f64, z: f64, qw: f64, qx: f64, qy: f64, qz: f64) -> Vec<u8> {
    let mut out = Vec::with_capacity(56);
    for v in [x, y, z, qw, qx, qy, qz] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_match_wpilib() {
        // If these change, the app's STRUCT_DEFS and this no longer match.
        assert_eq!(pose2d(0.0, 0.0, 0.0).len(), 24);
        assert_eq!(pose3d(0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0).len(), 56);
    }

    #[test]
    fn fields_land_at_their_offset() {
        let b = pose2d(1.5, -2.5, 0.75);
        assert_eq!(f64::from_le_bytes(b[0..8].try_into().unwrap()), 1.5);
        assert_eq!(f64::from_le_bytes(b[8..16].try_into().unwrap()), -2.5);
        assert_eq!(f64::from_le_bytes(b[16..24].try_into().unwrap()), 0.75);

        let p = pose3d(1.0, 2.0, 3.0, 0.5, 0.6, 0.7, 0.8);
        assert_eq!(f64::from_le_bytes(p[16..24].try_into().unwrap()), 3.0);
        assert_eq!(f64::from_le_bytes(p[24..32].try_into().unwrap()), 0.5);
        assert_eq!(f64::from_le_bytes(p[48..56].try_into().unwrap()), 0.8);
    }

    #[test]
    fn dependencies_go_before_composites() {
        // Publishing Pose2d before Translation2d leaves a window in which the
        // app has the composite without its leaves.
        let pos = |n: &str| SCHEMAS.iter().position(|s| s.name == n).unwrap();
        assert!(pos("Translation2d") < pos("Pose2d"));
        assert!(pos("Rotation2d") < pos("Pose2d"));
        assert!(pos("Quaternion") < pos("Rotation3d"));
        assert!(pos("Rotation3d") < pos("Pose3d"));
        assert!(pos("Translation3d") < pos("Pose3d"));
    }
}
