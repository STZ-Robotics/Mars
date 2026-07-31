package com.stzteam.mars.blackboard;

/**
 * A strongly-typed key used to read and write data to the {@link Blackboard}.
 * By binding the key to a specific Class type, we eliminate casting errors 
 * and ensure type safety at compile time across the entire robot.
 *
 * @param <T> The data type associated with this key (e.g., Double, Boolean, Pose2d).
 */
public class BlackboardKey<T> {
    
    public final String name;
    public final Class<T> type;

    /**
     * Defines a new typed key for the Blackboard.
     *
     * @param name The unique string identifier for the data.
     * @param type The class type of the data to be stored.
     */
    public BlackboardKey(String name, Class<T> type) {
        this.name = name;
        this.type = type;
    }
    
    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (!(obj instanceof BlackboardKey<?> other)) return false;
        return this.name.equals(other.name) && this.type.equals(other.type);
    }

    @Override
    public int hashCode() {
        return java.util.Objects.hash(name, type);
    }
}