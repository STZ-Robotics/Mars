//! Ares to Gazebo: the robot as a URDF and the field as an SDF world, written into an `ares/sim/`
//! folder of the project, for MARS Simulation Studio (or `gz sim`) to run with real physics.
//!
//! - `robot.urdf`: the chassis (mass and inertia from the `.robot.json`), each swerve module as a
//!   steering joint and a wheel with the wheels' grip, and each FIXED camera as a link with a
//!   Gazebo camera sensor (its field of view, resolution and range).
//! - `world.sdf`: a world named `mars` (the Studio's contract), its physics, the carpet and the
//!   perimeter, the field's structures (the 2.5D map) as static boxes, every AprilTag as a plate
//!   with its real tag36h11 picture, the 3D field model as a visual when MARS Desktop has one,
//!   and the robot where the path starts.
//! - `tags/tag_<id>.png`: those pictures.
//!
//! Nothing here runs Gazebo: it writes what Gazebo reads.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use ares_core::vision::{Occluder, Tag};
use ares_core::RobotConfig;
use serde::{Deserialize, Serialize};

/// The black square of a 6.5 in tag; the whole picture (white border included) is 10/8 of it.
const TAG_BLACK_M: f64 = 0.1651;
const BUMPER_HEIGHT: f64 = 0.13;
/// Bumper bottom above the carpet.
const BUMPER_CLEARANCE: f64 = 0.02;
const STEER_MASS: f64 = 0.4;
const WHEEL_MASS: f64 = 0.35;
const WHEEL_WIDTH: f64 = 0.038;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimRequest {
    pub robot: RobotConfig,
    pub field_length_m: f64,
    pub field_width_m: f64,
    pub tags: Vec<Tag>,
    pub occluders: Vec<Occluder>,
    /// Where the robot starts: (x, y, heading in radians).
    pub start: Option<[f64; 3]>,
    /// MARS Desktop's 3D field (`model.glb`), drawn as the field's look when given...
    pub field_model: Option<String>,
    /// ...turned by its config's rotations, as roll, pitch, yaw (radians). Unset: +90 about X.
    #[serde(default)]
    pub field_model_rpy: Option<[f64; 3]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimExport {
    pub dir: String,
    pub files: Vec<String>,
}

/// `ares/sim/` at the root of the robot project (the folder that holds `src/main/deploy`), so it
/// is not deployed to the robot; next to the `.robot.json` when it is not in a robot project.
pub fn sim_dir(robot_path: &Path) -> PathBuf {
    let dir = robot_path.parent().unwrap_or(Path::new("."));
    for a in dir.ancestors() {
        if a.file_name().is_some_and(|n| n == "deploy")
            && a.parent().and_then(|m| m.file_name()).is_some_and(|n| n == "main")
            && a.parent().and_then(Path::parent).and_then(|s| s.file_name()).is_some_and(|n| n == "src")
        {
            if let Some(root) = a.parent().and_then(Path::parent).and_then(Path::parent) {
                return root.join("ares").join("sim");
            }
        }
    }
    dir.join("sim")
}

#[tauri::command]
pub fn sim_export(robot_path: String, request: SimRequest) -> Result<SimExport, String> {
    let dir = sim_dir(Path::new(&robot_path));
    write_all(&dir, &request).map_err(|e| format!("Could not write {}: {e}", dir.display()))?;
    let mut files = vec!["robot.urdf".to_string(), "world.sdf".to_string(), "README.md".to_string()];
    files.extend(request.tags.iter().map(|t| format!("tags/tag_{}.png", t.id)));
    Ok(SimExport { dir: dir.to_string_lossy().to_string(), files })
}

pub fn write_all(dir: &Path, r: &SimRequest) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join("tags"))?;
    std::fs::write(dir.join("robot.urdf"), urdf(&r.robot))?;
    std::fs::write(dir.join("world.sdf"), world(r))?;
    std::fs::write(dir.join("README.md"), readme(&r.robot))?;
    for t in &r.tags {
        if let Some(png) = tag_png(t.id, 20) {
            std::fs::write(dir.join("tags").join(format!("tag_{}.png", t.id)), png)?;
        }
    }
    Ok(())
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A link-friendly name: letters, digits and underscores.
fn ident(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    if t.is_empty() { "unnamed".into() } else { t }
}

fn box_inertia(m: f64, x: f64, y: f64, z: f64) -> String {
    format!(
        r#"<inertia ixx="{:.6}" ixy="0" ixz="0" iyy="{:.6}" iyz="0" izz="{:.6}"/>"#,
        m * (y * y + z * z) / 12.0,
        m * (x * x + z * z) / 12.0,
        m * (x * x + y * y) / 12.0
    )
}

/// The robot: the chassis at the carpet (its frame is WPILib's robot frame, so the cameras'
/// transforms are the robot code's), the modules, the fixed cameras.
pub fn urdf(robot: &RobotConfig) -> String {
    let sw = robot.swerve();
    let (l, w) = (robot.bumper.length_m, robot.bumper.width_m);
    let r = sw.wheel_radius_m;
    let n = sw.modules.len() as f64;
    let chassis_mass = (robot.mass_kg - n * (STEER_MASS + WHEEL_MASS)).max(1.0);
    // The chassis' yaw inertia minus what the modules carry at their corners.
    let modules_izz: f64 = sw.modules.iter().map(|m| (STEER_MASS + WHEEL_MASS) * (m.x_m * m.x_m + m.y_m * m.y_m)).sum();
    let izz = (robot.moi_kg_m2 - modules_izz).max(0.1);
    let zc = robot.cog_height_m.unwrap_or(BUMPER_CLEARANCE + BUMPER_HEIGHT / 2.0);
    let bz = BUMPER_CLEARANCE + BUMPER_HEIGHT / 2.0;
    let mut s = String::new();
    let _ = writeln!(s, r#"<?xml version="1.0"?>"#);
    let _ = writeln!(s, "<!-- Generated by Ares from {}'s robot.json. Edit the robot in Ares and export again. -->", esc(&robot.name));
    let _ = writeln!(s, "<!-- The cameras are FIXED to the chassis: they turn with the robot and nothing else. -->");
    let _ = writeln!(s, r#"<robot name="{}">"#, ident(&robot.name));
    let _ = writeln!(s, r#"  <link name="base_link">"#);
    let _ = writeln!(s, r#"    <inertial><origin xyz="0 0 {zc:.4}"/><mass value="{chassis_mass:.3}"/><inertia ixx="{:.4}" ixy="0" ixz="0" iyy="{:.4}" iyz="0" izz="{izz:.4}"/></inertial>"#,
        chassis_mass * (w * w + BUMPER_HEIGHT * BUMPER_HEIGHT) / 12.0, chassis_mass * (l * l + BUMPER_HEIGHT * BUMPER_HEIGHT) / 12.0);
    let _ = writeln!(s, r#"    <visual><origin xyz="0 0 {bz:.4}"/><geometry><box size="{l:.4} {w:.4} {BUMPER_HEIGHT}"/></geometry><material name="bumper"><color rgba="0.66 0.24 0.24 1"/></material></visual>"#);
    let _ = writeln!(s, r#"    <collision><origin xyz="0 0 {bz:.4}"/><geometry><box size="{l:.4} {w:.4} {BUMPER_HEIGHT}"/></geometry></collision>"#);
    let _ = writeln!(s, "  </link>");
    for m in &sw.modules {
        let id = ident(&m.name);
        let _ = writeln!(s, r#"  <link name="{id}_steer"><inertial><mass value="{STEER_MASS}"/>{}</inertial></link>"#, box_inertia(STEER_MASS, 0.08, 0.08, 0.06));
        let _ = writeln!(s, r#"  <joint name="{id}_steer_joint" type="continuous"><parent link="base_link"/><child link="{id}_steer"/><origin xyz="{:.4} {:.4} {r:.4}"/><axis xyz="0 0 1"/><dynamics damping="0.05"/></joint>"#, m.x_m, m.y_m);
        let iw = WHEEL_MASS * r * r / 2.0;
        let it = WHEEL_MASS * (3.0 * r * r + WHEEL_WIDTH * WHEEL_WIDTH) / 12.0;
        let _ = writeln!(s, r#"  <link name="{id}_wheel"><inertial><mass value="{WHEEL_MASS}"/><inertia ixx="{it:.6}" ixy="0" ixz="0" iyy="{iw:.6}" iyz="0" izz="{it:.6}"/></inertial>"#);
        let _ = writeln!(s, r#"    <visual><origin rpy="1.5708 0 0"/><geometry><cylinder radius="{r:.4}" length="{WHEEL_WIDTH}"/></geometry><material name="tread"><color rgba="0.1 0.1 0.1 1"/></material></visual>"#);
        let _ = writeln!(s, r#"    <collision><origin rpy="1.5708 0 0"/><geometry><cylinder radius="{r:.4}" length="{WHEEL_WIDTH}"/></geometry></collision></link>"#);
        let _ = writeln!(s, r#"  <joint name="{id}_wheel_joint" type="continuous"><parent link="{id}_steer"/><child link="{id}_wheel"/><origin xyz="0 0 0"/><axis xyz="0 1 0"/><dynamics damping="0.01"/></joint>"#);
        let _ = writeln!(s, r#"  <gazebo reference="{id}_wheel"><mu1>{:.3}</mu1><mu2>{:.3}</mu2></gazebo>"#, sw.wheel_cof, sw.wheel_cof);
    }
    for c in &robot.cameras {
        let id = ident(&c.name);
        let (width, height) = image_size(c.horizontal_fov_deg, c.vertical_fov_deg);
        let _ = writeln!(s, "  <!-- {} (fixed): WPILib's robot-to-camera transform, URDF's rpy is the same roll, pitch, yaw. -->", esc(&c.name));
        let _ = writeln!(s, r#"  <link name="{id}_camera"><inertial><mass value="0.05"/>{}</inertial>"#, box_inertia(0.05, 0.03, 0.08, 0.05));
        let _ = writeln!(s, r#"    <visual><geometry><box size="0.03 0.08 0.05"/></geometry><material name="lens"><color rgba="0.22 1 0.08 1"/></material></visual></link>"#);
        let _ = writeln!(s, r#"  <joint name="{id}_camera_joint" type="fixed"><parent link="base_link"/><child link="{id}_camera"/><origin xyz="{:.4} {:.4} {:.4}" rpy="{:.5} {:.5} {:.5}"/></joint>"#,
            c.x_m, c.y_m, c.z_m, c.roll_deg.to_radians(), c.pitch_deg.to_radians(), c.yaw_deg.to_radians());
        let _ = writeln!(s, r#"  <gazebo reference="{id}_camera"><sensor name="{id}" type="camera"><always_on>true</always_on><update_rate>30</update_rate><topic>ares/cameras/{id}</topic>"#);
        let _ = writeln!(s, r#"    <camera><horizontal_fov>{:.5}</horizontal_fov><image><width>{width}</width><height>{height}</height></image><clip><near>0.05</near><far>{:.2}</far></clip></camera></sensor></gazebo>"#,
            c.horizontal_fov_deg.to_radians(), c.max_range_m + 1.0);
    }
    let _ = writeln!(s, "</robot>");
    s
}

/// A camera image with the field of view's aspect, 1280 pixels across (an OV9281's width).
fn image_size(hfov_deg: f64, vfov_deg: f64) -> (u32, u32) {
    let aspect = (hfov_deg.to_radians() / 2.0).tan() / (vfov_deg.to_radians() / 2.0).tan();
    (1280, ((1280.0 / aspect).round() as u32).max(1))
}

fn static_box(name: &str, pose: [f64; 6], size: [f64; 3], rgba: &str, collide: bool) -> String {
    let p = pose.map(|v| format!("{v:.4}")).join(" ");
    let sz = size.map(|v| format!("{v:.4}")).join(" ");
    let collision = if collide { format!("<collision name=\"c\"><geometry><box><size>{sz}</size></box></geometry></collision>") } else { String::new() };
    format!(
        "    <model name=\"{}\"><static>true</static><pose>{p}</pose><link name=\"l\">{collision}<visual name=\"v\"><geometry><box><size>{sz}</size></box></geometry><material><diffuse>{rgba}</diffuse><ambient>{rgba}</ambient></material></visual></link></model>\n",
        esc(name)
    )
}

/// The field: physics as MARS Simulation Studio runs it, the carpet, the walls, the structures,
/// the tags, and the robot.
pub fn world(r: &SimRequest) -> String {
    let (lf, wf) = (r.field_length_m, r.field_width_m);
    let mut s = String::new();
    s.push_str("<?xml version=\"1.0\"?>\n<!-- Generated by Ares. The world is called mars: MARS Simulation Studio's topics expect it. -->\n");
    s.push_str("<sdf version=\"1.10\">\n  <world name=\"mars\">\n");
    s.push_str("    <physics name=\"4ms\" type=\"dart\"><max_step_size>0.004</max_step_size><real_time_factor>1.0</real_time_factor></physics>\n");
    for (file, name) in [
        ("gz-sim-physics-system", "gz::sim::systems::Physics"),
        ("gz-sim-user-commands-system", "gz::sim::systems::UserCommands"),
        ("gz-sim-scene-broadcaster-system", "gz::sim::systems::SceneBroadcaster"),
        ("gz-sim-sensors-system", "gz::sim::systems::Sensors"),
    ] {
        let extra = if file.contains("sensors") { "<render_engine>ogre2</render_engine>" } else { "" };
        let _ = writeln!(s, "    <plugin filename=\"{file}\" name=\"{name}\">{extra}</plugin>");
    }
    s.push_str("    <light type=\"directional\" name=\"sun\"><cast_shadows>true</cast_shadows><pose>0 0 10 0 0 0</pose><diffuse>0.9 0.9 0.9 1</diffuse><direction>-0.4 0.2 -0.9</direction></light>\n");
    // The carpet, with the grip of an FRC field.
    let _ = writeln!(s, "    <model name=\"carpet\"><static>true</static><pose>{:.4} {:.4} 0 0 0 0</pose><link name=\"l\"><collision name=\"c\"><geometry><plane><normal>0 0 1</normal><size>{:.3} {:.3}</size></plane></geometry><surface><friction><ode><mu>1.0</mu><mu2>1.0</mu2></ode></friction></surface></collision><visual name=\"v\"><geometry><plane><normal>0 0 1</normal><size>{:.3} {:.3}</size></plane></geometry><material><diffuse>0.32 0.33 0.36 1</diffuse></material></visual></link></model>",
        lf / 2.0, wf / 2.0, lf + 4.0, wf + 4.0, lf + 4.0, wf + 4.0);
    // The perimeter.
    let h = 0.5;
    for (name, x, y, sx, sy) in [
        ("wall_blue", -0.05, wf / 2.0, 0.1, wf + 0.2),
        ("wall_red", lf + 0.05, wf / 2.0, 0.1, wf + 0.2),
        ("wall_right", lf / 2.0, -0.05, lf + 0.2, 0.1),
        ("wall_left", lf / 2.0, wf + 0.05, lf + 0.2, 0.1),
    ] {
        s.push_str(&static_box(name, [x, y, h / 2.0, 0.0, 0.0, 0.0], [sx, sy, h], "0.6 0.64 0.7 1", true));
    }
    // The field's look, from MARS Desktop's model: AdvantageScope's frame is Y up and centered.
    if let Some(model) = &r.field_model {
        let uri = model.replace('\\', "/");
        let _ = writeln!(s, "    <!-- The field's look only: its structures collide through the boxes below. -->");
        let [rr, rp, ry] = r.field_model_rpy.unwrap_or([std::f64::consts::FRAC_PI_2, 0.0, 0.0]);
        let _ = writeln!(s, "    <model name=\"field_look\"><static>true</static><pose>{:.4} {:.4} 0 {rr:.5} {rp:.5} {ry:.5}</pose><link name=\"l\"><visual name=\"v\"><geometry><mesh><uri>file://{}</uri></mesh></geometry></visual></link></model>",
            lf / 2.0, wf / 2.0, esc(&uri));
    }
    // The structures (the 2.5D map), as what the robot bumps into and the cameras cannot see past.
    for (i, o) in r.occluders.iter().enumerate() {
        let name = if o.name.is_empty() { format!("structure_{i}") } else { format!("structure_{}", ident(&o.name)) };
        let zc = (o.z_min_m + o.z_max_m) / 2.0;
        s.push_str(&static_box(&name, [o.x, o.y, zc, 0.0, 0.0, o.yaw_deg.to_radians()], [o.length_m, o.width_m, (o.z_max_m - o.z_min_m).max(0.01)], "0.2 0.25 0.33 0.6", true));
    }
    // The tags: a thin plate facing where the tag faces, its picture on the front.
    let side = TAG_BLACK_M * ares_core::tag36h11::TOTAL_WIDTH as f64 / 8.0;
    for t in &r.tags {
        let yaw = t.ny.atan2(t.nx);
        let pitch = -t.nz.clamp(-1.0, 1.0).asin();
        let _ = writeln!(s, "    <model name=\"tag_{}\"><static>true</static><pose>{:.4} {:.4} {:.4} 0 {:.5} {:.5}</pose><link name=\"l\"><visual name=\"v\"><pose>0.002 0 0 0 0 0</pose><geometry><box><size>0.004 {side:.4} {side:.4}</size></box></geometry><material><diffuse>1 1 1 1</diffuse><pbr><metal><albedo_map>tags/tag_{}.png</albedo_map></metal></pbr></material></visual></link></model>",
            t.id, t.x, t.y, t.z, pitch, yaw, t.id);
    }
    // The robot, where the path starts.
    let [x, y, th] = r.start.unwrap_or([lf / 4.0, wf / 2.0, 0.0]);
    let _ = writeln!(s, "    <include><uri>robot.urdf</uri><name>{}</name><pose>{x:.4} {y:.4} 0.005 0 0 {th:.5}</pose></include>", ident(&r.robot.name));
    s.push_str("  </world>\n</sdf>\n");
    s
}

fn readme(robot: &RobotConfig) -> String {
    format!(
        "# {} in Gazebo\n\nWritten by Ares (Paths → 3D → Export to Gazebo). Export again after changing the robot or the field: these files are replaced.\n\n\
         - `robot.urdf`: the chassis, the swerve modules (steering and wheel joints, the wheels' grip) and the **fixed** cameras with their Gazebo camera sensors.\n\
         - `world.sdf`: the world `mars` with the carpet, the walls, the field's structures as boxes, the AprilTags (`tags/`) and the robot where the path starts.\n\n\
         Run it in MARS Simulation Studio (open `world.sdf` as an external world), or from the `mars-sim` conda environment:\n\n\
         ```\ngz sim world.sdf\n```\n\n\
         The bumps, ramps and the trench are not in the 2.5D map (it is about what the cameras see): add them as boxes to the world, or use the field geometry of `tools/bump3d`.\n",
        robot.name
    )
}

// --- A minimal PNG writer (8-bit grayscale, stored deflate): no image crate for 32 small tags ---

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &d in data {
        a = (a + d as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend((data.len() as u32).to_be_bytes());
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend(crc32(&body).to_be_bytes());
}

/// A grayscale PNG, `pixels` row by row.
pub fn png_gray(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((width as usize + 1) * height as usize);
    for row in pixels.chunks(width as usize) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    // zlib: header, stored blocks of up to 65535 bytes, adler32.
    let mut z = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, b) in blocks.iter().enumerate() {
        z.push(if i + 1 == blocks.len() { 1 } else { 0 });
        z.extend((b.len() as u16).to_le_bytes());
        z.extend((!(b.len() as u16)).to_le_bytes());
        z.extend_from_slice(b);
    }
    z.extend(adler32(&raw).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut ihdr = Vec::new();
    ihdr.extend(width.to_be_bytes());
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8, 0, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A tag's picture, `scale` pixels per cell, as a PNG.
pub fn tag_png(id: u32, scale: usize) -> Option<Vec<u8>> {
    let cells = ares_core::tag36h11::tag36h11(id)?;
    let n = ares_core::tag36h11::TOTAL_WIDTH * scale;
    let mut px = vec![0u8; n * n];
    for (y, row) in px.chunks_mut(n).enumerate() {
        for (x, p) in row.iter_mut().enumerate() {
            *p = if cells[y / scale][x / scale] { 255 } else { 0 };
        }
    }
    Some(png_gray(n as u32, n as u32, &px))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SimRequest {
        let mut robot = crate::tests_robot();
        robot.cameras = vec![ares_core::robot::CameraConfig {
            name: "limelight".into(), x_m: 0.3425, y_m: 0.07, z_m: 0.42, roll_deg: 0.0, pitch_deg: -10.0, yaw_deg: 0.0,
            horizontal_fov_deg: 82.0, vertical_fov_deg: 56.2, max_range_m: 6.0, model: None,
        }];
        let tags = ares_core::vision::tags_from_wpilib_layout(include_str!("../../src/field/tags/2026-rebuilt-welded.json")).unwrap();
        let occluders = ares_core::vision::estimate_occluders(&tags);
        SimRequest { robot, field_length_m: 16.541, field_width_m: 8.069, tags, occluders, start: Some([3.0, 4.0, 0.5]), field_model: std::env::var("ARES_FIELD_GLB").ok(), field_model_rpy: None }
    }

    #[test]
    fn the_robot_has_its_modules_and_its_fixed_camera() {
        let r = request();
        let u = urdf(&r.robot);
        assert_eq!(u.matches("_steer_joint\" type=\"continuous\"").count(), 4);
        assert_eq!(u.matches("_wheel_joint\" type=\"continuous\"").count(), 4);
        assert!(u.contains(r#"<joint name="limelight_camera_joint" type="fixed">"#));
        // WPILib's pitch of -10 degrees, as URDF's rpy (the same convention).
        assert!(u.contains(r#"<origin xyz="0.3425 0.0700 0.4200" rpy="0.00000 -0.17453 0.00000"/>"#), "{u}");
        assert!(u.contains("<horizontal_fov>1.43117</horizontal_fov>"));
        assert!(u.contains("<mu1>"));
        balanced(&u);
    }

    #[test]
    fn the_world_is_mars_with_walls_structures_tags_and_the_robot_at_the_start() {
        let r = request();
        let w = world(&r);
        assert!(w.contains("<world name=\"mars\">"));
        assert_eq!(w.matches("<model name=\"wall_").count(), 4);
        assert_eq!(w.matches("<model name=\"structure_").count(), r.occluders.len());
        assert_eq!(w.matches("<model name=\"tag_").count(), 32);
        assert!(w.contains("<albedo_map>tags/tag_25.png</albedo_map>"));
        assert!(w.contains("<pose>3.0000 4.0000 0.005 0 0 0.50000</pose>"));
        balanced(&w);
    }

    #[test]
    fn the_tag_pictures_are_valid_pngs() {
        let png = tag_png(25, 20).unwrap();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        // IHDR: 200 x 200, 8-bit grayscale.
        assert_eq!(&png[16..24], &[0, 0, 0, 200, 0, 0, 0, 200]);
        assert_eq!(png[24], 8);
        assert_eq!(png[25], 0);
        // Every chunk's CRC checks.
        let mut i = 8;
        while i < png.len() {
            let len = u32::from_be_bytes(png[i..i + 4].try_into().unwrap()) as usize;
            let crc = u32::from_be_bytes(png[i + 8 + len..i + 12 + len].try_into().unwrap());
            assert_eq!(crc32(&png[i + 4..i + 8 + len]), crc);
            i += 12 + len;
        }
        assert!(tag_png(999, 20).is_none());
    }

    #[test]
    fn it_writes_beside_the_robot_project_not_into_deploy() {
        let p = Path::new("C:/team/robot/src/main/deploy/ares/ares.robot.json");
        assert_eq!(sim_dir(p), Path::new("C:/team/robot/ares/sim"));
        assert_eq!(sim_dir(Path::new("C:/somewhere/bot.robot.json")), Path::new("C:/somewhere/sim"));
    }

    /// Writes a full export where `ARES_SIM_OUT` says, for checking it with outside tools.
    #[test]
    #[ignore]
    fn write_a_sample_export() {
        let out = std::env::var("ARES_SIM_OUT").expect("ARES_SIM_OUT");
        write_all(Path::new(&out), &request()).unwrap();
    }

    /// Every element opened is closed, in order: well-formed enough for Gazebo's parser to read.
    fn balanced(xml: &str) {
        let mut stack: Vec<String> = Vec::new();
        let mut rest = xml;
        while let Some(i) = rest.find('<') {
            rest = &rest[i + 1..];
            let end = rest.find('>').expect("an unclosed tag");
            let tag = &rest[..end];
            rest = &rest[end + 1..];
            if tag.starts_with('?') || tag.starts_with('!') || tag.ends_with('/') {
                continue;
            }
            if let Some(name) = tag.strip_prefix('/') {
                assert_eq!(stack.pop().as_deref(), Some(name.trim()), "closing {name}");
            } else {
                stack.push(tag.split_whitespace().next().unwrap().to_string());
            }
        }
        assert!(stack.is_empty(), "left open: {stack:?}");
    }
}
