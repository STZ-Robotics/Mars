package com.stzteam.mars.diagnostics;

public record DiagnosticPayload(
    String name,
    String message,
    String colorHex
){}
