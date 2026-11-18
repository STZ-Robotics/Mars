package com.stzteam.mars.blackboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Optional;

import org.junit.jupiter.api.Test;

class BlackboardTest {

    @Test
    void writingNullRemovesTheValue() {
        BlackboardKey<String> key = new BlackboardKey<>("Target" + System.nanoTime(), String.class);
        Blackboard.getInstance().write(key, "seen");
        assertEquals(Optional.of("seen"), Blackboard.getInstance().read(key));

        Blackboard.getInstance().write(key, null);
        assertTrue(Blackboard.getInstance().read(key).isEmpty(), "a value that is gone must not be read forever");
    }

    @Test
    void clearRemovesTheValue() {
        BlackboardKey<Integer> key = new BlackboardKey<>("Count" + System.nanoTime(), Integer.class);
        Blackboard.getInstance().write(key, 3);
        Blackboard.getInstance().clear(key);
        assertTrue(Blackboard.getInstance().read(key).isEmpty());
    }

    @Test
    void aKeyMadeWithAPrimitiveClassCanBeReadBack() {
        BlackboardKey<Double> key = new BlackboardKey<>("Speed" + System.nanoTime(), double.class);
        Blackboard.getInstance().write(key, 2.5);
        assertEquals(Optional.of(2.5), Blackboard.getInstance().read(key));
        assertEquals(new BlackboardKey<>(key.name, Double.class), key, "double.class and Double.class are the same key");
    }

    @Test
    void keysWithTheSameNameAndTypeAreTheSameEntry() {
        String name = "Shared" + System.nanoTime();
        Blackboard.getInstance().write(new BlackboardKey<>(name, String.class), "a");
        assertEquals(Optional.of("a"), Blackboard.getInstance().read(new BlackboardKey<>(name, String.class)));
    }
}
