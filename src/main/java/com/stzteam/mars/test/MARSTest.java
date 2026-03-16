package com.stzteam.mars.test;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

/**
 * An annotation used to label and name specific test routines within the MARS framework.
 * Because it has a RUNTIME retention policy, the {@link TestScheduler} can read this 
 * annotation dynamically via reflection to log the custom test name cleanly.
 */
@Retention(RetentionPolicy.RUNTIME)
public @interface MARSTest {
    
    /**
     * The custom, human-readable name of the test routine.
     *
     * @return The test name as a String.
     */
    String name();
}