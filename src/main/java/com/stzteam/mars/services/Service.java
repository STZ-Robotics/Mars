package com.stzteam.mars.services;

/**
 * A functional interface representing a synchronous or asynchronous operation 
 * that takes a request and returns a computed response.
 * <p>
 * Services are ideal for heavy, single-fire computations like querying a vision 
 * coprocessor for the best target or asking a pathfinder for a trajectory to a pose.
 *
 * @param <Q> The type of {@link Query} containing the input parameters.
 * @param <R> The type of {@link Reply} containing the resulting computation.
 */
@FunctionalInterface
public interface Service<Q extends Query, R extends Reply> {
    
    /**
     * Executes the service logic based on the provided query.
     *
     * @param query The input parameters or request payload.
     * @return The computed result or response.
     */
    R execute(Q query);
}