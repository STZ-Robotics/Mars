package com.stzteam.mars.models;

import com.stzteam.mars.models.singlemodule.Data;

/**
 * Defines a contract for broadcasting subsystem data to network tables or logging frameworks.
 * Implementations of this class handle sending the structured inputs and current status 
 * to external dashboards (like AdvantageScope or Shuffleboard).
 *
 * @param <D> The specific {@link Data} type associated with the subsystem.
 */
public abstract class Telemetry<D extends Data<D>> {
    
    /**
     * Publishes the subsystem's current state and status to the telemetry outputs.
     * This method is called periodically by the subsystem's main loop.
     *
     * @param data       A snapshot of the current hardware inputs and states.
     */
    public abstract void telemeterize(D data);
}