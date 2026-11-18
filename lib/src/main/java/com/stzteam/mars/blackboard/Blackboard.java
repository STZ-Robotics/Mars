package com.stzteam.mars.blackboard;

import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

public class Blackboard {
    
    private static final Blackboard INSTANCE = new Blackboard();
    // Keyed by BlackboardKey, which is equal by name AND type: two keys with the same
    // name and type are the same entry wherever they were created, and a key with the
    // same name but another type is a different one.
    private final ConcurrentHashMap<BlackboardKey<?>, Object> dataStore = new ConcurrentHashMap<>();

    private Blackboard() {}

    public static Blackboard getInstance() { 
        return INSTANCE; 
    }

    /**
     * Writes a value. Writing {@code null} removes it, so readers get an empty Optional
     * instead of the last value forever (a target pose that is no longer seen, say).
     *
     * @param <T>   The value's type.
     * @param key   The key to write under.
     * @param value The value, or {@code null} to remove it.
     */
    public <T> void write(BlackboardKey<T> key, T value) {
        if (value == null) {
            dataStore.remove(key);
        } else {
            dataStore.put(key, value);
        }
    }

    /**
     * Removes the value under a key.
     *
     * @param key The key to clear.
     */
    public void clear(BlackboardKey<?> key) {
        dataStore.remove(key);
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