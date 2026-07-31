package com.stzteam.mars.test;

import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.Commands;
import edu.wpi.first.wpilibj2.command.Subsystem;

import java.util.function.BooleanSupplier;
import java.util.function.DoubleSupplier;

import com.stzteam.mars.models.singlemodule.Data;
import com.stzteam.mars.models.singlemodule.IO;
import com.stzteam.mars.models.singlemodule.ModularSubsystem;
import com.stzteam.mars.requests.Request;
import com.stzteam.mars.utils.GCSConsole;

/**
 * The abstract base class for defining hardware testing sequences in the MARS framework.
 * Provides a rich suite of WPILib Command factories (assertions, delays, waits) allowing 
 * developers to build robust, sequential pit-test routines to verify hardware functionality.
 */
public abstract class TestRoutine {

    /**
     * Defines the complete sequence of commands to execute for this specific test.
     *
     * @return A composed WPILib {@link Command} representing the full test routine.
     */
    public abstract Command getRoutineCommand();

    /**
     * Creates a command that halts the test sequence until a specific condition is met,
     * or until the timeout is reached.
     *
     * @param condition      The boolean condition to wait for.
     * @param timeoutSeconds The maximum time to wait before moving on (to prevent hanging).
     * @return A WPILib {@link Command}.
     */
    protected Command waitFor(BooleanSupplier condition, double timeoutSeconds) {
        return Commands.waitUntil(condition).withTimeout(timeoutSeconds);
    }

    /**
     * A helper method to create a supplier that continuously calculates the absolute error 
     * between a target setpoint and a current position (useful for PID verification).
     *
     * @param target   The desired setpoint.
     * @param position The current measured position.
     * @return A {@link DoubleSupplier} returning the absolute error.
     */
    protected DoubleSupplier calculateError(double target, double position){
        return ()-> Math.abs(target - position);
    }

    /**
     * Wraps a standard runnable action into an instantaneous WPILib Command.
     *
     * @param action       The logic to execute.
     * @param requirements The subsystems required by this action.
     * @return A WPILib {@link Command}.
     */
    protected Command run(Runnable action, Subsystem... requirements){
        return Commands.runOnce(action, requirements);
    }

        /**
     * Wraps a MARS {@link Request} into an instantaneous WPILib Command, injecting it 
     * directly into the specified {@link ModularSubsystem}. Fully type-safe: the compiler
     * enforces that the request matches the subsystem's Data/IO types.
     *
     * @param <D>          The subsystem's data type.
     * @param <A>          The subsystem's IO type.
     * @param request      The state/action request to apply.
     * @param requirements The subsystem that will execute the request.
     * @return A WPILib {@link Command}.
     */
    protected <D extends Data<D>, A extends IO<D>> Command run(Request<D, A> request, ModularSubsystem<D, A> requirements) {
        return Commands.runOnce(() -> requirements.setRequest(request), requirements);
    }

    /**
     * Pauses the test execution for a specified duration.
     *
     * @param seconds The amount of time to wait.
     * @return A WPILib {@link Command}.
     */
    protected Command delay(double seconds) {
        return Commands.waitSeconds(seconds);
    }

    /**
     * Verifies that a given value is strictly less than a maximum threshold.
     * Logs the result directly to the terminal using {@link TerminalGCS}.
     *
     * @param valueSupplier A lambda providing the current value to check.
     * @param max           The maximum allowed value.
     * @param message       The contextual message to log if the assertion fails.
     * @return A WPILib {@link Command}.
     */
    protected Command assertLessThan(DoubleSupplier valueSupplier, double max, String message) {
        return Commands.runOnce(() -> {
            double value = valueSupplier.getAsDouble();
            if (value >= max) {
                GCSConsole.logError("Tests", "FAIL: " + message + " | Value: " + value + " >= " + max);
            } else {
                GCSConsole.logInfo("Tests", "PASS: Check < " + max);
            }
        });
    }

    /**
     * Verifies that a given value is strictly greater than a minimum threshold.
     * Logs the result directly to the terminal using {@link TerminalGCS}.
     *
     * @param valueSupplier A lambda providing the current value to check.
     * @param min           The minimum allowed value.
     * @param message       The contextual message to log if the assertion fails.
     * @return A WPILib {@link Command}.
     */
    protected Command assertGreaterThan(DoubleSupplier valueSupplier, double min, String message) {
        return Commands.runOnce(() -> {
            double value = valueSupplier.getAsDouble();
            if (value <= min) {
                GCSConsole.logError("Tests", "FAIL: " + message + " | Value: " + value + " <= " + min);
            } else {
                GCSConsole.logInfo("Tests", "PASS: Check > " + min);
            }
        });
    }

    /**
     * Verifies that a given boolean condition evaluates to true.
     * Logs the result directly to the terminal using {@link TerminalGCS}.
     *
     * @param condition A lambda providing the boolean condition to check.
     * @param message   The contextual message to log if the assertion fails.
     * @return A WPILib {@link Command}.
     */
    protected Command assertTrue(BooleanSupplier condition, String message) {
        return Commands.runOnce(() -> {
            if (!condition.getAsBoolean()) {
                GCSConsole.logError("Tests", "FAIL: " + message);
            } else {
                GCSConsole.logInfo("Tests", "PASS: Condition fullfiled");
            }
        });
    }
}