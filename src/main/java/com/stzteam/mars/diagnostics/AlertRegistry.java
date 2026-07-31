package com.stzteam.mars.diagnostics;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A centralized registry of the most recently reported {@link ActionStatus} for every
 * MARS subsystem. Gives dashboards, the GCS app, or a pre-match checklist a single place
 * to query "what's currently wrong on the robot" instead of polling each subsystem
 * individually.
 * <p>
 * Can be globally disabled via {@link #setEnabled(boolean)} to skip the bookkeeping
 * entirely (e.g. for competition, if the extra map write per subsystem per loop matters).
 */
public class AlertRegistry{

    private static final AlertRegistry INSTANCE = new AlertRegistry();
    private static volatile boolean enabled = true;

    private final Map<String, ActionStatus> latestStatus = new ConcurrentHashMap<>();

    private AlertRegistry() {}

    public static AlertRegistry getInstance() {
        return INSTANCE;
    }

    /**
     * Globally enables or disables the registry. When disabled, {@link #report}
     * becomes a no-op and existing entries are left untouched (not cleared).
     *
     * @param value true to enable reporting, false to disable it.
     */
    public static void setEnabled(boolean value) {
        enabled = value;
    }

    public static boolean isEnabled() {
        return enabled;
    }

    /**
     * A single entry pairing a subsystem's name with its most recently reported status.
     */
    public record SubsystemAlert(String subsystemName, ActionStatus status) {}

    /**
     * Reports the latest status for a given subsystem. Intended to be called once per
     * loop from {@link com.stzteam.mars.models.singlemodule.ModularSubsystem}. No-op if
     * the registry is disabled or the status is null.
     *
     * @param subsystemName The reporting subsystem's name.
     * @param status        Its latest evaluated status.
     */
    public void report(String subsystemName, ActionStatus status) {
        if (!enabled || status == null) return;
        latestStatus.put(subsystemName, status);
    }

    /**
     * Returns every currently registered status that is NOT nominal (i.e. anything with
     * severity above {@link StatusColorCode.Severity#OK}). This is what a dashboard or
     * pre-match checklist should display.
     *
     * @return A list of active (non-nominal) alerts across all reporting subsystems.
     */
    public List<SubsystemAlert> getActiveAlerts() {
        List<SubsystemAlert> alerts = new ArrayList<>();
        for (Map.Entry<String, ActionStatus> entry : latestStatus.entrySet()) {
            if (entry.getValue().code.getSeverity() != StatusColorCode.Severity.OK) {
                alerts.add(new SubsystemAlert(entry.getKey(), entry.getValue()));
            }
        }
        return alerts;
    }

    /**
     * Returns true if any subsystem currently has a CRITICAL status. Useful as a quick
     * gate before enabling for a match.
     */
    public boolean hasCriticalAlerts() {
        for (ActionStatus status : latestStatus.values()) {
            if (status.isCritical()) return true;
        }
        return false;
    }

    /**
     * Returns the full raw map of subsystem name -> latest status, including nominal ones.
     */
    public Map<String, ActionStatus> getAllStatuses() {
        return latestStatus;
    }

    /**
     * Clears all registered statuses. Useful when resetting between test sessions.
     */
    public void clear() {
        latestStatus.clear();
    }
}