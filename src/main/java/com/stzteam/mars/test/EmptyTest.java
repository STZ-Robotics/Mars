package com.stzteam.mars.test;

import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;

@MARSTest(name = "NONE")
public class EmptyTest extends TestRoutine{
    public EmptyTest() {}

    @Override
    public Command getRoutineCommand(){
        return Commands.none();
    }
}
