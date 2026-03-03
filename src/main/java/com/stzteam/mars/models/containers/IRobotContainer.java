package com.stzteam.mars.models.containers;

import com.stzteam.mars.test.TestRoutine;

import edu.wpi.first.wpilibj2.command.Command;

public interface IRobotContainer {
    void updateNodes();
    Command getAutonomousCommand();
    TestRoutine getTestRoutine();
}
