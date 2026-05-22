package com.stzteam.mars.models.singlemodule;

import java.util.Optional;
import java.util.function.Supplier;

import com.stzteam.forgemini.io.IOSubsystem;
import com.stzteam.forgemini.io.NetworkIO;
import com.stzteam.mars.blackboard.Blackboard;
import com.stzteam.mars.blackboard.BlackboardKey;
import com.stzteam.mars.diagnostics.ActionStatus;
import com.stzteam.mars.diagnostics.DiagnosticPayload;
import com.stzteam.mars.models.SubsystemBuilder;
import com.stzteam.mars.models.Telemetry;
import com.stzteam.mars.requests.Request;
import com.stzteam.mars.utils.GCSConsole;

import edu.wpi.first.wpilibj2.command.Command;

/**
 * The core architectural building block of the MARS framework.
 * A ModularSubsystem enforces a strict separation of concerns by completely isolating 
 * the hardware IO (Actor), state data (Inputs), and execution logic (Requests).
 * <p>
 * It automatically handles the periodic hardware polling, request execution, and 
 * telemetry broadcasting safely, preventing logic errors on disabled hardware.
 *
 * @param <D> The data structure holding the subsystem's state.
 * @param <A> The IO interface acting upon the hardware.
 */
public abstract class ModularSubsystem<D extends Data<D>, A extends IO<D>> extends IOSubsystem {

    /** The data structure containing the latest hardware readings. */
    protected final D inputs;
    /** The hardware interface implementation (Real, Sim, or Fallback). */
    protected final A actor;
    
    private Request<D, A> currentRequest;
    private Telemetry<D> telemetry;
    private ActionStatus lastStatus;
    
    /** Indicates if the subsystem is running on a dummy IO implementation. */
    public final boolean isFallback;
    private final Request<D, A> defaulRequest;

    private String lastSentHex = "";
    private String lastSentMessage = "";

    /**
     * Constructs a ModularSubsystem using the provided configuration builder.
     *
     * @param builder The fully configured {@link SubsystemBuilder}.
     */
    protected ModularSubsystem(SubsystemBuilder<D, A> builder) {
        super(builder.getKey());
        this.inputs = builder.getInputs();
        this.actor = builder.getActor();
        this.currentRequest = builder.getInitialRequest();
        this.telemetry = builder.getTelemetry();
        this.lastStatus = ActionStatus.ok();

        this.isFallback = actor.isFallback();
        this.defaulRequest = builder.getInitialRequest();

        GCSConsole.registerModuleMount(builder.getKey(), this.isFallback);

        //Register the default command
        this.setDefaultCommand(runRequest(()-> defaulRequest));

    }

    /**
     * The primary execution loop of the subsystem.
     * This method safely polls hardware inputs, applies any custom periodic logic, 
     * evaluates the current request, and broadcasts telemetry.
     */
    @Override
    public final void periodicLogic(){
        // Failsafe: Bypass all execution if the hardware actor is a fallback to prevent NPEs.
        if(actor.isFallback()) return;

        actor.updateInputs(inputs);
        D data = inputs.snapshot();

        absolutePeriodic(data);

        if (currentRequest != null) {
            this.lastStatus = currentRequest.apply(data, actor);
        }

        if (this.lastStatus != null && this.lastStatus.code != null) {
            DiagnosticPayload payload = this.lastStatus.getPayload();
            String currentHex = payload.colorHex();
            String currentMessage = payload.message();

            if (!currentHex.equals(lastSentHex) || !currentMessage.equals(lastSentMessage)) {
                String subKey = this.getName();
                
                NetworkIO.set(subKey, "Status/Name", subKey);
                NetworkIO.set(subKey, "Status/Hex", currentHex);
                NetworkIO.set(subKey, "Status/Message", currentMessage);

                lastSentHex = currentHex;
                lastSentMessage = currentMessage;
            }
        }

        if (telemetry != null) {
            telemetry.telemeterize(data);
        }
    }

    /**
     * Gets the custom state or configuration object specific to this subsystem.
     *
     * @return The state definition.
     */
    public abstract D getState();

    /**
     * An overrideable hook for custom logic that must run every loop iteration, 
     * independent of the current Request (e.g., updating odometry).
     *
     * @param inputs The latest hardware snapshot.
     */
    public abstract void absolutePeriodic(D inputs);

    /**
     * Assigns a telemetry broadcaster to the subsystem dynamically.
     *
     * @param telemetry The new telemetry instance.
     */
    public void registerTelemetry(Telemetry<D> telemetry) {
        this.telemetry = telemetry;
    }

    /**
     * Updates the active Request (state machine logic) running on the subsystem.
     * Logs the transition to the terminal if it is not a generic idle state.
     *
     * @param newRequest The new Request to execute.
     */
    public void setRequest(Request<D, A> newRequest) {
        if (newRequest != null) {
            if (this.currentRequest == null || !this.currentRequest.getClass().equals(newRequest.getClass())) {
                
                String reqName = newRequest.getClass().getSimpleName();
                
                if (!reqName.toLowerCase().contains("idle")) {
                    GCSConsole.logRequest(this.getName(), reqName);
                    
                    String statusMsg = (lastStatus != null && lastStatus.message != null) ? lastStatus.message : "OK";
                    GCSConsole.logState(this.getName(), statusMsg); 
                }
            }
            this.currentRequest = newRequest;
        }
    }

    /**
     * Creates a WPILib Command that executes a specific Request endlessly until interrupted.
     * Ideal for default commands or continuous actions (e.g., driving a swerve base).
     *
     * @param requestSupplier A lambda providing the Request to run.
     * @return A WPILib {@link Command}.
     */
    public Command runRequest(Supplier<? extends Request<D, A>> requestSupplier) {
        return this.run(() -> this.setRequest(requestSupplier.get()));
    }

    /**
     * Creates a WPILib Command that executes a specific Request and automatically finishes 
     * when the subsystem's ActionStatus evaluates to 'Done' (Severity.OK).
     * Ideal for autonomous routines.
     *
     * @param requestSupplier A lambda providing the Request to run.
     * @return A WPILib {@link Command}.
     */
    public Command runRequestUntilDone(Supplier<? extends Request<D, A>> requestSupplier) {
        return this.run(() -> this.setRequest(requestSupplier.get()))
                   .until(() -> {
                       ActionStatus status = this.getLastStatus();
                       return status != null && status.isDone();
                   });
    }

    /**
     * Forcefully overrides the current diagnostic status (e.g., triggering an emergency halt).
     *
     * @param emergencyStatus The superseding {@link ActionStatus}.
     */
    protected void overrideStatus(ActionStatus emergencyStatus) {
        this.lastStatus = emergencyStatus;
    }

    /**
     * Retrieves the most recently evaluated diagnostic status of the subsystem.
     *
     * @return The latest {@link ActionStatus}.
     */
    public ActionStatus getLastStatus() {
        return lastStatus;
    }

    /**
     * Retrieves the default Request assigned during the subsystem's configuration.
     *
     * @return The default {@link Request}.
     */
    public Request<D,A> getDefaultRequest(){
        return defaulRequest;
    }

    /**
     * Writes a value to the global blackboard under the specified key.
     * @param <T> The type of the value being written.
     * @param key The blackboard key to write to.
     * @param value The value to write.
     */
    protected <T> void writeToBoard(BlackboardKey<T> key, T value) {
        Blackboard.getInstance().write(key, value);
    }

    /**
     * Reads a value from the global blackboard using the specified key.
     * @param <T> The type of the value being read.
     * @param key The blackboard key to read from.
     * @return An Optional containing the value if present and of the correct type, or empty otherwise.
     */
    protected <T> Optional<T> readFromBoard(BlackboardKey<T> key) {
        return Blackboard.getInstance().read(key);
    }
}