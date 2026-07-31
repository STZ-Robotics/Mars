// Copyright (c) 2026 STZ Robotics
package com.stzteam.mars.utils;

import com.stzteam.mars.builder.Environment;
import com.stzteam.mars.builder.Environment.RunMode;
import com.stzteam.mars.diagnostics.AlertRegistry;

import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.Timer;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;

public class GCSConsole {
    
    // Paleta "Hacker Terminal" (Verde y Gris)
    private static final String RESET = "\u001b[0m";
    private static final String BOLD_GREEN = "\u001b[1;32m";
    private static final String GREEN = "\u001b[32m";
    private static final String GRAY = "\u001b[90m";
    private static final String BG_GREEN_BLACK_TEXT = "\u001b[1;30;42m"; // Para alertas críticas
    
    private static int moduleCount = 0;

    // Puente UDP para que funcione en Simulación (Windows/Mac)
    private static DatagramSocket simSocket;
    private static InetAddress localhost;

    // Evita hacer spam en consola si el bridge UDP falla repetidamente
    // (por ejemplo, si la extensión de simulación no está escuchando).
    private static boolean udpFailureLogged = false;

    public GCSConsole() {}

    /**
     * Envía datos crudos al bridge UDP de simulación de forma segura.
     * Si el envío falla, se registra el error una sola vez (no en cada ciclo)
     * para evitar saturar la consola con excepciones repetidas de red.
     *
     * @param data Los bytes a enviar por UDP.
     */
    private static void sendUdp(byte[] data) {
        if (simSocket == null || localhost == null) return;

        try {
            simSocket.send(new DatagramPacket(data, data.length, localhost, 6666));
            udpFailureLogged = false; // Se recuperó, permite loggear si vuelve a fallar
        } catch (Exception e) {
            if (!udpFailureLogged) {
                System.out.println(GRAY + "[GCSConsole] UDP bridge unavailable (¿extensión de sim no está escuchando?): "
                    + e.getMessage() + RESET);
                udpFailureLogged = true;
            }
        }
    }

    private static String format(String type, String tag, String message) {
        double time = Timer.getFPGATimestamp();
        
        // Estructura: [  12.345s] [INFO] [Core        ] Mensaje
        String formattedMsg = String.format("%s[%8.3fs]%s %s[%-4s]%s %s[%-12s]%s %s%s%s", 
            GRAY, time, RESET,
            BOLD_GREEN, type, RESET,
            GRAY, tag, RESET,
            GREEN, message, RESET);

        // Si estamos en simulación, obligamos a Java a enviarlo por UDP a la extensión
        sendUdp((formattedMsg + "\n").getBytes());

        return formattedMsg;
    }

    public static void bootSequence() {
        // Inicializar el socket si no es un robot real
        if (Environment.getMode() != RunMode.REAL) {
            try {
                simSocket = new DatagramSocket();
                localhost = InetAddress.getByName("127.0.0.1");
            } catch (Exception e) {}
        }

        long maxMemory = Runtime.getRuntime().maxMemory() / 1048576L;
        String targetOS = Environment.getMode() == RunMode.REAL ? "roboRIO (Hardware)" : "HAL Sim (Desktop)";
        
        System.out.println(BOLD_GREEN);
        System.out.println("=--------------------------------------------------------------=");
        System.out.println("=  MARS Ground Control Station           STZ Robotics          =");
        System.out.println("=--------------------------------------------------------------=");
        System.out.println(String.format("  Version : %-47s ", "2026.1.0"));
        System.out.println(String.format("  Target  : %-47s ", targetOS));
        System.out.println(String.format("  Memory  : %-47s ", maxMemory + " MB Allocated"));
        System.out.println("=--------------------------------------------------------------=" + RESET);
        
        // Enviamos el header manual a UDP si estamos en sim
        String header = BOLD_GREEN + "\n=--------------------------------------------------------------=\n" +
                        "=  MARS Ground Control Station           STZ Robotics          =\n" +
                        "=--------------------------------------------------------------=\n" + RESET;
        sendUdp(header.getBytes());

        logInfo("Core", "Booting sequence initiated...");
        enableCrashShield();
    }

    public static void registerModuleMount(String moduleName, boolean isFallback) {
        ++moduleCount;
        String mode = isFallback ? "FALLBACK" : "HARDWARE";
        logInfo("MOUNT", String.format("Mapped [%s] -> %s", mode, moduleName));
    }

    public static void printModuleSummary() {
        System.out.println(GRAY + "=--------------------------------------------------------------=" + RESET);
        logInfo("Core", "Successfully mounted " + moduleCount + " Hardware Modules.");
        System.out.println(GRAY + "=--------------------------------------------------------------=\n" + RESET);

        if (AlertRegistry.getInstance().hasCriticalAlerts()) {
            for (var alert : AlertRegistry.getInstance().getActiveAlerts()) {
                GCSConsole.logError(alert.subsystemName(), alert.status().message);
            }
        }
    }

    public static void logOK(String tag, String message) {
        if (!DriverStation.isFMSAttached()) System.out.println(format(" OK ", tag, message));
    }

    public static void logInfo(String tag, String message) {
        if (!DriverStation.isFMSAttached()) System.out.println(format("INFO", tag, message));
    }

    public static void logRequest(String moduleName, String requestName) {
        if (!DriverStation.isFMSAttached()) System.out.println(format("REQ ", moduleName, "Executing: " + requestName));
    }

    public static void logState(String moduleName, String stateName) {
        if (!DriverStation.isFMSAttached()) System.out.println(format("STAT", moduleName, "State -> " + stateName));
    }

    public static void logWarning(String tag, String message) {
        String msg = format("WARN", tag, message);
        System.out.println(msg);
        DriverStation.reportWarning(msg, false);
    }

    public static void logError(String tag, String message) {
        // En la terminal hacker, los errores invierten el color para llamar la atención
        String msg = format("FAIL", tag, BG_GREEN_BLACK_TEXT + " " + message + " " + RESET);
        System.out.println(msg);
        DriverStation.reportError(msg, false);
    }

    public static void logProgress(String tag, String task, double percent) {
        int barLength = 20;
        int filled = (int)((double)barLength * (Math.max(0.0, Math.min(100.0, percent)) / 100.0));
        StringBuilder bar = new StringBuilder("[");

        for(int i = 0; i < barLength; ++i) {
            if (i < filled) bar.append("=");
            else if (i == filled) bar.append(">");
            else bar.append(" ");
        }
        bar.append("]");
        
        String output = format("LOAD", tag, task + " " + bar.toString() + String.format(" %5.1f%%", percent));
        System.out.print("\r" + output);

        sendUdp(("\r" + output).getBytes());

        if (percent >= 100.0) {
            System.out.println();
            logOK(tag, task + " Complete.");
        }
    }

    public static void logDiagnosticTable(String title, String[] headers, String[][] rows) {
        if (!DriverStation.isFMSAttached()) {
            StringBuilder table = new StringBuilder();
            table.append("\n").append(GRAY).append("=== ").append(BOLD_GREEN).append(title.toUpperCase()).append(GRAY).append(" ===\n").append(RESET);
            
            StringBuilder headerLine = new StringBuilder(GRAY + " | " + RESET);
            for(String h : headers) {
                headerLine.append(String.format(BOLD_GREEN + "%-15s" + RESET + GRAY + " | " + RESET, h));
            }
            table.append(headerLine.toString()).append("\n");
            table.append(GRAY).append("-".repeat(headerLine.length() - 10)).append("\n").append(RESET);

            for(String[] row : rows) {
                StringBuilder rowLine = new StringBuilder(GRAY + " | " + RESET);
                for(String cell : row) {
                    rowLine.append(String.format(GREEN + "%-15s" + RESET + GRAY + " | " + RESET, cell != null ? cell : "-"));
                }
                table.append(rowLine.toString()).append("\n");
            }
            table.append("\n");

            System.out.print(table.toString());

            sendUdp(table.toString().getBytes());
        }
    }

    public static void enableCrashShield() {
        Thread.setDefaultUncaughtExceptionHandler((thread, exception) -> {
            System.out.println("\n" + BG_GREEN_BLACK_TEXT);
            System.out.println("=-------------------------------------------------------------=");
            System.out.println("=            [!] UNCAUGHT EXCEPTION - MARS FRAMEWORK [!]      =");
            System.out.println("=-------------------------------------------------------------=" + RESET);
            System.out.println(BOLD_GREEN + "  Thread : " + RESET + GREEN + thread.getName());
            System.out.println(BOLD_GREEN + "  Error  : " + RESET + GREEN + exception.toString());
            System.out.println(BOLD_GREEN + "  Trace  :" + RESET);
            
            StackTraceElement[] trace = exception.getStackTrace();
            for(int i = 0; i < Math.min(8, trace.length); ++i) {
                String line = trace[i].toString();
                if (!line.contains("stzteam") && !line.contains("frc.robot")) {
                    System.out.println("    -> " + GRAY + line + RESET);
                } else {
                    System.out.println("    -> " + BOLD_GREEN + line + RESET);
                }
            }
            System.out.println(GRAY + "-----------------------------------" + RESET);
            DriverStation.reportError("Unhandled exception in " + thread.getName() + ": " + exception.getMessage(), false);
        });
    }
}