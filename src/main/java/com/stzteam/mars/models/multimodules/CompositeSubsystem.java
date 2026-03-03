package com.stzteam.mars.models.multimodules;

import com.stzteam.mars.models.SubsystemBuilder;
import com.stzteam.mars.models.singlemodule.ModularSubsystem;

public abstract class CompositeSubsystem<D extends CompositeData<D>, A extends CompositeIO<D>> 
    extends ModularSubsystem<D, A> {

    protected CompositeSubsystem(SubsystemBuilder<D, A> builder) {
        super(builder);
    }

    protected <S extends ModularSubsystem<?, ?>> S getSubsystem(String key) {
        return actor.getChild(key);
    }
}