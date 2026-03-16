package com.stzteam.mars.models.multimodules;

import com.stzteam.mars.models.singlemodule.Data;

/**
 * The foundational data structure for complex subsystems that are composed of 
 * multiple distinct sub-modules (e.g., a Swerve Drive containing four individual Swerve Modules).
 *
 * @param <T> The specific subclass type, enabling fluent casting.
 */
public abstract class CompositeData<T extends CompositeData<T>> extends Data<T> {

}