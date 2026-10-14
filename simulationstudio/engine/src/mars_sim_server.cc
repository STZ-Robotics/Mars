// MARS simulation server.
//
// Phase 0's proof of life: brings up a Gazebo world with no interface and
// leaves it running. It still talks to nobody; all it proves is that the
// environment builds and links against Gazebo Jetty.
//
// Usage:
//   mars-sim-server [world.sdf] [iterations | run]
//
// Without a second argument it runs forever and starts PAUSED, which is the
// real mode: the bridge is the one that decides when the match starts. With a
// number it runs that many steps and exits, which is how the physics is
// verified to advance. With `run` it runs forever and unpaused, which is what
// an external subscriber needs to have something to read.

#include <cstdlib>
#include <iostream>
#include <string>

#include <gz/common/Console.hh>
#include <gz/sim/Server.hh>
#include <gz/sim/ServerConfig.hh>

int main(int argc, char **argv)
{
  const std::string worldFile = (argc > 1) ? argv[1] : "worlds/empty.sdf";

  unsigned int iterations = 0;
  bool paused = true;
  if (argc > 2)
  {
    const std::string mode = argv[2];
    if (mode == "run")
    {
      paused = false;  // iterations stays at 0: unbounded
    }
    else
    {
      iterations = static_cast<unsigned int>(std::strtoul(mode.c_str(), nullptr, 10));
      if (iterations == 0)
      {
        std::cerr << "[mars-sim] invalid second argument: " << mode
                  << " (expected an iteration count or 'run')" << std::endl;
        return EXIT_FAILURE;
      }
      paused = false;
    }
  }

  // By default gz-sim only shows errors. With MARS_VERBOSE=4 the systems'
  // gzmsg come out too, which is the only way to see whether a plugin loaded:
  // if the <plugin>'s filename is wrong, gz-sim silently ignores it.
  if (const char *v = std::getenv("MARS_VERBOSE"))
    gz::common::Console::SetVerbosity(std::atoi(v));

  gz::sim::ServerConfig config;
  config.SetSdfFile(worldFile);

  // No GUI and no rendering: the visualization is MARS, which receives the
  // world's state over NT4 and draws it in its Field3D. This process only
  // solves physics.
  config.SetHeadlessRendering(true);

  std::cout << "[mars-sim] world: " << worldFile << "\n"
            << "[mars-sim] iterations: "
            << (iterations ? std::to_string(iterations) : "unbounded")
            << (paused ? " (paused)" : " (running)") << std::endl;

  gz::sim::Server server(config);

  if (!server.Run(/*blocking=*/true, iterations, paused))
  {
    std::cerr << "[mars-sim] the server exited with an error" << std::endl;
    return EXIT_FAILURE;
  }

  std::cout << "[mars-sim] done, iterations run: "
            << server.IterationCount().value_or(0) << std::endl;
  return EXIT_SUCCESS;
}
