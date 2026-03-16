package com.stzteam.mars.diagnostics;

/**
 * Represents a generic diagnostic status code within the MARS framework.
 * This interface allows custom subsystems to define their own specific 
 * status codes while maintaining a unified diagnostic pipeline.
 */
public interface StatusCode {
    
    /**
     * Defines the severity level of a diagnostic status.
     * Used to determine priority when reporting errors or updating LEDs.
     */
    enum Severity {
        /** System is functioning nominally. */
        OK,
        /** System is functioning but requires attention (e.g., high temperature). */
        WARNING,
        /** System encountered a recoverable error (e.g., sensor timeout). */
        ERROR,
        /** System encountered a fatal or unrecoverable hardware fault. */
        CRITICAL
    }

    /**
     * Gets the severity level associated with this status code.
     * * @return The {@link Severity} of the status.
     */
    Severity getSeverity();

    /**
     * Gets the standard name or identifier of this status code.
     * * @return A string representing the name of the code.
     */
    String getName();

    /**
     * Gets the visual LED pattern associated with this status code.
     * * @return The {@link DiagnosticPattern} to be displayed.
     */
    DiagnosticPattern getVisualPattern();
}