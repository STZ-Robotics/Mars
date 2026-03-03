package com.stzteam.mars.models.singlemodule;


import java.util.function.Supplier;

import com.stzteam.forgemini.io.IOSubsystem;
import com.stzteam.mars.diagnostics.ActionStatus;
import com.stzteam.mars.models.SubsystemBuilder;
import com.stzteam.mars.models.Telemetry;
import com.stzteam.mars.requests.Request;
import com.stzteam.mars.utils.TerminalGCS;

import edu.wpi.first.wpilibj2.command.Command;

public abstract class ModularSubsystem<D extends Data<D>, A extends IO<D>> extends IOSubsystem {

    protected final D inputs;
    protected final A actor;
    private Request<D, A> currentRequest;
    private Telemetry<D> telemetry;
    private ActionStatus lastStatus;
    public final boolean isFallback;
    private final Request<D, A> defaulRequest;

    protected ModularSubsystem(SubsystemBuilder<D, A> builder) {
        super(builder.getKey());
        this.inputs = builder.getInputs();
        this.actor = builder.getActor();
        this.currentRequest = builder.getInitialRequest();
        this.telemetry = builder.getTelemetry();
        this.lastStatus = ActionStatus.ok();

        this.isFallback = actor.isFallback();

        this.defaulRequest = builder.getInitialRequest();

        TerminalGCS.registerModuleMount(builder.getKey(), this.isFallback);
        TerminalGCS.registerSubsystem(this);
    }

    @Override
    public final void periodicLogic(){

        if(actor.isFallback()) return;

        actor.updateInputs(inputs);

        D data = inputs.snapshot();

        absolutePeriodic(data);

        if (currentRequest != null) {
            this.lastStatus = currentRequest.apply(data, actor);
        }

        if (telemetry != null) {
            telemetry.telemeterize(data, lastStatus);
        }

    }

    public abstract D getState();


    public abstract void absolutePeriodic(D inputs);

    public void registerTelemetry(Telemetry<D> telemetry) {
        this.telemetry = telemetry;
    }

    public void setRequest(Request<D, A> newRequest) {
        if (newRequest != null) {
            if (this.currentRequest == null || !this.currentRequest.getClass().equals(newRequest.getClass())) {
                
                String reqName = newRequest.getClass().getSimpleName();
                
                if (!reqName.toLowerCase().contains("idle")) {
                    TerminalGCS.logRequest(this.getName(), reqName);
                    
                    String statusMsg = (lastStatus != null && lastStatus.message != null) ? lastStatus.message : "OK";
                    TerminalGCS.logState(this.getName(), statusMsg); 
                }
            }
            this.currentRequest = newRequest;
        }
    }

    public Command runRequest(Supplier<? extends Request<D, A>> requestSupplier) {
        return this.run(() -> this.setRequest(requestSupplier.get()));
    }

    public Command runRequestUntilDone(Supplier<? extends Request<D, A>> requestSupplier) {
        return this.run(() -> this.setRequest(requestSupplier.get()))
                   .until(() -> {
                       ActionStatus status = this.getLastStatus();
                       return status != null && status.isDone();
                   });
    }

    protected void overrideStatus(ActionStatus emergencyStatus) {
        this.lastStatus = emergencyStatus;
    }

    public ActionStatus getLastStatus() {
        return lastStatus;
    }

    public Request<D,A> getDefaultRequest(){
        return defaulRequest;
    }
}