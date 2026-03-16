package com.stzteam.mars.builder;

/**
 * A generic interface for constructing complex subsystems or modules within the MARS framework.
 * Implements the Builder design pattern to assemble and configure components before 
 * they are injected into the main robot container.
 * * @param <T> The type of the module, subsystem, or IO layer being built.
 */
public interface Builder<T> {
    
    /**
     * Assembles and finalizes the configuration of the module.
     *
     * @return A fully constructed and ready-to-use instance of type {@code T}.
     */
    T buildModule();

}