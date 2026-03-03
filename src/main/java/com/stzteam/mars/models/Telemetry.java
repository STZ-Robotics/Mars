package com.stzteam.mars.models;

import com.stzteam.mars.diagnostics.ActionStatus;
import com.stzteam.mars.models.singlemodule.Data;

public abstract class Telemetry<D extends Data<D>> {
    
    public abstract void telemeterize(D data, ActionStatus lastStatus);
}
