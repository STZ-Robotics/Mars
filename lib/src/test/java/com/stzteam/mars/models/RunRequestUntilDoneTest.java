package com.stzteam.mars.models;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stzteam.mars.diagnostics.ActionStatus;
import com.stzteam.mars.models.singlemodule.Data;
import com.stzteam.mars.models.singlemodule.IO;
import com.stzteam.mars.models.singlemodule.ModularSubsystem;
import com.stzteam.mars.requests.Request;

import edu.wpi.first.hal.HAL;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Commands;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * runRequestUntilDone has to wait for a status its own Request produced. The scheduler
 * runs a subsystem's periodic before its commands, so the first status the command sees
 * belongs to the previous Request: an idle one reports OK, and that used to end the
 * command before the new Request had run once.
 */
class RunRequestUntilDoneTest {

    static class Inputs extends Data<Inputs> {}

    static class FakeIO implements IO<Inputs> {
        private final boolean fallback;
        FakeIO(boolean fallback) { this.fallback = fallback; }
        @Override public void updateInputs(Inputs inputs) {}
        @Override public boolean isFallback() { return fallback; }
    }

    static class Mechanism extends ModularSubsystem<Inputs, FakeIO> {
        Mechanism(String key, boolean fallback) {
            super(SubsystemBuilder.<Inputs, FakeIO>setup()
                .key(key)
                .hardware(new FakeIO(fallback), new Inputs())
                .request((inputs, io) -> ActionStatus.ok()));
        }
        @Override public void absolutePeriodic(Inputs inputs) {}
    }

    /** Reports WORKING until it has run `cycles` times, then OK. */
    static class Move implements Request<Inputs, FakeIO> {
        final int cycles;
        int runs = 0;
        Move(int cycles) { this.cycles = cycles; }
        @Override public ActionStatus apply(Inputs inputs, FakeIO io) {
            runs++;
            return runs >= cycles ? ActionStatus.ok() : ActionStatus.warning("moving");
        }
    }

    private static int counter = 0;

    @BeforeEach
    void setUp() {
        HAL.initialize(500, 0);
        DriverStationSim.setEnabled(true);
        DriverStationSim.setAutonomous(true);
        DriverStationSim.notifyNewData();
        CommandScheduler.getInstance().cancelAll();
    }

    @AfterEach
    void tearDown() {
        CommandScheduler.getInstance().cancelAll();
        CommandScheduler.getInstance().unregisterAllSubsystems();
    }

    private static void runUntilDone(Command command, int maxCycles) {
        for (int i = 0; i < maxCycles && command.isScheduled(); i++) {
            CommandScheduler.getInstance().run();
        }
    }

    @Test
    void scheduledDirectlyItWaitsForTheNewRequest() {
        Mechanism m = new Mechanism("Direct" + counter++, false);
        CommandScheduler.getInstance().run(); // the idle default reports OK
        Move move = new Move(3);

        Command command = m.runRequestUntilDone(() -> move);
        CommandScheduler.getInstance().schedule(command);
        runUntilDone(command, 20);

        assertFalse(command.isScheduled(), "it finishes once the move is done");
        assertEquals(3, move.runs, "the move ran until it said OK, not once");
    }

    @Test
    void insideASequenceItWaitsForTheNewRequest() {
        Mechanism m = new Mechanism("Sequence" + counter++, false);
        Move move = new Move(4);

        // An autonomous: something before it, as almost every routine has.
        Command auto = Commands.sequence(Commands.runOnce(() -> {}), m.runRequestUntilDone(() -> move));
        CommandScheduler.getInstance().schedule(auto);
        runUntilDone(auto, 20);

        assertFalse(auto.isScheduled());
        assertEquals(4, move.runs, "inside a sequence the previous Request's OK does not end it either");
    }

    @Test
    void aMoveThatIsDoneAtOnceFinishesAfterItsFirstRun() {
        Mechanism m = new Mechanism("Instant" + counter++, false);
        Move move = new Move(1);

        Command command = m.runRequestUntilDone(() -> move);
        CommandScheduler.getInstance().schedule(command);
        runUntilDone(command, 20);

        assertFalse(command.isScheduled());
        assertEquals(1, move.runs);
    }

    @Test
    void onAFallbackIoItFinishesAtOnce() {
        Mechanism m = new Mechanism("Fallback" + counter++, true);
        Move move = new Move(3);

        Command command = m.runRequestUntilDone(() -> move);
        CommandScheduler.getInstance().schedule(command);
        CommandScheduler.getInstance().run();

        assertFalse(command.isScheduled(), "no Request ever runs on a fallback IO: an auto must not hang on it");
        assertTrue(move.runs == 0);
    }
}
