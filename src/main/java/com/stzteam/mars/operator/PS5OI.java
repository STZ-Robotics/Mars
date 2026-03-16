package com.stzteam.mars.operator;

import com.stzteam.mars.operator.ControllerContainer.ActionButtons;
import com.stzteam.mars.operator.ControllerContainer.AnalogAxis;
import com.stzteam.mars.operator.ControllerContainer.AnalogTriggers;
import com.stzteam.mars.operator.ControllerContainer.Bumpers;
import com.stzteam.mars.operator.ControllerContainer.DPadTriggers;
import com.stzteam.mars.operator.ControllerContainer.SpecialTriggers;
import com.stzteam.mars.operator.ControllerContainer.Stick;

import edu.wpi.first.wpilibj2.command.button.CommandPS5Controller;

/**
 * A concrete implementation of the {@link ControllerOI} for PlayStation 5 DualSense controllers.
 * This class wraps a WPILib {@link CommandPS5Controller} and maps its specific 
 * hardware inputs (Cross, Circle, L1, etc.) to the universal MARS positional records.
 */
public class PS5OI implements ControllerOI {

    private final CommandPS5Controller controller;

    private final Stick leftStick;
    private final Stick rightStick;
    private final ActionButtons buttons;
    private final Bumpers bumpers;
    private final DPadTriggers dPad;
    private final SpecialTriggers system;
    private final AnalogTriggers analog;
    private final AnalogAxis analogAxis;
    
    /**
     * Initializes the PS5 controller mapping.
     *
     * @param port The Driver Station USB port the controller is plugged into.
     */
    public PS5OI(int port){
        this.controller = new CommandPS5Controller(port);

        this.leftStick = new Stick(controller::getLeftX, controller::getLeftY);
        this.rightStick = new Stick(controller::getRightX, controller::getRightY);

        this.buttons = new ActionButtons(controller.cross(), controller.circle(), controller.square(), controller.triangle());
        this.bumpers = new Bumpers(controller.L1(), controller.R1());
        this.dPad = new DPadTriggers(controller.povUp(), controller.povDown(), controller.povLeft(), controller.povRight());
        this.system = new SpecialTriggers(controller.create(), controller.options());
        this.analog = new AnalogTriggers(controller.L2(), controller.R2());
        this.analogAxis = new AnalogAxis(controller::getL2Axis, controller::getR2Axis);
    }

    @Override public Stick getLeftStick() { return leftStick; }
    @Override public Stick getRightStick() { return rightStick; }
    @Override public Bumpers getBumpers() { return bumpers; }
    @Override public DPadTriggers getDPadTriggers() { return dPad; }
    @Override public SpecialTriggers getSystemTriggers() { return system; }
    @Override public ActionButtons getActionButtons() { return buttons; }
    @Override public AnalogTriggers getAnalogTriggers() { return analog; }
    @Override public AnalogAxis getAnalogAxis() { return analogAxis; }
}