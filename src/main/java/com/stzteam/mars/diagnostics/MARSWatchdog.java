package com.stzteam.mars.diagnostics;

import edu.wpi.first.wpilibj.Timer;

import com.stzteam.forgemini.io.NetworkIO;
import com.stzteam.mars.utils.GCSConsole;

/**
 * A lightweight loop-overrun watchdog for MARS subsystems.
 * Measures how long each subsystem's periodic block takes to execute and
 * warns via {@link GCSConsole} if it exceeds a configurable threshold.
 * <p>
 * Can be globally disabled (e.g. for competition, to avoid the extra
 * timestamp calls) via {@link #setEnabled(boolean)}.
 */
public class MARSWatchdog{

    private static volatile boolean enabled = true;
    private static volatile boolean record_enabled = true;
    private static volatile double thresholdSeconds = 0.005; // 5ms default

    private MARSWatchdog() {}

    /**
     * Globally enables or disables the watchdog. When disabled, {@link #monitor}
     * simply runs the logic with no timing overhead.
     *
     * @param value true to enable monitoring, false to disable it entirely.
     */
    public static void setEnabled(boolean value) {
        enabled = value;
    }

    public static void setTelemetryEnabled(boolean value){
        record_enabled = value;
    }

    public static boolean isTelemetryEnabled(){
        return record_enabled;
    }

    public static boolean isEnabled() {
        return enabled;
    }

    /**
     * Sets the loop-overrun threshold. Any periodic block exceeding this duration
     * triggers a warning.
     *
     * @param seconds Threshold in seconds (e.g. 0.005 for 5ms).
     */
    public static void setThresholdSeconds(double seconds) {
        thresholdSeconds = seconds;
    }

    public static double getThresholdSeconds() {
        return thresholdSeconds;
    }

    /**
     * Measures the execution time of a subsystem's periodic logic and warns if it
     * exceeds the configured threshold. No-op wrapper (zero overhead) if disabled.
     *
     * @param subsystemName The name of the subsystem being measured (for logging).
     * @param logic         The periodic logic to execute and measure.
     */
    public static void monitor(String subsystemName, Runnable logic) {
        if (!enabled) {
            logic.run();
            return;
        }

        double start = Timer.getFPGATimestamp();
        logic.run();
        double elapsedSeconds = Timer.getFPGATimestamp() - start;

        if (isTelemetryEnabled()) {
            NetworkIO.set("WatchDog/ElapsedSeconds", subsystemName, elapsedSeconds);
        }

        if (elapsedSeconds > thresholdSeconds) {

            GCSConsole.logWarning(subsystemName, String.format(
                "Loop overrun: %.2fms (threshold %.2fms)",
                elapsedSeconds * 1000.0, thresholdSeconds * 1000.0));
        }
    }
}