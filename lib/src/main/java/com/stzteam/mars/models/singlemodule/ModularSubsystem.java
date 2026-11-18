package com.stzteam.mars.models.singlemodule;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BiConsumer;
import java.util.function.Supplier;

import com.stzteam.forgemini.io.IOSubsystem;
import com.stzteam.forgemini.io.NetworkIO;
import com.stzteam.mars.blackboard.Blackboard;
import com.stzteam.mars.blackboard.BlackboardKey;
import com.stzteam.mars.diagnostics.ActionStatus;
import com.stzteam.mars.diagnostics.AlertRegistry;
import com.stzteam.mars.diagnostics.DiagnosticPayload;
import com.stzteam.mars.diagnostics.MARSWatchdog;
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
    private final Request<D, A> defaultRequest;

    private String lastSentHex = "";
    private String lastSentMessage = "";

    /**
     * How many times a Request has been applied, so {@link #runRequestUntilDone}
     * can tell a status its own Request produced from one left by the previous Request.
     */
    private long appliedCount = 0;

    /**
     * Registered global input hooks, invoked once per subsystem per loop, right after
     * hardware inputs are read and before any Request logic runs. Intended for optional
     * addons/Features (e.g. an AdvantageKit bridge, an external telemetry adapter) to
     * intercept input snapshots without requiring MARS core to depend on any external
     * library, and without different Features stepping on each other's hook.
     * <p>
     * Uses {@link CopyOnWriteArrayList} since registration happens rarely (typically once
     * per Feature at boot) while iteration happens every loop for every subsystem.
     */
    private static final List<BiConsumer<String, Data<?>>> globalInputHooks = new CopyOnWriteArrayList<>();

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
        this.defaultRequest = builder.getInitialRequest();

        GCSConsole.registerModuleMount(builder.getKey(), this.isFallback);

        this.setDefaultCommand(runRequest(() -> defaultRequest));
    }

    /**
     * Registers a global input hook. Multiple hooks can coexist (e.g. an AdvantageKit
     * bridge Feature and an unrelated telemetry Feature can both register independently
     * without overwriting each other).
     *
     * @param hook A consumer receiving (subsystemName, dataSnapshot).
     * @return The same hook instance, so callers can keep a reference for later removal
     *         via {@link #removeGlobalInputHook(BiConsumer)}.
     */
    public static BiConsumer<String, Data<?>> addGlobalInputHook(BiConsumer<String, Data<?>> hook) {
        if (hook != null) {
            globalInputHooks.add(hook);
        }
        return hook;
    }

    /**
     * Unregisters a previously added global input hook. No-op if the hook was never
     * registered or was already removed.
     *
     * @param hook The exact hook instance previously passed to {@link #addGlobalInputHook}.
     */
    public static void removeGlobalInputHook(BiConsumer<String, Data<?>> hook) {
        globalInputHooks.remove(hook);
    }

    /**
     * Removes every registered global input hook. Mainly useful for test isolation.
     */
    public static void clearGlobalInputHooks() {
        globalInputHooks.clear();
    }

    /**
     * The primary execution loop of the subsystem.
     * This method safely polls hardware inputs, applies any custom periodic logic, 
     * evaluates the current request, and broadcasts telemetry.
     * Wrapped by {@link MARSWatchdog} to detect loop overruns (toggleable).
     */
    @Override
    public final void periodicLogic(){
        // Failsafe: Bypass all execution if the hardware actor is a fallback to prevent NPEs.
        if(actor.isFallback()) return;

        MARSWatchdog.monitor(this.getName(), this::executePeriodicLogic);
    }

    private void executePeriodicLogic() {
        actor.updateInputs(inputs);
        D data = inputs.snapshot();

        if (!globalInputHooks.isEmpty()) {
            String name = this.getName();
            for (BiConsumer<String, Data<?>> hook : globalInputHooks) {
                hook.accept(name, data);
            }
        }

        absolutePeriodic(data);

        if (currentRequest != null) {
            this.lastStatus = currentRequest.apply(data, actor);
            appliedCount++;
        }

        if (this.lastStatus != null && this.lastStatus.code != null) {
            DiagnosticPayload payload = this.lastStatus.getPayload();
            String currentHex = payload.colorHex();
            String currentMessage = payload.message();
            String subKey = this.getName();

            if (!currentHex.equals(lastSentHex) || !currentMessage.equals(lastSentMessage)) {

                NetworkIO.set(subKey, "Status/Name", subKey);
                NetworkIO.set(subKey, "Status/Hex", currentHex);
                NetworkIO.set(subKey, "Status/Message", currentMessage);

                lastSentHex = currentHex;
                lastSentMessage = currentMessage;
            }

            // Centralized alert reporting - toggleable via AlertRegistry.setEnabled(false)
            AlertRegistry.getInstance().report(subKey, this.lastStatus);
        }

        if (telemetry != null) {
            telemetry.telemeterize(data);
        }
    }

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
            if (this.currentRequest == null || !this.currentRequest.isSameRequest(newRequest)) {

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
     * <p>
     * Only a status the new Request itself produced can finish it. The scheduler runs a
     * subsystem's periodic before its commands, so on the command's first cycle the status
     * still belongs to the previous Request -- usually an idle one reporting OK, which used
     * to end the command before the new Request had run at all. On a fallback IO, where no
     * Request ever runs, it finishes at once.
     *
     * @param requestSupplier A lambda providing the Request to run.
     * @return A WPILib {@link Command}.
     */
    public Command runRequestUntilDone(Supplier<? extends Request<D, A>> requestSupplier) {
        // How many Requests had been applied when this command first set its own. Taken
        // on the first execute, not on initialize: inside a sequence a command is
        // initialized one cycle before it executes, and the periodic in between still
        // applies the previous Request.
        final long[] appliedWhenSet = new long[1];
        return this.startRun(
                    () -> appliedWhenSet[0] = Long.MAX_VALUE,
                    () -> {
                        this.setRequest(requestSupplier.get());
                        if (appliedWhenSet[0] == Long.MAX_VALUE) appliedWhenSet[0] = appliedCount;
                    })
                   .until(() -> {
                       if (isFallback) return true;
                       if (appliedCount <= appliedWhenSet[0]) return false;
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
        return defaultRequest;
    }

    /**
     * Retrieves the hardware actor for this subsystem. Primarily intended for 
     * framework-level utilities (e.g. SysId characterization) rather than everyday use —
     * prefer working through Requests for normal subsystem control.
     *
     * @return The subsystem's IO/actor instance.
     */
    public A getActor() {
        return actor;
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