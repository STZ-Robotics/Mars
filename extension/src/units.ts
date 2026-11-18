// The vocabulary `@Unit(value = "...")` accepts.
//
// The UnitProcessor checks units at build time against a fixed list, so a name
// outside it is a compile error the editor can prevent by offering only these.
// Grouped by category, which is what the completion list shows beside each one.

export interface UnitName {
	name: string;
	category: string;
}

export const UNITS: readonly UnitName[] = [
	// Electrical
	{ name: 'Volts', category: 'Electrical' },
	{ name: 'Millivolts', category: 'Electrical' },
	{ name: 'Amps', category: 'Electrical' },
	{ name: 'Milliamps', category: 'Electrical' },
	{ name: 'Watts', category: 'Electrical' },
	{ name: 'Kilowatts', category: 'Electrical' },
	{ name: 'Ohms', category: 'Electrical' },
	{ name: 'Farads', category: 'Electrical' },
	{ name: 'Henries', category: 'Electrical' },
	{ name: 'Joules', category: 'Electrical' },
	{ name: 'WattHours', category: 'Electrical' },
	{ name: 'DutyCycle', category: 'Electrical' },
	// Angle
	{ name: 'Degrees', category: 'Angle' },
	{ name: 'Radians', category: 'Angle' },
	{ name: 'Rotations', category: 'Angle' },
	{ name: 'Revolutions', category: 'Angle' },
	{ name: 'Arcminutes', category: 'Angle' },
	{ name: 'Arcseconds', category: 'Angle' },
	{ name: 'Gradians', category: 'Angle' },
	// Angular velocity
	{ name: 'RPM', category: 'Angular velocity' },
	{ name: 'RPS', category: 'Angular velocity' },
	{ name: 'DegreesPerSecond', category: 'Angular velocity' },
	{ name: 'RadiansPerSecond', category: 'Angular velocity' },
	{ name: 'RotationsPerSecond', category: 'Angular velocity' },
	// Angular acceleration
	{ name: 'DegreesPerSecondSquared', category: 'Angular acceleration' },
	{ name: 'RadiansPerSecondSquared', category: 'Angular acceleration' },
	{ name: 'RotationsPerSecondSquared', category: 'Angular acceleration' },
	// Length
	{ name: 'Meters', category: 'Length' },
	{ name: 'Centimeters', category: 'Length' },
	{ name: 'Millimeters', category: 'Length' },
	{ name: 'Kilometers', category: 'Length' },
	{ name: 'Inches', category: 'Length' },
	{ name: 'Feet', category: 'Length' },
	{ name: 'Yards', category: 'Length' },
	{ name: 'Miles', category: 'Length' },
	// Linear velocity
	{ name: 'MetersPerSecond', category: 'Linear velocity' },
	{ name: 'FeetPerSecond', category: 'Linear velocity' },
	{ name: 'InchesPerSecond', category: 'Linear velocity' },
	{ name: 'MilesPerHour', category: 'Linear velocity' },
	{ name: 'CentimetersPerSecond', category: 'Linear velocity' },
	// Linear acceleration
	{ name: 'MetersPerSecondSquared', category: 'Linear acceleration' },
	{ name: 'FeetPerSecondSquared', category: 'Linear acceleration' },
	{ name: 'InchesPerSecondSquared', category: 'Linear acceleration' },
	{ name: 'Gs', category: 'Linear acceleration' },
	// Time
	{ name: 'Seconds', category: 'Time' },
	{ name: 'Milliseconds', category: 'Time' },
	{ name: 'Microseconds', category: 'Time' },
	{ name: 'Minutes', category: 'Time' },
	{ name: 'Hours', category: 'Time' },
	{ name: 'Hertz', category: 'Time' },
	{ name: 'Kilohertz', category: 'Time' },
	{ name: 'Megahertz', category: 'Time' },
	// Mass
	{ name: 'Kilograms', category: 'Mass' },
	{ name: 'Grams', category: 'Mass' },
	{ name: 'Pounds', category: 'Mass' },
	{ name: 'Ounces', category: 'Mass' },
	{ name: 'Slugs', category: 'Mass' },
	// Force / Torque
	{ name: 'Newtons', category: 'Force / Torque' },
	{ name: 'PoundsForce', category: 'Force / Torque' },
	{ name: 'NewtonMeters', category: 'Force / Torque' },
	{ name: 'PoundFeet', category: 'Force / Torque' },
	{ name: 'OunceInches', category: 'Force / Torque' },
	{ name: 'KilogramMetersSquared', category: 'Force / Torque' },
	// Pressure
	{ name: 'PSI', category: 'Pressure' },
	{ name: 'Pascals', category: 'Pressure' },
	{ name: 'Kilopascals', category: 'Pressure' },
	{ name: 'Bar', category: 'Pressure' },
	{ name: 'Atmospheres', category: 'Pressure' },
	// Temperature
	{ name: 'Celsius', category: 'Temperature' },
	{ name: 'Fahrenheit', category: 'Temperature' },
	{ name: 'Kelvin', category: 'Temperature' },
	// Control-loop
	{ name: 'RadiansPerSecondPerVolt', category: 'Control-loop' },
	{ name: 'VoltsPerRadianPerSecond', category: 'Control-loop' },
	{ name: 'VoltSecondsPerRadian', category: 'Control-loop' },
	{ name: 'VoltSecondsSquaredPerRadian', category: 'Control-loop' },
	{ name: 'VoltsPerMeterPerSecond', category: 'Control-loop' },
	{ name: 'VoltSecondsPerMeter', category: 'Control-loop' },
	{ name: 'VoltSecondsSquaredPerMeter', category: 'Control-loop' },
	// Dimensionless
	{ name: 'Percent', category: 'Dimensionless' },
	{ name: 'GearRatio', category: 'Dimensionless' },
	{ name: 'Unitless', category: 'Dimensionless' },
	{ name: 'Ticks', category: 'Dimensionless' },
	{ name: 'Counts', category: 'Dimensionless' },
];
