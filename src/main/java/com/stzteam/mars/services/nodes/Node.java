package com.stzteam.mars.services.nodes;

import java.util.function.Consumer;

/**
 * The core computational unit of the MARS background processing architecture.
 * Mimicking ROS (Robot Operating System), a Node performs localized, continuous 
 * processing (like sensor fusion or vision tracking) and publishes its results 
 * as a {@link NodeMessage} to a registered topic/consumer.
 *
 * @param <M> The type of {@link NodeMessage} this node produces.
 */
public abstract class Node<M extends NodeMessage<M>> {
    
    /** The unique identifier for this node, used for telemetry and logging. */
    protected final String nodeName;
    /** The mutable data structure holding the processing results. */
    protected final M messagePayload; 
    /** The subscriber/callback that consumes the processed message. */
    protected final Consumer<M> topicPublisher; 

    /**
     * Constructs a new computational Node.
     *
     * @param nodeName       The name of the node (e.g., "OdometryNode").
     * @param emptyMessage   An initial, empty instance of the message payload to be populated.
     * @param topicPublisher A consumer (like a subsystem method) that receives the published message.
     */
    public Node(String nodeName, M emptyMessage, Consumer<M> topicPublisher) {
        this.nodeName = nodeName;
        this.messagePayload = emptyMessage;
        this.topicPublisher = topicPublisher;
    }

    /**
     * Determines if this node is a dummy/fallback implementation.
     * * @return True if this is a fallback node, false if it is actively processing.
     */
    public boolean isFallback() {
        return false;
    }

    /**
     * The main execution loop of the node.
     * It safely executes the processing logic, updates network telemetry, 
     * and broadcasts the payload to any subscribers. 
     * Automatically bypassed if the node is a fallback.
     */
    public final void periodic() {

        if (isFallback()) return; 

        processInformation();
    
        messagePayload.telemeterize(nodeName);

        if (topicPublisher != null) {
            topicPublisher.accept(messagePayload);
        }
    }

    /**
     * Custom logic implementation for the node.
     * This method is called continuously and should update the {@code messagePayload} 
     * with the latest calculations, sensor readings, or data fusions.
     */
    protected abstract void processInformation();
}