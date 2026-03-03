package com.stzteam.mars.test;


import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.Subsystem;

import java.util.function.BooleanSupplier;
import java.util.function.DoubleSupplier;

import com.stzteam.mars.models.singlemodule.ModularSubsystem;
import com.stzteam.mars.requests.Request;
import com.stzteam.mars.utils.TerminalGCS;

public abstract class TestRoutine {

    public abstract Command getRoutineCommand();

    protected Command waitFor(BooleanSupplier condition, double timeoutSeconds) {
        return Commands.waitUntil(condition).withTimeout(timeoutSeconds);
    }

    protected DoubleSupplier calculateError(double target, double position){
        return ()-> Math.abs(target - position);

    }

    protected Command run(Runnable action, Subsystem... requirements){
        return Commands.runOnce(action, requirements);
    }

    @SuppressWarnings({ "rawtypes", "unchecked" })
    protected Command run(Request request, ModularSubsystem requirements){
        return Commands.runOnce(()->requirements.setRequest(request), requirements);
    }

    protected Command delay(double seconds) {
        return Commands.waitSeconds(seconds);
    }

    protected Command assertLessThan(DoubleSupplier valueSupplier, double max, String message) {
        return Commands.runOnce(() -> {
            double value = valueSupplier.getAsDouble();
            if (value >= max) {
                TerminalGCS.logError("Tests", "FAIL: " + message + " | Value: " + value + " >= " + max);
            } else {
                TerminalGCS.logInfo("Tests", "PASS: Check < " + max);
            }
        });
    }

    protected Command assertGreaterThan(DoubleSupplier valueSupplier, double min, String message) {
        return Commands.runOnce(() -> {
            double value = valueSupplier.getAsDouble();
            if (value <= min) {
                TerminalGCS.logError("Tests", "FAIL: " + message + " | Value: " + value + " <= " + min);
            } else {
                TerminalGCS.logInfo("Tests", "PASS: Check > " + min);
            }
        });
    }

    protected Command assertTrue(BooleanSupplier condition, String message) {
        return Commands.runOnce(() -> {
            if (!condition.getAsBoolean()) {
                TerminalGCS.logError("Tests", "FAIL: " + message);
            } else {
                TerminalGCS.logInfo("Tests", "PASS: Condition fullfiled");
            }
        });
    }
}
