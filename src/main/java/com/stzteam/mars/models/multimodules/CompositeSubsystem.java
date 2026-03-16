package com.stzteam.mars.models.multimodules;

import com.stzteam.mars.models.SubsystemBuilder;
import com.stzteam.mars.models.singlemodule.ModularSubsystem;

/**
 * A specialized subsystem class for complex mechanisms composed of multiple smaller subsystems.
 * This is ideal for overarching systems like a Drivetrain, where the CompositeSubsystem 
 * manages the high-level kinematics and coordinates the individual underlying modules.
 *
 * @param <D> The composite data structure holding the overall subsystem's state.
 * @param <A> The composite IO interface acting upon the hardware and child modules.
 */
public abstract class CompositeSubsystem<D extends CompositeData<D>, A extends CompositeIO<D>> 
    extends ModularSubsystem<D, A> {

    /**
     * Constructs a CompositeSubsystem using the provided configuration builder.
     *
     * @param builder The fully configured {@link SubsystemBuilder}.
     */
    protected CompositeSubsystem(SubsystemBuilder<D, A> builder) {
        super(builder);
    }

    /**
     * A convenience method to access a specific child module directly through the parent subsystem.
     *
     * @param <S> The expected type of the child subsystem.
     * @param key The identifier key of the child module.
     * @return The requested child subsystem.
     */
    protected <S extends ModularSubsystem<?, ?>> S getSubsystem(String key) {
        return actor.getChild(key);
    }
}