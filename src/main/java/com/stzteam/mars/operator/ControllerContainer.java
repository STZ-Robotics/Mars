package com.stzteam.mars.operator;

import java.util.function.DoubleSupplier;

import edu.wpi.first.wpilibj2.command.button.Trigger;

public class ControllerContainer {

    public static record Stick(DoubleSupplier x, DoubleSupplier y) {}

    public static record DPadTriggers(Trigger up, Trigger down, Trigger left, Trigger right) {}

    public static record Bumpers(Trigger left, Trigger right) {}

    public record ActionButtons(Trigger bottom, Trigger right, Trigger left, Trigger top) {}
    
    public static record SpecialTriggers(Trigger back, Trigger start){}

    public record AnalogTriggers(Trigger left, Trigger right) {}

    public record AnalogAxis(DoubleSupplier left, DoubleSupplier rigth) {}

}