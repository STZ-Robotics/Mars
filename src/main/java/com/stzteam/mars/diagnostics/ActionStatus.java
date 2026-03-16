package com.stzteam.mars.diagnostics;

import edu.wpi.first.wpilibj.Timer;

/**
 * Represents a snapshot of an action or subsystem's state at a specific point in time.
 * Encapsulates the status code, a custom message, and the exact FPGA timestamp of creation.
 */
public class ActionStatus {
    
    /** The core status/diagnostic code. */
    public final StatusCode code;
    /** A descriptive message providing context for the status. */
    public final String message;
    /** The WPILib FPGA timestamp when this status was generated. */
    public final double timestamp;

    /**
     * Internal constructor.
     */
    private ActionStatus(StatusCode code, String message) {
        this.code = code;
        this.message = message;
        this.timestamp = Timer.getFPGATimestamp();
    }

    /**
     * Creates an ActionStatus with a specific code and custom message.
     *
     * @param code    The diagnostic status code.
     * @param message A detailed message explaining the status.
     * @return A new {@link ActionStatus} snapshot.
     */
    public static ActionStatus of(StatusCode code, String message) {
        return new ActionStatus(code, message);
    }

    /**
     * Creates an ActionStatus using the default name of the provided code.
     *
     * @param code The diagnostic status code.
     * @return A new {@link ActionStatus} snapshot.
     */
    public static ActionStatus of(StatusCode code) {
        return new ActionStatus(code, code.getName());
    }

    /**
     * Quick factory method for a generic nominal/OK state.
     *
     * @return An {@link ActionStatus} representing {@link GlobalCode#NOMINAL}.
     */
    public static ActionStatus ok() { 
        return new ActionStatus(GlobalCode.NOMINAL, "OK"); 
    }
    
    /**
     * Quick factory method for a warning state with a custom message.
     *
     * @param msg The warning message.
     * @return An {@link ActionStatus} representing {@link GlobalCode#WORKING}.
     */
    public static ActionStatus warning(String msg) { 
        return new ActionStatus(GlobalCode.WORKING, msg); 
    }
    
    /**
     * Quick factory method for an error state with a custom message.
     *
     * @param msg The error message detailing the fault.
     * @return An {@link ActionStatus} representing {@link GlobalCode#HARDWARE_FAULT}.
     */
    public static ActionStatus error(String msg) { 
        return new ActionStatus(GlobalCode.HARDWARE_FAULT, msg); 
    }

    /**
     * Checks if this status represents an OK/Nominal state.
     * Useful for command sequences that wait for a subsystem to be ready.
     *
     * @return true if the severity is OK, false otherwise.
     */
    public boolean isDone() {
        return this.code.getSeverity() == StatusCode.Severity.OK;
    }
    
    /**
     * Checks if this status represents a critical hardware fault.
     *
     * @return true if the severity is CRITICAL, false otherwise.
     */
    public boolean isCritical() {
        return this.code.getSeverity() == StatusCode.Severity.CRITICAL;
    }

    /**
     * Packages the current status into a serializable payload for telemetry.
     * Evaluates the visual pattern dynamically based on the current timestamp.
     *
     * @return A {@link DiagnosticPayload} ready to be sent to the dashboard.
     */
    public DiagnosticPayload getPayload() {
        return new DiagnosticPayload(
            this.code.getName(),
            this.message,
            this.code.getVisualPattern().evaluateHex()
        );
    }
}