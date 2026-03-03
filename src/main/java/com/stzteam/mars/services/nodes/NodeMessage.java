package com.stzteam.mars.services.nodes;

import com.stzteam.mars.models.singlemodule.Data;

public abstract class NodeMessage<M> extends Data<M> {

    public abstract void telemeterize(String tableName);

}
