package com.stzteam.mars.diagnostics;

import edu.wpi.first.wpilibj.util.Color;

/**
 * Un contenedor universal para códigos de diagnóstico.
 * Elimina la necesidad de crear un Enum por cada subsistema.
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
     * Factory method para crear un código de color sólido rápidamente.
     */
    public static ModuleColorCode solid(String name, Severity severity, Color color, String template) {
        return new ModuleColorCode(name, severity, DiagnosticPattern.solid(color), template);
    }
}