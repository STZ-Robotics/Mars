package com.stzteam.mars.builder;

import java.util.function.Supplier;

/**
 * A utility class responsible for Dependency Injection of IO layers.
 * It evaluates the global {@link Environment} to instantiate the appropriate 
 * hardware, simulation, or fallback implementation for a given subsystem.
 */
public class Injector {

    /**
     * Safely instantiates an IO implementation based on the robot's current environment.
     * If the module is disabled, it immediately injects the fallback (dummy) implementation 
     * to prevent null pointer exceptions and save processing power.
     *
     * @param <T>              The type of the IO interface being injected.
     * @param isEnabled        Flag indicating if this specific module/subsystem should be active.
     * @param fallbackSupplier A supplier providing a dummy/empty IO implementation (used if disabled).
     * @param realSupplier     A supplier providing the actual hardware IO (used in {@link Environment.RunMode#REAL}).
     * @param simSupplier      A supplier providing the simulated or replayed IO (used in SIM or REPLAY modes).
     * @return The instantiated IO object matching the current configuration and environment.
     */
    public static <T> T createIO(
            boolean isEnabled, 
            Supplier<T> fallbackSupplier, 
            Supplier<T> realSupplier, 
            Supplier<T> simSupplier) {
        
        if (!isEnabled) {
            return fallbackSupplier.get();
        }

        switch (Environment.getMode()) {
            case REAL: 
                return realSupplier.get();
            case SIM:
            case REPLAY:
            default:   
                return simSupplier.get();
        }
    }
}