package com.stzteam.mars.blackboard;

import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

public class Blackboard {
    
    private static final Blackboard INSTANCE = new Blackboard();
    // Keyed by the BlackboardKey instance itself, not its name, to avoid
    // silent collisions between keys that happen to share a display name.
    private final ConcurrentHashMap<BlackboardKey<?>, Object> dataStore = new ConcurrentHashMap<>();

    private Blackboard() {}

    public static Blackboard getInstance() { 
        return INSTANCE; 
    }

    public <T> void write(BlackboardKey<T> key, T value) {
        if (value != null) {
            dataStore.put(key, value);
        }
    }

    @SuppressWarnings("unchecked")
    public <T> Optional<T> read(BlackboardKey<T> key) {
        Object value = dataStore.get(key);
        
        if (key.type.isInstance(value)) {
            return Optional.of((T) value);
        }
        return Optional.empty();
    }

}