package com.stzteam.mars.models.containers;

import com.stzteam.mars.test.TestRoutine;

import edu.wpi.first.wpilibj2.command.Command;

/**
 * The root container interface for the MARS framework.
 * Defines the standard lifecycle and structure that the main Robot class relies on
 * to fetch autonomous routines, testing sequences, and update global states.
 */
public interface IRobotContainer {
    
    /**
     * Updates global nodes, telemetry networks, or central dashboard data.
     * Typically called periodically in the robot's main loop.
     */
    void updateNodes();
    
    /**
     * Retrieves the WPILib Command to be executed during the autonomous period.
     *
     * @return The configured autonomous {@link Command}.
     */
    Command getAutonomousCommand();
    
    /**
     * Retrieves the hardware testing sequence for the robot.
     * Extremely useful for running system checks in the pit before a match.
     *
     * @return The configured {@link TestRoutine}.
     */
    TestRoutine getTestRoutine();
}