package com.stzteam.mars.utils;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;

import com.stzteam.mars.builder.Environment;
import com.stzteam.mars.builder.Environment.RunMode;
import com.stzteam.mars.generated.MarsConstants;
import com.stzteam.mars.models.singlemodule.ModularSubsystem;
import com.stzteam.mars.requests.Request;

import edu.wpi.first.networktables.BooleanSubscriber;
import edu.wpi.first.networktables.NetworkTable;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.networktables.StringPublisher;
import edu.wpi.first.networktables.StringSubscriber;
import edu.wpi.first.networktables.TimestampedBoolean;
import edu.wpi.first.networktables.TimestampedString;

/**
 * The Ground Control Station (GCS) Terminal manager for the MARS framework.
 * <p>
 * This utility class handles bidirectional communication between the robot and an external 
 * dashboard/app via WPILib NetworkTables. It manages logging, exposes the hardware tree 
 * (mounted modules), and allows the external app to forcefully inject and run {@link Request}s 
 * on specific subsystems.
 */
public class TerminalGCS {
    
    private static int moduleCount = 0;
    
    /** Tracks which modules are mounted and whether they are using Fallback IO (true) or Real IO (false). */
    private static final Map<String, Boolean> mountedModules = new LinkedHashMap<>(); 
    
    /** Maps a module's name to a simple list of its available request names (used for queries). */
    private static final Map<String, List<String>> moduleRequestsMap = new HashMap<>();

    /** Holds active references to instantiated subsystems to allow remote request injection. */
    private static final Map<String, ModularSubsystem<?, ?>> activeSubsystems = new HashMap<>();
    
    /** Stores the actual Request objects, mapped by module name and then by request name. */
    private static final Map<String, Map<String, Request<?, ?>>> registeredRequests = new HashMap<>();

    // NetworkTable Publishers and Subscribers
    private static StringPublisher marsConsoleStream;
    private static BooleanSubscriber syncSubscriber; 
    private static StringSubscriber requestQuerySubscriber;
    private static StringSubscriber runRequestSubscriber;
    
    /** A thread-safe queue buffering outgoing log messages to prevent network flooding. */
    private static final Queue<String> logQueue = new ConcurrentLinkedQueue<>();
    private static int tickCounter = 0;

    /**
     * Initializes the NetworkTables topics for the GCS communication.
     * This must be called early during the robot's boot sequence.
     */
    public static void initNetworkStream() {
        NetworkTable marsTable = NetworkTableInstance.getDefault().getTable("MARS_GCS");
        marsConsoleStream = marsTable.getStringTopic("ConsoleLog").publish();
        
        syncSubscriber = marsTable.getBooleanTopic("Sync").subscribe(false);
        requestQuerySubscriber = marsTable.getStringTopic("GetRequests").subscribe("");
        
        runRequestSubscriber = marsTable.getStringTopic("RunRequest").subscribe("");
    }

    /**
     * The main processing loop for the terminal.
     * Evaluates incoming commands from the dashboard (syncs, queries, overrides) 
     * and periodically flushes the log queue to NetworkTables.
     */
    public static void updatePeriodic() {
        if (NetworkTableInstance.getDefault().getConnections().length == 0) return; 

        // Handle Sync requests (Dashboard asking for the current hardware tree)
        TimestampedBoolean[] syncRequests = syncSubscriber.readQueue();
        if (syncRequests.length > 0) {
            broadcast("INFO", "SYS", "Sync request received. Re-broadcasting hardware tree...");
            for (Map.Entry<String, Boolean> entry : mountedModules.entrySet()) {
                String tag = entry.getValue() ? "Fallback" : "Hardware";
                broadcast("MOUNT", tag, entry.getKey());
            }
            printModuleSummary();
        }

        // Handle Query requests (Dashboard asking what requests a specific module can run)
        TimestampedString[] queries = requestQuerySubscriber.readQueue();
        for (TimestampedString ts : queries) {
            String targetModule = ts.value;
            if (!targetModule.isEmpty()) {
                String foundKey = getModuleKeyIgnoreCase(targetModule);
                if (foundKey != null) {
                    String reqList = String.join(", ", moduleRequestsMap.get(foundKey));
                    broadcast("INFO", foundKey, "Available Requests: [ " + reqList + " ]");
                } else {
                    broadcast("WARN", "SYS", "Module '" + targetModule + "' not found.");
                }
            }
        }

        // Handle Execution commands (Dashboard commanding a module to run a specific request)
        TimestampedString[] runCommands = runRequestSubscriber.readQueue();
        for (TimestampedString ts : runCommands) {
            String payload = ts.value;
            if (payload.contains(":")) {
                String[] parts = payload.split(":");
                executeRemoteRequest(parts[0].trim(), parts[1].trim());
            }
        }

        // Throttle log publishing to NetworkTables (1 log per 5 ticks ~ 100ms)
        tickCounter++;
        if (tickCounter >= 5) {
            if (!logQueue.isEmpty()) marsConsoleStream.set(logQueue.poll()); 
            tickCounter = 0; 
        }
    }

    /**
     * Attempts to forcefully inject and execute a request on a specific subsystem.
     * Called when the external app sends a 'RunRequest' command.
     *
     * @param module  The target module's name.
     * @param reqName The name of the request to execute.
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static void executeRemoteRequest(String module, String reqName) {
        String modKey = getModuleKeyIgnoreCase(module);
        
        if (modKey != null && activeSubsystems.containsKey(modKey) && registeredRequests.containsKey(modKey)) {
            ModularSubsystem sub = activeSubsystems.get(modKey);
            
            Request requestObj = null;
            String actualReqName = reqName;
            
            for (Map.Entry<String, Request<?, ?>> entry : registeredRequests.get(modKey).entrySet()) {
                if (entry.getKey().equalsIgnoreCase(reqName)) {
                    requestObj = entry.getValue();
                    actualReqName = entry.getKey();
                    break;
                }
            }

            if (requestObj != null) {
                sub.setRequest(requestObj);
                broadcast("REQUEST", sub.getName(), "GCS Override: Forced [" + actualReqName + "]");
            } else {
                broadcast("WARN", sub.getName(), "Request '" + reqName + "' not registered in this module.");
            }
        } else {
            broadcast("WARN", "SYS", "Cannot run request on '" + module + "'. Module not found.");
        }
    }

    /**
     * Helper to find a module's exact key case-insensitively.
     */
    private static String getModuleKeyIgnoreCase(String target) {
        for (String key : moduleRequestsMap.keySet()) {
            if (key.equalsIgnoreCase(target)) return key;
        }
        return null;
    }

    /**
     * Formats and queues a message to be sent to the GCS dashboard.
     * Messages are formatted as JSON strings for easy parsing by the external app.
     *
     * @param type    The severity or category of the log (e.g., INFO, WARN, BOOT).
     * @param tag     The source of the log (usually the module name).
     * @param message The actual log content.
     */
    private static void broadcast(String type, String tag, String message) {
        String timestamp = Instant.now().toString();
        String safeMessage = message.replace("\"", "\\\""); 
        logQueue.add(String.format("{\"time\":\"%s\", \"type\":\"%s\", \"tag\":\"%s\", \"msg\":\"%s\"}", timestamp, type, tag, safeMessage));
    }

    /**
     * Logs the initial startup sequence and configuration of the framework.
     */
    public static void bootSequence() {
        broadcast("BOOT", "Core", "MARS Framework Starting...");
        broadcast("VERSION", "MARS", "Currently running on: " + MarsConstants.MARS_VERSION);
        broadcast("INFO", "RobotMode", "Actuators on: " + (Environment.getMode() == RunMode.REAL ? "RealIO" : "SimIO"));
    }

    /**
     * Registers a module's instantiation into the terminal's hardware tree.
     *
     * @param moduleName The name of the subsystem.
     * @param isFallback True if the module is running dummy IO, false if real hardware.
     */
    public static void registerModuleMount(String moduleName, boolean isFallback) {
        if (!mountedModules.containsKey(moduleName)) {
            mountedModules.put(moduleName, isFallback);
            moduleCount++;
        }
        broadcast("MOUNT", isFallback ? "Fallback" : "Hardware", moduleName);
    }
    
    /**
     * Stores a reference to an active subsystem to allow remote request injection.
     */
    public static void registerSubsystem(ModularSubsystem<?, ?> subsystem) {
        activeSubsystems.put(subsystem.getName(), subsystem);
    }

    /**
     * Registers a specific Request object so that it can be triggered remotely via the GCS app.
     *
     * @param moduleName The target module.
     * @param reqName    The string identifier for the request.
     * @param requestObj The actual Request instance to execute.
     */
    public static void registerRemoteRequest(String moduleName, String reqName, Request<?, ?> requestObj) {
        registeredRequests.computeIfAbsent(moduleName, k -> new HashMap<>()).put(reqName, requestObj);
        
        moduleRequestsMap.computeIfAbsent(moduleName, k -> new ArrayList<>());
        if (!moduleRequestsMap.get(moduleName).contains(reqName)) {
            moduleRequestsMap.get(moduleName).add(reqName);
        }
    }

    /**
     * Logs the final count of mounted hardware modules after initialization.
     */
    public static void printModuleSummary() {
        broadcast("INFO", "Core", "Successfully mounted " + moduleCount + " Hardware Modules.");
        broadcast("OK", "Robot", "Startup complete.");
    }

    // --- Standard Logging Utility Methods ---

    public static void logOK(String tag, String message){ broadcast("OK", tag, message);}
    public static void logInfo(String tag, String message) { broadcast("INFO", tag, message); }
    public static void logWarning(String tag, String message) { broadcast("WARN", tag, message); }
    public static void logError(String tag, String message) { broadcast("FATAL", tag, message); }
    public static void logRequest(String moduleName, String requestName) { broadcast("REQUEST", moduleName, requestName); }
    public static void logState(String moduleName, String stateName) { broadcast("STATE", moduleName, stateName); }
}