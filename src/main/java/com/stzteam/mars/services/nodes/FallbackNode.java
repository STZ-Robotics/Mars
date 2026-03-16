package com.stzteam.mars.services.nodes;

/**
 * A Null Object pattern implementation for a {@link Node}.
 * Used to safely disable a computational node without causing NullPointerExceptions 
 * in the main robot loop. Its periodic execution is completely bypassed.
 *
 * @param <M> The type of {@link NodeMessage} that would normally be produced.
 */
public class FallbackNode<M extends NodeMessage<M>> extends Node<M> {
    
    /**
     * Constructs a safe, inactive node.
     */
    public FallbackNode() {
        super("FallbackNode", null, null);
    }

    @Override
    public boolean isFallback() {
        return true; 
    }

    /**
     * Ignored implementation. A fallback node performs no computation.
     */
    @Override
    protected void processInformation() {
        // No operation
    }
}