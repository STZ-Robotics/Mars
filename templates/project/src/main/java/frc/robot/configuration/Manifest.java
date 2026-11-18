package frc.robot.configuration;

import com.stzteam.mars.builder.Environment;
import com.stzteam.mars.builder.Environment.RunMode;

import edu.wpi.first.wpilibj.RobotBase;

public class Manifest {

    /**
     * REAL on the roboRIO, SIM everywhere else ("Simulate Robot Code" on a laptop).
     * A fixed REAL here made a simulation build the real hardware IO on the laptop.
     * Write RunMode.REPLAY here to replay a log.
     */
    public static final RunMode CURRENT_MODE = RobotBase.isReal() ? RunMode.REAL : RunMode.SIM;

    static{Environment.setMode(CURRENT_MODE);}

}
