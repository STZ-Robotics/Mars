package com.stzteam.mars.requests;

import com.stzteam.mars.diagnostics.ActionStatus;

/**
 * Represents a specific action or state machine logic block within the MARS framework.
 * Requests cleanly decouple the "what to do" from the "how to do it" by operating purely 
 * on the hardware IO abstraction (Actor) and its current data snapshot (Parameters).
 *
 * @param <P> The Data structure type containing the current state/inputs.
 * @param <A> The IO (Actor) type representing the hardware interface.
 */
@FunctionalInterface
public interface Request<P, A> {

    /**
     * Executes the logic of this request for a single periodic loop iteration.
     *
     * @param parameters The latest snapshot of hardware data.
     * @param actor      The hardware interface to command.
     * @return An {@link ActionStatus} indicating the result or diagnostic state of the execution.
     */
    public ActionStatus apply(P parameters, A actor);

}