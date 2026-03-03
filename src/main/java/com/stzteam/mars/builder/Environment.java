package com.stzteam.mars.builder;

public class Environment {

    public static enum RunMode {
    REAL,SIM,REPLAY
    }
    
    private static RunMode currentMode = RunMode.REAL;

    public static void setMode(RunMode mode) {
        currentMode = mode;
    }

    public static RunMode getMode() {
        return currentMode;
    }
    
}
