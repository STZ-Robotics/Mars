package com.stzteam.mars.builder;

import java.util.function.Supplier;

import com.stzteam.mars.services.nodes.FallbackNode;
import com.stzteam.mars.services.nodes.Node;
import com.stzteam.mars.services.nodes.NodeMessage;
import com.stzteam.mars.utils.GCSConsole;

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
                try {
                    return realSupplier.get();
                } catch (Exception e) {
                    GCSConsole.logError("Injector", "Failed to init REAL IO, falling back: " + e.getMessage());
                    return fallbackSupplier.get();
                }
            case SIM:
            case REPLAY:
            default:   
                return simSupplier.get();
        }
    }

     /**
     * A specialized version of createIO for instantiating Nodes.
     * It checks if the node is enabled and either returns a real node or a FallbackNode.
     *
     * @param <M>              The type of the Node's message payload (must extend NodeMessage).
     * @param isEnabled        Flag indicating if this specific node should be active.
     * @param realNodeSupplier A supplier providing the actual Node implementation (used if enabled).
     * @return The instantiated Node, either real or fallback based on the isEnabled flag.
     */
    public static <M extends NodeMessage<M>> Node<M> createNode(boolean isEnabled, Supplier<Node<M>> realNodeSupplier) {
        if (!isEnabled) {
            return new FallbackNode<>();
        }
        return realNodeSupplier.get();
    }
}