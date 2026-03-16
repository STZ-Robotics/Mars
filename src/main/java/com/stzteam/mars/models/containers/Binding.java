package com.stzteam.mars.models.containers;

/**
 * A functional interface used to encapsulate controller button or trigger bindings.
 * Keeps the RobotContainer clean and modular by allowing bindings to be grouped 
 * and executed cleanly during robot initialization.
 */
@FunctionalInterface
public interface Binding {
    
    /**
     * Executes the configuration of button mappings and trigger conditions.
     */
    void bind();
}