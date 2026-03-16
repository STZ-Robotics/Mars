package com.stzteam.mars.blackboard;

import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

public class Blackboard {
    
    private static final Blackboard INSTANCE = new Blackboard();
    private final ConcurrentHashMap<String, Object> dataStore = new ConcurrentHashMap<>();

    private Blackboard() {}

    public static Blackboard getInstance() { 
        return INSTANCE; 
    }

    /**
     * Writes a value to the blackboard using a strongly-typed key.
     */
    public <T> void write(BlackboardKey<T> key, T value) {
        if (value != null) {
            dataStore.put(key.name, value);
        }
    }

    /**
     * Reads a value from the blackboard securely using its typed key.
     * The compiler automatically knows what type of data will be returned.
     */
    @SuppressWarnings("unchecked")
    public <T> Optional<T> read(BlackboardKey<T> key) {
        Object value = dataStore.get(key.name);
        
        if (key.type.isInstance(value)) {
            return Optional.of((T) value);
        }
        return Optional.empty();
    }
}