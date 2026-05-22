package com.stzteam.mars.utils;

import com.stzteam.mars.generated.MarsConstants;
import com.stzteam.mars.builder.Environment;
import com.stzteam.mars.builder.Environment.RunMode;

import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.Timer;

/**
 * The Ultimate Ground Control Station (GCS) Console for the MARS framework.
 * Features ANSI colors, Unicode box-drawing, dynamic diagnostic tables, 
 * FMS-aware stealth mode, and an intelligent Exception Interceptor.
 */
public class GCSConsole {
    
    private static final String RESET  = "\u001B[0m";
    private static final String BOLD   = "\u001B[1m";
    private static final String GREEN  = "\u001B[32m";
    private static final String CYAN   = "\u001B[36m";
    private static final String PURPLE = "\u001B[35m";
    private static final String YELLOW = "\u001B[33m";
    private static final String RED    = "\u001B[31m";
    private static final String GRAY   = "\u001B[90m";

    private static int moduleCount = 0;

    private static String format(String color, String type, String tag, String message) {
        double time = Timer.getFPGATimestamp();
        // [ 12.345s] [INFO] [Core        ] Mensaje
        return String.format("%s[%8.3fs] [%-4s] [%-12s]%s %s%s", 
            GRAY, time, color + BOLD + type + GRAY, tag, RESET, color + message, RESET);
    }

    public static void bootSequence() {
        long maxMemory = Runtime.getRuntime().maxMemory() / (1024 * 1024);
        String targetOS = Environment.getMode() == RunMode.REAL ? "roboRIO (Hardware)" : "HAL Sim (Desktop)";
        
        System.out.println(CYAN + BOLD);
        System.out.println("=--------------------------------------------------------------=");
        System.out.println("=  MARS Ground Control Station           STZ Robotics        =");
        System.out.println("=--------------------------------------------------------------=");
        System.out.println(String.format("  Version : %-47s ", MarsConstants.MARS_VERSION));
        System.out.println(String.format("  Target  : %-47s ", targetOS));
        System.out.println(String.format("  Memory  : %-47s ", maxMemory + " MB Allocated"));
        System.out.println("=--------------------------------------------------------------=");
        System.out.println(RESET);
        
        logInfo("Core", "Booting sequence initiated...");
        enableCrashShield();
    }

    public static void registerModuleMount(String moduleName, boolean isFallback) {
        moduleCount++;
        String mode = isFallback ? "FALLBACK" : "HARDWARE";
        logInfo("MOUNT", String.format("Mapped [%s] -> %s", mode, moduleName));
    }

    public static void printModuleSummary() {
        System.out.println(GRAY + "=--------------------------------------------------------------=" + RESET);
        logInfo("Core", "Successfully mounted " + moduleCount + " Hardware Modules.");
        logOK("Robot", BOLD + "Startup complete. Systems ready for ENABLE." + RESET);
        System.out.println(GRAY + "=--------------------------------------------------------------=\n" + RESET);
    }

    public static void logOK(String tag, String message) {
        if (DriverStation.isFMSAttached()) return;
        System.out.println(format(GREEN, " OK ", tag, message)); 
    }

    public static void logInfo(String tag, String message) {
        if (DriverStation.isFMSAttached()) return;
        System.out.println(format(CYAN, "INFO", tag, message));
    }

    public static void logRequest(String moduleName, String requestName) {
        if (DriverStation.isFMSAttached()) return;
        System.out.println(format(PURPLE, "REQ ", moduleName, "Executing: " + requestName));
    }

    public static void logState(String moduleName, String stateName) {
        if (DriverStation.isFMSAttached()) return;
        System.out.println(format(RESET, "STAT", moduleName, "State -> " + stateName));
    }

    public static void logWarning(String tag, String message) {
        String msg = format(YELLOW, "WARN", tag, message);
        System.out.println(msg);
        DriverStation.reportWarning(msg, false); 
    }

    public static void logError(String tag, String message) {
        String msg = format(RED, "FAIL", tag, message);
        System.out.println(msg);
        DriverStation.reportError(msg, false); 
    }

    public static void logProgress(String tag, String task, double percent) {
        int barLength = 20;
        int filled = (int) (barLength * (Math.max(0, Math.min(100, percent)) / 100.0));
        
        StringBuilder bar = new StringBuilder("[");
        for (int i = 0; i < barLength; i++) {
            if (i < filled) bar.append("=");
            else if (i == filled) bar.append(">");
            else bar.append(" ");
        }
        bar.append("]");

        System.out.print("\r" + format(CYAN, "LOAD", tag, task + " " + bar.toString() + String.format(" %5.1f%%", percent)));
        
        if (percent >= 100.0) {
            System.out.println();
            logOK(tag, task + " Complete.");
        }
    }

    public static void logDiagnosticTable(String title, String[] headers, String[][] rows) {
        if (DriverStation.isFMSAttached()) return;
        
        System.out.println("\n" + CYAN + "=== " + BOLD + title.toUpperCase() + RESET + CYAN + " ===" + RESET);
        
        StringBuilder headerLine = new StringBuilder(GRAY + " | " + RESET);
        for (String h : headers) headerLine.append(String.format(BOLD + "%-15s" + RESET + GRAY + " | " + RESET, h));
        System.out.println(headerLine.toString());
        
        System.out.println(GRAY + "-".repeat(headerLine.length() - 10) + RESET);
        
        for (String[] row : rows) {
            StringBuilder rowLine = new StringBuilder(GRAY + " | " + RESET);
            for (String cell : row) rowLine.append(String.format("%-15s" + GRAY + " | " + RESET, cell != null ? cell : "-"));
            System.out.println(rowLine.toString());
        }
        System.out.println();
    }

    public static void enableCrashShield() {
        Thread.setDefaultUncaughtExceptionHandler((thread, exception) -> {
            System.out.println("\n\u001B[41m\u001B[37m" + BOLD);
            System.out.println("=-------------------------------------------------------------=");
            System.out.println("=            [!] UNCAUGHT EXCEPTION - MARS FRAMEWORK [!]      =");
            System.out.println("  =--------------------------------------------------------------=" + RESET);
            System.out.println(RED + "  Thread : " + RESET + thread.getName());
            System.out.println(RED + "  Error  : " + RESET + exception.toString());
            System.out.println(RED + "  Trace  :" + RESET);
            
            StackTraceElement[] trace = exception.getStackTrace();
            for (int i = 0; i < Math.min(8, trace.length); i++) {
                String line = trace[i].toString();

                if (line.contains("stzteam") || line.contains("frc.robot")) {
                    System.out.println("    -> " + YELLOW + BOLD + line + RESET);
                } else {

                    System.out.println("    -> " + GRAY + line + RESET);
                }
            }
            
            System.out.println(RED + "-----------------------------------" + RESET);
            
            DriverStation.reportError("Unhandled exception in " + thread.getName() + ": " + exception.getMessage(), false);
        });
    }
}