package com.stzteam.mars.diagnostics;

public interface StatusCode {
    
    enum Severity {
        OK,
        WARNING,
        ERROR,
        CRITICAL
    }

    Severity getSeverity();
    String getName();
    DiagnosticPattern getVisualPattern();
}
