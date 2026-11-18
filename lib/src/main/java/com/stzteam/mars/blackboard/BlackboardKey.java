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
        this.type = boxed(type);
    }

    /**
     * {@code double.class} is a {@code Class<Double>} and compiles as a key's type, but no
     * value is ever an instance of a primitive class: such a key could be written and
     * never read back. Its wrapper is used instead.
     */
    @SuppressWarnings("unchecked")
    private static <T> Class<T> boxed(Class<T> type) {
        if (type == null || !type.isPrimitive()) return type;
        if (type == double.class) return (Class<T>) Double.class;
        if (type == int.class) return (Class<T>) Integer.class;
        if (type == boolean.class) return (Class<T>) Boolean.class;
        if (type == long.class) return (Class<T>) Long.class;
        if (type == float.class) return (Class<T>) Float.class;
        if (type == short.class) return (Class<T>) Short.class;
        if (type == byte.class) return (Class<T>) Byte.class;
        if (type == char.class) return (Class<T>) Character.class;
        return type;
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