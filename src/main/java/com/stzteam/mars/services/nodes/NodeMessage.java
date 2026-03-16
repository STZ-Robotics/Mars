package com.stzteam.mars.services.nodes;

import com.stzteam.mars.models.singlemodule.Data;

/**
 * Represents the data payload generated and broadcasted by a {@link Node}.
 * It extends the base MARS {@link Data} structure to include specialized 
 * telemetry capabilities specific to the Node's domain.
 *
 * @param <M> The specific subclass type of the message for fluent casting.
 */
public abstract class NodeMessage<M> extends Data<M> {

    /**
     * Publishes the contents of this message to the network tables or dashboard.
     *
     * @param tableName The base NetworkTable or structural key where the data should be logged.
     */
    public abstract void telemeterize(String tableName);

}