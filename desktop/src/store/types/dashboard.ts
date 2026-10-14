import type { FieldOrientation } from "./field2d"

// Constants of the Dashboard canvas (Display page).
// GRID_CELL = size in px of a grid cell.
// MIN_WIDGET_W / MIN_WIDGET_H = minimum size (in cells) a widget can be shrunk
// to when resizing it with the mouse.
export const GRID_CELL = 48
export const MIN_WIDGET_W = 3
export const MIN_WIDGET_H = 3

// A Dashboard widget
export interface DashboardWidget {
  id: string           // unique ID for React (e.g. Date.now)
  topicName: string     // the variable's path
  topicType: string
  label: string          // editable name
  style: string          // "Simple", "Box", "Custom", etc.
  customTrue?: string
  customFalse?: string
  min?: number
  max?: number
  unit?: string           // shown unit: a free suffix on doubles, "deg"/"rad" on Rotation2d
  width: number          // width in grid cells
  height: number         // height in grid cells
  x: number              // X position in grid cells
  y: number              // Y position in grid cells

  // When the widget comes from dragging a single index of a struct:X[]
  // (e.g. ModulePositions[2]) instead of the whole array. topicName/topicType
  // are still the array's; this only says which slice to show.
  arrayIndex?: number

  // --- Match Time ---
  matchTimeMode?: "mmss" | "seconds"   // display format (default "mmss")
  matchTimeYellow?: number             // seconds from which it turns yellow (default 30)
  matchTimeRed?: number                // seconds from which it turns red (default 15)

  // --- Graph ---
  graphTimeDisplayed?: number   // time window shown, in seconds (default 5)
  graphColor?: string           // line color in hex (default mars-accent)
  graphLineWidth?: number       // line width in px (default 2)
  graphAutoRange?: boolean      // whether the Y axis autoscales with the data (default true)
  graphMin?: number             // fixed Y range (only if graphAutoRange = false)
  graphMax?: number             // fixed Y range (only if graphAutoRange = false)

  // --- Radial Gauge ---
  gaugeStartAngle?: number      // degrees, CW+ (default -140)
  gaugeEndAngle?: number        // degrees, CW+ (default 140)
  gaugeMin?: number             // default 0
  gaugeMax?: number             // default 100
  gaugeNumberOfLabels?: number  // default 8
  gaugeWrapValue?: boolean      // wraps the value into the range, useful for gyros (default false)
  gaugeShowPointer?: boolean    // shows the needle (default true)
  gaugeShowTicks?: boolean      // shows the ticks/labels (default true)

  // --- Field2d ---
  // A Field2d widget's topicName is a TABLE PATH, not a topic: a Field2d's
  // root does not exist as a topic, only its children.
  fieldKey?: string                       // field with an image (default: the first installed)
  fieldCoordinateSystem?: string          // "wall_blue" | "center" | "center_rotated"
  fieldOrientation?: FieldOrientation     // on-screen rotation (default 0)
  fieldRobotSize?: number                 // chassis LENGTH in meters (default 0.85)
  fieldRobotWidth?: number                // chassis WIDTH in meters (default: the length)
  fieldShowGrid?: boolean                 // 1 m grid over the field (default false)
  fieldAllianceFlip?: boolean             // view from the red alliance (default false)
  fieldTrailSeconds?: number              // robot trail in seconds (default 0)

  // --- Voltage View ---
  voltageMin?: number           // default 4
  voltageMax?: number           // default 13
  voltageDivisions?: number     // default 5
  voltageInverted?: boolean     // default false
  voltageOrientation?: "horizontal" | "vertical"  // default "horizontal"
}
