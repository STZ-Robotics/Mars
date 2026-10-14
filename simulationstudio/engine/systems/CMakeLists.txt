# gz-sim systems: dynamic libraries the engine loads at run time, declared
# from a world's <plugin>.
#
# The file name matters: gz-sim looks for `MarsLink.dll` (or .so) by the
# <plugin>'s filename= attribute, so the library carries NO `lib` prefix and
# no version suffix. Hence PREFIX "".

add_library(MarsLink SHARED MarsLink.cc)

target_link_libraries(MarsLink
  PRIVATE
    gz-sim::gz-sim
    gz-transport::gz-transport
)

set_target_properties(MarsLink PROPERTIES PREFIX "")

# The engine looks for the systems next to the executable, so the binary and
# its plugins travel together when packaged as a Tauri sidecar.
set_target_properties(MarsLink PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)

install(TARGETS MarsLink LIBRARY DESTINATION lib RUNTIME DESTINATION bin)
