package com.stzteam.mars.builder;

/**
 * Manages the global execution state of the robot within the MARS framework.
 * This class is critical for determining whether the code is running on actual hardware, 
 * in a physics simulation, or replaying historical log data.
 */
public class Environment {

    /**
     * Defines the current execution context of the robot program.
     */
    public static enum RunMode {
        /** Running on the roboRIO with actual physical hardware (motors, sensors, etc.). */
        REAL,
        /** Running on a development machine using simulated physics and virtual IO. */
        SIM,
        /** Replaying historical data from a log file (no active hardware or physics). */
        REPLAY
    }
    
    private static RunMode currentMode = RunMode.REAL;

    /**
     * Sets the global execution mode of the robot.
     * This should typically be called once during robot initialization.
     *
     * @param mode The {@link RunMode} to set.
     */
    public static void setMode(RunMode mode) {
        currentMode = mode;
    }

    /**
     * Gets the current global execution mode.
     * Subsystems and factories use this to determine which IO implementation to load.
     *
     * @return The current {@link RunMode}.
     */
    public static RunMode getMode() {
        return currentMode;
    }
    
}