use std::path::Path;

fn main() {
    // The UI is EMBEDDED in the binary at compile time (done by
    // `tauri::generate_context!` from tauri.conf.json's `frontendDist`), and
    // `tauri-build` only emits rerun-if-changed for tauri.conf.json and
    // capabilities/. Without this, editing a .js or a .css and building again
    // recompiles nothing: cargo says "Finished", the app opens with the
    // previous version and the change simply does not show up, without any
    // error. Half an hour goes into hunting the bug in code that was fine.
    //
    // No watcher helps here: the files have to be listed.
    watch(Path::new("ui"));

    tauri_build::build()
}

fn watch(dir: &Path) {
    // A watched directory also triggers a rebuild when a file inside it
    // appears or disappears, which covers the case of adding a new page.
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            watch(&p);
        } else {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
}
