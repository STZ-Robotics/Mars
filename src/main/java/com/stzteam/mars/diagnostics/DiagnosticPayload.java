package com.stzteam.mars.diagnostics;

/**
 * A lightweight data carrier representing an evaluated diagnostic state.
 * This record is optimized for serialization and sending diagnostic telemetry 
 * to network dashboards (like AdvantageScope or Shuffleboard).
 *
 * @param name     The identifier of the diagnostic code (e.g., "NOMINAL").
 * @param message  A descriptive message detailing the specific status or error.
 * @param colorHex The evaluated HEX color string to be displayed on the dashboard or LEDs.
 */
public record DiagnosticPayload(
    String name,
    String message,
    String colorHex
) {}