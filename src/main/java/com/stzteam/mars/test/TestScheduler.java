package com.stzteam.mars.test;


import com.stzteam.mars.utils.TerminalGCS;

import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;

public class TestScheduler {
    
    public static Command runTest(TestRoutine test) {
        
        if (test == null) {
            TerminalGCS.logError("Tests", "TestRoutine is null!");
            return Commands.none();
        }

        String testName = test.getClass().getSimpleName();
        if (test.getClass().isAnnotationPresent(MARSTest.class)) {
            testName = test.getClass().getAnnotation(MARSTest.class).name();
        }
        final String finalName = testName;

        return test.getRoutineCommand()
            .beforeStarting(() -> {
                System.out.println("Starting test: " + finalName);
                TerminalGCS.logInfo("Tests", "RUNNING: " + finalName);
            })
            .finallyDo((interrupted) -> {
                if (interrupted) {

                    TerminalGCS.logWarning("Tests", "INTERRUPTED: " + finalName);
                } else {

                    TerminalGCS.logInfo("Tests", "FINALIZED: " + finalName);
                }
            })
            .withName("MARS-Test-" + finalName)
            .ignoringDisable(true);
    }
}
