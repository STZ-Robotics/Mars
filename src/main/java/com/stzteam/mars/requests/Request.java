package com.stzteam.mars.requests;

import com.stzteam.mars.diagnostics.ActionStatus;

@FunctionalInterface
public interface Request<P,A>{

    public ActionStatus apply(P parameters, A actor);

}
