# 3D fields and robots that ship with the app

For a 3D field or robot to show up in the Field 3D selector **without the user
having to download anything**, drop a folder here in AdvantageScope's format:

    public/fields3d/<Name>/config.json
    public/fields3d/<Name>/model.glb
    public/fields3d/<Name>/model_0.glb   (optional: game pieces / components)

The glob in `src/utils/field3d/assetStore.ts` picks them up at build time
without touching code, just like the 2D fields in `public/fields/`.

**Think twice before using it.** A season's official model weighs ~18 MB;
putting it here adds it to the repository and to every build. The usual way is
to install it from the Field 3D's **Assets** tab, which downloads it once and
keeps it in `%APPDATA%/MARS/assets3d/` (or the system's equivalent). This folder
is for small fields of your own: a practice field, a mock-up.

## Format

`config.json` is the same one AdvantageScope documents. The minimum for a
field:

```json
{
  "name": "My field",
  "coordinateSystem": "wall-blue",
  "rotations": [{ "axis": "x", "degrees": 90 }],
  "widthInches": 651.22,
  "heightInches": 317.677
}
```

`rotations` is what takes the file's model into WPILib's Z-up frame; a glTF
exported with the format's convention (Y up) needs the example's +90° around X.
After applying them, the model has to end up centered on the playing area with
the blue alliance at -X.

**A `.step` does not work here.** It is a boundary-representation CAD format,
with no meshes. Convert it to `.glb` first (CAD Assistant, with *merge faces
within the same part* turned on).
