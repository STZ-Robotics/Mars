package com.stzteam.mars.operator;

import java.util.function.DoubleSupplier;
import edu.wpi.first.wpilibj2.command.button.Trigger;

/**
 * A utility class containing standardized data records for generic controller inputs.
 * These records group related buttons and axes positionally, allowing the robot's 
 * binding logic to remain completely agnostic to the specific brand or model of the gamepad.
 */
public class ControllerContainer {

    /**
     * Represents a 2D joystick/thumbstick.
     *
     * @param x A supplier for the X-axis value (horizontal movement).
     * @param y A supplier for the Y-axis value (vertical movement).
     */
    public static record Stick(DoubleSupplier x, DoubleSupplier y) {}

    /**
     * Represents the directional pad (D-Pad) or POV hat.
     *
     * @param up    Trigger activated when the top D-Pad button is pressed.
     * @param down  Trigger activated when the bottom D-Pad button is pressed.
     * @param left  Trigger activated when the left D-Pad button is pressed.
     * @param right Trigger activated when the right D-Pad button is pressed.
     */
    public static record DPadTriggers(Trigger up, Trigger down, Trigger left, Trigger right) {}

    /**
     * Represents the top shoulder buttons (L1/R1 or LB/RB).
     *
     * @param left  Trigger for the left bumper.
     * @param right Trigger for the right bumper.
     */
    public static record Bumpers(Trigger left, Trigger right) {}

    /**
     * Represents the primary action face buttons mapped by their physical position.
     * (e.g., Bottom = Cross/A, Right = Circle/B, Left = Square/X, Top = Triangle/Y).
     *
     * @param bottom Trigger for the bottom face button.
     * @param right  Trigger for the right face button.
     * @param left   Trigger for the left face button.
     * @param top    Trigger for the top face button.
     */
    public record ActionButtons(Trigger bottom, Trigger right, Trigger left, Trigger top) {}
    
    /**
     * Represents the central system or menu buttons.
     *
     * @param back  Trigger for the Back/Share/Create button.
     * @param start Trigger for the Start/Options button.
     */
    public static record SpecialTriggers(Trigger back, Trigger start){}

    /**
     * Represents the analog triggers treated as digital buttons (pressed or not pressed).
     *
     * @param left  Trigger for the left analog trigger (L2/LT).
     * @param right Trigger for the right analog trigger (R2/RT).
     */
    public record AnalogTriggers(Trigger left, Trigger right) {}

    /**
     * Represents the raw continuous values of the analog triggers.
     *
     * @param left  A supplier for the left trigger axis value (0.0 to 1.0).
     * @param right A supplier for the right trigger axis value (0.0 to 1.0).
     */
    public record AnalogAxis(DoubleSupplier left, DoubleSupplier right) {}

}