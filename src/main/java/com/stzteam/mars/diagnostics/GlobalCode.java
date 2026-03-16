package com.stzteam.mars.diagnostics;

import edu.wpi.first.wpilibj.util.Color;

/**
 * Standard global diagnostic codes used across the MARS framework.
 * These act as the default states for subsystems and commands.
 */
public enum GlobalCode implements StatusCode {
    /** The system is fully operational and healthy. */
    NOMINAL(Severity.OK, DiagnosticPattern.solid(Color.kGreen)),
    
    /** The system is currently executing an action or in a transient state. */
    WORKING(Severity.WARNING, DiagnosticPattern.blinkSlow(Color.kYellow)),
    
    /** A communication or sensor timeout has occurred. */
    TIMEOUT(Severity.ERROR, DiagnosticPattern.blinkFast(Color.kOrange)),
    
    /** A critical hardware failure was detected (e.g., motor controller disconnected). */
    HARDWARE_FAULT(Severity.CRITICAL, DiagnosticPattern.blinkFast(Color.kRed));

    private final Severity severity;
    private final DiagnosticPattern pattern;

    /**
     * Constructs a global diagnostic code.
     *
     * @param severity The severity level of this state.
     * @param pattern  The LED visual pattern to display for this state.
     */
    GlobalCode(Severity severity, DiagnosticPattern pattern) {
        this.severity = severity;
        this.pattern = pattern;
    }

    @Override 
    public Severity getSeverity() { 
        return severity; 
    }

    @Override 
    public String getName() { 
        return this.name(); 
    }

    @Override 
    public DiagnosticPattern getVisualPattern() { 
        return pattern; 
    }
}