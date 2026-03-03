package com.stzteam.mars.operator;

import com.stzteam.mars.operator.ControllerContainer.ActionButtons;
import com.stzteam.mars.operator.ControllerContainer.AnalogAxis;
import com.stzteam.mars.operator.ControllerContainer.AnalogTriggers;
import com.stzteam.mars.operator.ControllerContainer.Bumpers;
import com.stzteam.mars.operator.ControllerContainer.DPadTriggers;
import com.stzteam.mars.operator.ControllerContainer.SpecialTriggers;
import com.stzteam.mars.operator.ControllerContainer.Stick;

import edu.wpi.first.wpilibj2.command.button.CommandXboxController;

public class XboxOI implements ControllerOI{
    
    private final CommandXboxController controller;

    private final Stick leftStick;
    private final Stick rightStick;
    private final ActionButtons buttons;
    private final Bumpers bumpers;
    private final DPadTriggers dPad;
    private final SpecialTriggers system;
    private final AnalogTriggers analog;
    private final AnalogAxis analogAxis;

    public XboxOI(int port){

        this.controller = new CommandXboxController(port);
        this.leftStick = new Stick(controller::getLeftX, controller::getLeftY);
        this.rightStick = new Stick(controller::getRightX, controller::getRightY);

        this.buttons = new ActionButtons(controller.a(), controller.b(), controller.x(), controller.y());

        this.bumpers = new Bumpers(controller.leftBumper(), controller.rightBumper());

        this.dPad = new DPadTriggers(controller.povUp(), controller.povDown(), controller.povLeft(), controller.povRight());

        this.system = new SpecialTriggers(controller.back(), controller.start());

        this.analog = new AnalogTriggers(controller.leftTrigger(), controller.rightTrigger());

        this.analogAxis = new AnalogAxis(controller::getLeftTriggerAxis, controller::getRightTriggerAxis);
        
    }

    @Override
    public Stick getLeftStick() {
        return leftStick;
    }

    @Override
    public Stick getRightStick() {
        return rightStick;
    }

    @Override
    public Bumpers getBumpers() {
        return bumpers;
    }

    @Override
    public DPadTriggers getDPadTriggers() {
        return dPad;
    }

    @Override
    public SpecialTriggers getSystemTriggers() {
        return system;
    }

    @Override
    public ActionButtons getActionButtons() {
        return buttons;
    }

    @Override
    public AnalogTriggers getAnalogTriggers() {
        return analog;
    }

    @Override
    public AnalogAxis getAnalogAxis() {
        return analogAxis;
    }
}

