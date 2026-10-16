//! Builds Sleipnir and `nlp/ares_nlp.cpp` with CMake and links them in.

fn main() {
    let mut config = cmake::Config::new(".");
    config.profile("Release").define("BUILD_TESTING", "OFF");
    if cfg!(target_os = "windows") {
        config.cxxflag("/EHsc");
    }
    let dest = config.build();

    // Sleipnir's static library stays in its build tree; the install step only
    // copies ours.
    for dir in ["lib", "build", "build/_deps/sleipnir-build", "build/_deps/sleipnir-build/Release"] {
        println!("cargo:rustc-link-search=native={}/{dir}", dest.display());
    }
    println!("cargo:rustc-link-lib=static=ares_nlp");
    println!("cargo:rustc-link-lib=static=Sleipnir");
    if cfg!(target_os = "linux") {
        println!("cargo:rustc-link-lib=stdc++");
    } else if cfg!(target_os = "macos") {
        println!("cargo:rustc-link-lib=c++");
    }

    println!("cargo:rerun-if-changed=CMakeLists.txt");
    println!("cargo:rerun-if-changed=nlp");
}
