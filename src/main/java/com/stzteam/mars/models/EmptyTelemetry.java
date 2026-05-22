package com.stzteam.mars.models;

import com.stzteam.mars.models.singlemodule.Data;

public class EmptyTelemetry<D extends Data<D>> extends Telemetry<D> {
    
    @Override
    public void telemeterize(D data) {}
}
