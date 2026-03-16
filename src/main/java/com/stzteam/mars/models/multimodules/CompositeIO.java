package com.stzteam.mars.models.multimodules;

import java.util.LinkedHashMap;
import java.util.Map;

import com.stzteam.mars.models.singlemodule.IO;
import com.stzteam.mars.models.singlemodule.ModularSubsystem;

/**
 * A specialized IO interface designed to manage hardware interactions for 
 * composite subsystems. It acts as a parent controller that registers and 
 * holds references to its child modules, allowing coordinated hardware updates.
 *
 * @param <D> The {@link CompositeData} structure associated with this composite IO.
 */
public abstract class CompositeIO<D extends CompositeData<D>> implements IO<D> {
    
    private final Map<String, ModularSubsystem<?, ?>> children = new LinkedHashMap<>();

    /**
     * Registers a child subsystem to this composite IO structure.
     *
     * @param child The {@link ModularSubsystem} to register.
     */
    public void registerChild(ModularSubsystem<?, ?> child) {
        children.put(child.tableName, child);
    }

    /**
     * Retrieves a registered child subsystem by its unique key.
     *
     * @param <S> The expected type of the child subsystem.
     * @param key The identifier key of the child.
     * @return The requested child subsystem, cast to type {@code S}.
     */
    @SuppressWarnings("unchecked")
    public <S extends ModularSubsystem<?, ?>> S getChild(String key) {
        return (S) children.get(key);
    }

    /**
     * Retrieves all registered child subsystems.
     *
     * @return An iterable collection of all child modules.
     */
    public Iterable<ModularSubsystem<?, ?>> getAllChildren() {
        return children.values();
    }

    /**
     * Reads values from the composite hardware (and typically delegates to its children) 
     * to populate the provided composite data object.
     *
     * @param inputs The composite data object to update.
     */
    @Override
    public abstract void updateInputs(D inputs);
}