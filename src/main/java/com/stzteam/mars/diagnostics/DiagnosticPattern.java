package com.stzteam.mars.diagnostics;

import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj.util.Color;

/**
 * Defines a visual behavior pattern for LEDs or dashboard indicators.
 * Patterns are evaluated dynamically based on the WPILib FPGA timestamp.
 */
public class DiagnosticPattern {

    /**
     * Available animation styles for the diagnostic pattern.
     */
    public enum Style {
        /** Constant color, no animation. */
        SOLID,
        /** Fast on/off blinking (useful for errors). */
        BLINK_FAST,
        /** Slow on/off blinking (useful for working states). */
        BLINK_SLOW,
        /** Very rapid flashing. */
        STROBE,
        /** Smooth transition between the base color and black. */
        BREATHING
    }

    private final Color baseColor;
    private final Style style;

    /**
     * Creates a new diagnostic pattern.
     *
     * @param baseColor The primary color of the pattern.
     * @param style     The animation style to apply.
     */
    public DiagnosticPattern(Color baseColor, Style style) {
        this.baseColor = baseColor;
        this.style = style;
    }

    /**
     * Creates a static, solid color pattern.
     *
     * @param color The color to display.
     * @return A new {@link DiagnosticPattern} instance.
     */
    public static DiagnosticPattern solid(Color color) { 
        return new DiagnosticPattern(color, Style.SOLID); 
    }
    
    /**
     * Creates a fast-blinking pattern.
     *
     * @param color The color to blink.
     * @return A new {@link DiagnosticPattern} instance.
     */
    public static DiagnosticPattern blinkFast(Color color) { 
        return new DiagnosticPattern(color, Style.BLINK_FAST); 
    }
    
    /**
     * Creates a slow-blinking pattern.
     *
     * @param color The color to blink.
     * @return A new {@link DiagnosticPattern} instance.
     */
    public static DiagnosticPattern blinkSlow(Color color) { 
        return new DiagnosticPattern(color, Style.BLINK_SLOW); 
    }

    /**
     * Creates a strobe (rapid flash) pattern.
     *
     * @param color The color to strobe.
     * @return A new {@link DiagnosticPattern} instance.
     */
    public static DiagnosticPattern strobe(Color color) {
        return new DiagnosticPattern(color, Style.STROBE);
    }

    /**
     * Creates a smooth breathing (fade in/out) pattern.
     *
     * @param color The peak color of the breathing animation.
     * @return A new {@link DiagnosticPattern} instance.
     */
    public static DiagnosticPattern breathing(Color color) {
        return new DiagnosticPattern(color, Style.BREATHING);
    }

    /**
     * Evaluates the current color of the pattern based on the WPILib FPGA timestamp.
     * This should be called periodically (e.g., in a subsystem's periodic block) 
     * to update LEDs or dashboard widgets dynamically.
     *
     * @return A HEX string representation of the currently evaluated color (e.g., "#FF0000").
     */
    public String evaluateHex() {
        double time = Timer.getFPGATimestamp();
        Color currentColor;

        switch (style) {
            case BLINK_FAST:
                currentColor = (time % 0.25 < 0.125) ? baseColor : Color.kBlack;
                break;
                
            case BLINK_SLOW:
                currentColor = (time % 1.0 < 0.5) ? baseColor : Color.kBlack;
                break;

            case STROBE:
                currentColor = (time % 0.1 < 0.05) ? baseColor : Color.kBlack;
                break;
                
            case BREATHING:
                double wave = (Math.sin(time * Math.PI) + 1.0) / 2.0;
                double intensity = 0.1 + (wave * 0.9); 
                
                currentColor = new Color(
                    baseColor.red * intensity, 
                    baseColor.green * intensity, 
                    baseColor.blue * intensity
                );
                break;
                
            case SOLID:
            default:
                currentColor = baseColor;
                break;
        }

        return currentColor.toHexString();
    }
}