package com.stzteam.mars.models;

import com.stzteam.mars.models.singlemodule.Data;
import com.stzteam.mars.models.singlemodule.IO;
import com.stzteam.mars.requests.Request;

/**
 * A fluent builder for constructing {@link com.stzteam.mars.models.singlemodule.ModularSubsystem} instances.
 * This class ensures that all necessary components (IO actors, data structures, and requests)
 * are properly configured before the subsystem is instantiated and registered.
 *
 * @param <D> The data structure representing the subsystem's inputs.
 * @param <A> The IO interface representing the hardware actor.
 */
public class SubsystemBuilder<D extends Data<D>, A extends IO<D>> {
    private String key;
    private D inputs;
    private A actor;
    private Request<D, A> initialRequest;
    private Telemetry<D> telemetry;

    private SubsystemBuilder() {}

    /**
     * Initializes a new builder instance.
     *
     * @param <D> The input data type.
     * @param <A> The hardware IO type.
     * @return A new, empty {@link SubsystemBuilder}.
     */
    public static <D extends Data<D>, A extends IO<D>> SubsystemBuilder<D, A> setup() {
        return new SubsystemBuilder<>();
    }

    /**
     * Sets the unique string identifier for the subsystem.
     *
     * @param key The name/key of the subsystem (e.g., "Shooter", "Swerve").
     * @return The current builder instance for chaining.
     */
    public SubsystemBuilder<D, A> key(String key) { 
        this.key = key; 
        return this; 
    }

    /**
     * Binds the hardware interface and data structure to the subsystem.
     *
     * @param actor  The instantiated IO layer (real or simulated).
     * @param inputs The data object where hardware readings will be stored.
     * @return The current builder instance for chaining.
     */
    public SubsystemBuilder<D, A> hardware(A actor, D inputs) { 
        this.actor = actor; 
        this.inputs = inputs; 
        return this; 
    }

    /**
     * Sets the default or initial request the subsystem will run upon boot.
     *
     * @param req The starting {@link Request} (usually an Idle or Stop state).
     * @return The current builder instance for chaining.
     */
    public SubsystemBuilder<D, A> request(Request<D, A> req) { 
        this.initialRequest = req; 
        return this; 
    }

    /**
     * Attaches a telemetry implementation to broadcast the subsystem's data.
     *
     * @param tel The {@link Telemetry} instance.
     * @return The current builder instance for chaining.
     */
    public SubsystemBuilder<D, A> telemetry(Telemetry<D> tel) { 
        this.telemetry = tel; 
        return this; 
    }

    public String getKey() { return key; }
    public D getInputs() { return inputs; }
    public A getActor() { return actor; }
    public Request<D, A> getInitialRequest() { return initialRequest; }
    public Telemetry<D> getTelemetry() { return telemetry; }
}