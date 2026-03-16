package com.stzteam.mars.test;

import com.stzteam.mars.utils.TerminalGCS;

import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;

/**
 * A utility class responsible for scheduling and executing {@link TestRoutine} instances.
 * It wraps the test routine's command sequence with comprehensive logging hooks 
 * (start, interrupt, and finish events) and configures the command to run even 
 * when the robot is disabled (e.g., during FRC Test Mode).
 */
public class TestScheduler {
    
    /**
     * Packages a test routine into a deployable WPILib command with lifecycle logging.
     * Reads the {@link MARSTest} annotation to label the test cleanly in the terminal.
     *
     * @param test The {@link TestRoutine} to execute.
     * @return A configured WPILib {@link Command} ready to be scheduled.
     */
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