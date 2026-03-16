package com.stzteam.mars.models.singlemodule;

/**
 * The hardware abstraction layer interface for MARS subsystems.
 * Implementations of this interface (Real, Sim, or Fallback) serve as the "Actor" 
 * that physically interacts with the robot's hardware.
 *
 * @param <T> The {@link Data} structure this IO layer populates.
 */
@FunctionalInterface
public interface IO<T extends Data<T>> {

    /**
     * Reads values from the physical or simulated hardware and populates the provided data object.
     * This is called iteratively at the start of the subsystem's periodic loop.
     *
     * @param inputs The data object to update with fresh hardware readings.
     */
    void updateInputs(T inputs);

    /**
     * Determines if this IO implementation is a "dummy" or fallback layer.
     * Useful for safely bypassing logic if hardware is missing or disabled, 
     * preventing unnecessary NullPointerExceptions.
     *
     * @return True if this is a fallback IO, false if it is active (real or sim).
     */
    default boolean isFallback() {
        return false;
    }
}