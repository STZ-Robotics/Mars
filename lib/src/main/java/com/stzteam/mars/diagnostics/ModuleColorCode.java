package com.stzteam.mars.diagnostics;

import edu.wpi.first.wpilibj.util.Color;

/**
 * A universal container for diagnostic codes.
 * Removes the need to create an Enum per subsystem.
 */
public record ModuleColorCode(
    String name,
    Severity severity,
    DiagnosticPattern visualPattern,
    String messageTemplate
) implements StatusColorCode {

    @Override public Severity getSeverity() { return severity; }
    @Override public String getName() { return name; }
    @Override public DiagnosticPattern getVisualPattern() { return visualPattern; }
    @Override public String getMessageTemplate() { return messageTemplate; }

    /**
     * Factory method to quickly create a solid color code.
     */
    public static ModuleColorCode solid(String name, Severity severity, Color color, String template) {
        return new ModuleColorCode(name, severity, DiagnosticPattern.solid(color), template);
    }
}