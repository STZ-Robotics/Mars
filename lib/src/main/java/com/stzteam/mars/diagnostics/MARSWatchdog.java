package com.stzteam.mars.diagnostics;

import edu.wpi.first.wpilibj.Timer;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

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

    /**
     * Minimum time between two overrun warnings for the same subsystem.
     * <p>
     * An overrun is rarely a one-off: a subsystem that takes too long usually does so every
     * loop. Warning each time sent 50 messages a second per subsystem to the Driver Station
     * (with the FMS attached too), and printing them is slow enough on a roboRIO to cause
     * more overruns. One warning per interval, counting the ones it stands for, says the
     * same thing.
     */
    private static volatile double warningIntervalSeconds = 5.0;

    /** Per subsystem: when it last warned, and how many overruns went unreported since. */
    private static final Map<String, double[]> warnings = new ConcurrentHashMap<>();

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
     * Sets the minimum time between two overrun warnings for the same subsystem.
     * Overruns in between are counted and reported with the next warning.
     *
     * @param seconds Interval in seconds (0 warns on every overrun).
     */
    public static void setWarningIntervalSeconds(double seconds) {
        warningIntervalSeconds = seconds;
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
            // [last warning time, overruns not reported since]
            double[] state = warnings.computeIfAbsent(subsystemName, k -> new double[] {Double.NEGATIVE_INFINITY, 0});
            double now = start + elapsedSeconds;
            if (now - state[0] < warningIntervalSeconds) {
                state[1]++;
                return;
            }
            String unreported = state[1] > 0
                ? String.format(" (+%d more since the last warning)", (long) state[1])
                : "";
            state[0] = now;
            state[1] = 0;
            GCSConsole.logWarning(subsystemName, String.format(
                "Loop overrun: %.2fms (threshold %.2fms)%s",
                elapsedSeconds * 1000.0, thresholdSeconds * 1000.0, unreported));
        }
    }
}