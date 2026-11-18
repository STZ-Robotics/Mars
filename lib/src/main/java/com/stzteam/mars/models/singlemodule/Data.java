package com.stzteam.mars.models.singlemodule;

import edu.wpi.first.wpilibj.Timer;

/**
 * The foundational data structure representing a snapshot of hardware inputs.
 * Subclasses should define specific fields (e.g., motor positions, sensor readings) 
 * that are updated by the IO layer.
 *
 * @param <T> The specific subclass type, enabling fluent casting.
 */
public class Data<T>{
    /** The exact WPILib FPGA timestamp when this data was generated/updated. */
    public double timestamp = Timer.getFPGATimestamp();
    /** An optional identifier for the data source. */
    public String key;

    /**
     * Casts the current data instance to its concrete subclass type.
     * This is useful for passing strongly-typed data to Requests and Telemetry without manual casting.
     * <p>
     * It returns this same object, not a copy: the IO keeps writing into it every loop.
     * Anything that keeps a reference across loops (an input hook that buffers samples, for
     * instance) has to copy the fields it needs, or every sample it kept will read the latest.
     *
     * @return The data object cast to type {@code T}.
     */
    @SuppressWarnings("unchecked")
    public T snapshot() {
        return (T) this;
    }
}