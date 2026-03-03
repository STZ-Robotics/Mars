package com.stzteam.mars.operator;

import com.stzteam.mars.operator.ControllerContainer.ActionButtons;
import com.stzteam.mars.operator.ControllerContainer.AnalogAxis;
import com.stzteam.mars.operator.ControllerContainer.AnalogTriggers;
import com.stzteam.mars.operator.ControllerContainer.Bumpers;
import com.stzteam.mars.operator.ControllerContainer.DPadTriggers;
import com.stzteam.mars.operator.ControllerContainer.SpecialTriggers;
import com.stzteam.mars.operator.ControllerContainer.Stick;

public interface ControllerOI {

    public Stick getLeftStick();
    public Stick getRightStick();

    public Bumpers getBumpers();
    public DPadTriggers getDPadTriggers();
    public SpecialTriggers getSystemTriggers();
    public ActionButtons getActionButtons();
    public AnalogTriggers getAnalogTriggers();
    public AnalogAxis getAnalogAxis();

}
