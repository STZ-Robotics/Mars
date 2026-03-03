package com.stzteam.mars.models.multimodules;

import java.util.LinkedHashMap;
import java.util.Map;

import com.stzteam.mars.models.singlemodule.IO;
import com.stzteam.mars.models.singlemodule.ModularSubsystem;

public abstract class CompositeIO<D extends CompositeData<D>> implements IO<D> {
    
    private final Map<String, ModularSubsystem<?, ?>> children = new LinkedHashMap<>();

    public void registerChild(ModularSubsystem<?, ?> child) {
        children.put(child.tableName, child);
    }

    @SuppressWarnings("unchecked")
    public <S extends ModularSubsystem<?, ?>> S getChild(String key) {
        return (S) children.get(key);
    }

    public Iterable<ModularSubsystem<?, ?>> getAllChildren() {
        return children.values();
    }

    @Override
    public abstract void updateInputs(D inputs);
}
