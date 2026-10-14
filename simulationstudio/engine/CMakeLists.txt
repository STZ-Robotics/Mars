# MARS simulation engine: a headless Gazebo server.
#
# ALWAYS configure with the conda environment active. conda puts $CONDA_PREFIX
# in CMAKE_PREFIX_PATH, and the find_package calls below come from there:
#
#   conda activate mars-sim
#   cmake -S sim/engine -B sim/build -G Ninja
#   cmake --build sim/build
#
# On Windows the MSVC environment (vcvars64.bat) is also needed, because the
# conda-forge packages are built with MSVC and not with conda's compiler.
cmake_minimum_required(VERSION 3.22)
project(mars_sim_engine VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# The systems/ plugins are loaded as dynamic libraries at run time; without
# this they are not relocatable outside the build tree.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# CAREFUL: the packages go WITHOUT the version number in their name. In Jetty
# the CMake configs are installed as `gz-sim-config.cmake` and export the
# `gz-sim::gz-sim` target. The `gz-sim10` / `gz-sim10::gz-sim10` scheme died in
# Ionic. The version is requested as find_package's second argument, which is
# what keeps a `conda update` from moving us to Kilted without warning.
find_package(gz-sim 10 REQUIRED)
find_package(gz-transport 15 REQUIRED)
# The GUI component is requested separately: it brings Gazebo's 3D window,
# which is what we use as the world viewer instead of writing one.
find_package(gz-sim 10 REQUIRED COMPONENTS gui)

# --- Server ------------------------------------------------------------
# An executable of our own instead of the `gz sim` binary because we need to
# control the life cycle from Tauri: start, pause and kill the simulation as
# the app's sidecar, not as a loose process.
add_executable(mars-sim-server src/mars_sim_server.cc)

target_link_libraries(mars-sim-server
  PRIVATE
    gz-sim::gz-sim
    gz-transport::gz-transport
)

# --- Systems -----------------------------------------------------------
# gz-sim's plugins: dynamic libraries the server loads at run time according
# to what the world's <plugin> declares.
add_subdirectory(systems)

# --- Viewer ------------------------------------------------------------
# The 3D window. It CONNECTS to the server over gz-transport instead of
# loading the world itself, so it can be opened and closed without touching
# the physics.
add_executable(mars-sim-gui src/mars_sim_gui.cc)
target_link_libraries(mars-sim-gui PRIVATE gz-sim::gz-sim-gui)

install(TARGETS mars-sim-server mars-sim-gui RUNTIME DESTINATION bin)
