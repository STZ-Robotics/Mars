package com.stzteam.mars.test;

/**
 * A custom runtime exception thrown when a MARS framework test assertion fails.
 * Designed to cleanly halt or flag test execution upon encountering a critical failure 
 * without crashing the main robot code.
 */
public class MARSAssertionError extends RuntimeException {
    
    /**
     * Constructs a new MARSAssertionError with the specified detail message.
     *
     * @param message The detailed description of the assertion failure.
     */
    public MARSAssertionError(String message) {
        super(message);
    }
}