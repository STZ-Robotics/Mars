package com.stzteam.mars.operator;

import com.stzteam.mars.operator.ControllerContainer.ActionButtons;
import com.stzteam.mars.operator.ControllerContainer.AnalogAxis;
import com.stzteam.mars.operator.ControllerContainer.AnalogTriggers;
import com.stzteam.mars.operator.ControllerContainer.Bumpers;
import com.stzteam.mars.operator.ControllerContainer.DPadTriggers;
import com.stzteam.mars.operator.ControllerContainer.SpecialTriggers;
import com.stzteam.mars.operator.ControllerContainer.Stick;

/**
 * The core Operator Interface (OI) abstraction for the MARS framework.
 * By programming commands against this interface rather than a specific WPILib controller class,
 * the robot logic can effortlessly switch between different hardware (Xbox, PS5, etc.) 
 * without modifying any button bindings.
 */
public interface ControllerOI {

    /** @return The mapped record for the left thumbstick axes. */
    public Stick getLeftStick();
    
    /** @return The mapped record for the right thumbstick axes. */
    public Stick getRightStick();

    /** @return The mapped record for the shoulder bumpers. */
    public Bumpers getBumpers();
    
    /** @return The mapped record for the Directional Pad (POV). */
    public DPadTriggers getDPadTriggers();
    
    /** @return The mapped record for the system/menu buttons. */
    public SpecialTriggers getSystemTriggers();
    
    /** @return The mapped record for the positional action face buttons. */
    public ActionButtons getActionButtons();
    
    /** @return The mapped record for the analog triggers acting as digital buttons. */
    public AnalogTriggers getAnalogTriggers();
    
    /** @return The mapped record providing the raw analog values of the triggers. */
    public AnalogAxis getAnalogAxis();

}