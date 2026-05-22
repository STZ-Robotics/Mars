package com.stzteam.mars.diagnostics;

import edu.wpi.first.wpilibj.util.Color;

/**
 * Standard global diagnostic codes used across the MARS framework.
 * These act as the default states for subsystems and commands.
 */
public enum GlobalColorCode implements StatusColorCode {
    /** The system is fully operational and healthy. */
    NOMINAL(Severity.OK, DiagnosticPattern.solid(Color.kGreen), "System is nominal."),
    
    /** The system is currently executing an action or in a transient state. */
    WORKING(Severity.WARNING, DiagnosticPattern.blinkSlow(Color.kYellow), "System is working."),
    
    /** A communication or sensor timeout has occurred. */
    TIMEOUT(Severity.ERROR, DiagnosticPattern.blinkFast(Color.kOrange), "System has timed out."),
    
    /** A critical hardware failure was detected (e.g., motor controller disconnected). */
    HARDWARE_FAULT(Severity.CRITICAL, DiagnosticPattern.blinkFast(Color.kRed), "System has hardware fault.");

    private final Severity severity;
    private final DiagnosticPattern pattern;
    private final String template;

    /**
     * Constructs a global diagnostic code.
     *
     * @param severity The severity level of this state.
     * @param pattern  The LED visual pattern to display for this state.
     * @param template The message template for this state.
     */
    GlobalColorCode(Severity severity, DiagnosticPattern pattern, String template) {
        this.severity = severity;
        this.pattern = pattern;
        this.template = template;
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

    @Override
    public String getMessageTemplate() {
        return template;
    }

}