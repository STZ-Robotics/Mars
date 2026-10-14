// The world: the simulation's 3D window.
//
// It is Gazebo's GUI, with our panel configuration. It is NOT a viewer of our
// own and that is deliberate: 3D scene, world tree, component inspector,
// transform control, lights, physics statistics and playback control already
// exist there, done and tested. Redoing them with three.js would give a pretty
// model without physics --- exactly what AdvantageScope already does and what
// was NOT wanted.
//
// # Why it is a binary of its own and not `gz sim -g`
//
// The `gz` CLI is a Ruby script, and Ruby does not come in the Windows conda
// environment. `runGui` is documented exactly for this: "Used when running
// without gz-tools". It also lets us pin our panel configuration without
// depending on whatever the user has in ~/.gz/sim/gui.config.
//
// # How it finds the world
//
// It does not load it: it CONNECTS. gz-sim separates server and GUI, and the
// GUI discovers over gz-transport the server that is already running --- our
// mars-sim-server. That is why the server has to start first, and why moving
// the robot from the robot code shows up here without this window knowing
// anything about WPILib.
//
// Usage:
//   mars-sim-gui [path/gui.config]

#include <cstdlib>
#include <iostream>
#include <string>

#include <gz/common/Console.hh>
#include <gz/sim/gui/Gui.hh>

int main(int argc, char **argv)
{
  if (const char *v = std::getenv("MARS_VERBOSE"))
    gz::common::Console::SetVerbosity(std::atoi(v));

  // Without an explicit configuration, gz-sim uses GZ_HOMEDIR/.gz/sim/gui.config,
  // which is the user's and could hold anything. We prefer ours.
  const std::string config = (argc > 1) ? argv[1] : "gui/mars.config";

  std::cout << "[mars-gui] panel layout: " << config << "\n"
            << "[mars-gui] connecting to the simulation server..." << std::endl;

  // The render engine is left as nullptr so the config's one applies (ogre2).
  // Forcing it here would prevent falling back to ogre on machines whose
  // driver cannot handle ogre2, which happens on an FRC team's borrowed laptops.
  return gz::sim::gui::runGui(argc, argv, config.c_str());
}
