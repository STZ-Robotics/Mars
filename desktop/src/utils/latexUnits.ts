// A shared map: UnitProcessor unit -> LaTeX notation (for react-katex).
// Used by ProjectVariablesPage (the NOTATION column) and by SubsystemWizardPage
// (the preview when annotating fields with @Unit).
export const LATEX_UNIT_MAP: Record<string, string> = {
  // --- Electrical ---
  Volts: "V",
  Millivolts: "mV",
  Amps: "A",
  Milliamps: "mA",
  Watts: "W",
  Kilowatts: "kW",
  Ohms: "\\Omega",
  Farads: "F",
  Henries: "H",
  Joules: "J",
  WattHours: "\\text{Wh}",
  DutyCycle: "\\frac{t_{\\text{on}}}{T} \\cdot 100\\%",

  // --- Angle ---
  Degrees: "^\\circ",
  Radians: "\\text{rad}",
  Rotations: "\\text{rev}",
  Revolutions: "\\text{rev}",
  Arcminutes: "'",
  Arcseconds: "''",
  Gradians: "\\text{grad}",

  // --- Angular velocity ---
  RPM: "\\frac{\\text{rev}}{\\text{min}}",
  RPS: "\\frac{\\text{rev}}{\\text{s}}",
  DegreesPerSecond: "\\frac{^\\circ}{\\text{s}}",
  RadiansPerSecond: "\\frac{\\text{rad}}{\\text{s}}",
  RotationsPerSecond: "\\frac{\\text{rev}}{\\text{s}}",

  // --- Angular acceleration ---
  DegreesPerSecondSquared: "\\frac{^\\circ}{\\text{s}^2}",
  RadiansPerSecondSquared: "\\frac{\\text{rad}}{\\text{s}^2}",
  RotationsPerSecondSquared: "\\frac{\\text{rev}}{\\text{s}^2}",

  // --- Length ---
  Meters: "m",
  Centimeters: "cm",
  Millimeters: "mm",
  Kilometers: "km",
  Inches: "\\text{in}",
  Feet: "\\text{ft}",
  Yards: "\\text{yd}",
  Miles: "\\text{mi}",

  // --- Linear velocity ---
  MetersPerSecond: "\\frac{m}{\\text{s}}",
  FeetPerSecond: "\\frac{\\text{ft}}{\\text{s}}",
  InchesPerSecond: "\\frac{\\text{in}}{\\text{s}}",
  MilesPerHour: "\\frac{\\text{mi}}{\\text{h}}",
  CentimetersPerSecond: "\\frac{\\text{cm}}{\\text{s}}",

  // --- Linear acceleration ---
  MetersPerSecondSquared: "\\frac{m}{\\text{s}^2}",
  FeetPerSecondSquared: "\\frac{\\text{ft}}{\\text{s}^2}",
  InchesPerSecondSquared: "\\frac{\\text{in}}{\\text{s}^2}",
  Gs: "g",

  // --- Time ---
  Seconds: "s",
  Milliseconds: "ms",
  Microseconds: "\\mu s",
  Minutes: "\\text{min}",
  Hours: "h",
  Hertz: "\\text{Hz}",
  Kilohertz: "\\text{kHz}",
  Megahertz: "\\text{MHz}",

  // --- Mass ---
  Kilograms: "kg",
  Grams: "g",
  Pounds: "\\text{lb}",
  Ounces: "\\text{oz}",
  Slugs: "\\text{slug}",

  // --- Force / Torque ---
  Newtons: "N",
  PoundsForce: "\\text{lbf}",
  NewtonMeters: "N \\cdot m",
  PoundFeet: "\\text{lb} \\cdot \\text{ft}",
  OunceInches: "\\text{oz} \\cdot \\text{in}",
  KilogramMetersSquared: "kg \\cdot m^2",

  // --- Pressure ---
  PSI: "\\text{psi}",
  Pascals: "\\text{Pa}",
  Kilopascals: "\\text{kPa}",
  Bar: "\\text{bar}",
  Atmospheres: "\\text{atm}",

  // --- Temperature ---
  Celsius: "^\\circ C",
  Fahrenheit: "^\\circ F",
  Kelvin: "K",

  // --- Control-loop specific (gains, feedforward units) ---
  RadiansPerSecondPerVolt: "\\frac{\\text{rad/s}}{V}",
  VoltsPerRadianPerSecond: "\\frac{V}{\\text{rad/s}}",
  VoltSecondsPerRadian: "\\frac{V \\cdot s}{\\text{rad}}",
  VoltSecondsSquaredPerRadian: "\\frac{V \\cdot s^2}{\\text{rad}}",
  VoltsPerMeterPerSecond: "\\frac{V}{\\text{m/s}}",
  VoltSecondsPerMeter: "\\frac{V \\cdot s}{m}",
  VoltSecondsSquaredPerMeter: "\\frac{V \\cdot s^2}{m}",

  // --- Dimensionless / misc ---
  Percent: "\\%",
  GearRatio: "\\text{:}1",
  Unitless: "\\text{—}",
  Ticks: "\\text{ticks}",
  Counts: "\\text{counts}",
}

export function toLatex(unit: string): string {
  if (!unit) return ""
  return LATEX_UNIT_MAP[unit] ?? `\\text{${unit}}`
}