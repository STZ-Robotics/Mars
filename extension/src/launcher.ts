// Finding and starting MARS Desktop.
//
// The search follows what the installer does, because it has to: the installer
// is always per-user (never Program Files, never /opt, so a student can install
// on a lab machine without a password), and it records the folder it used --
// which the user may have changed -- in installation.json. The default folder
// is the fallback. The development build is looked for too: somebody working
// on this repository should not have to install the dashboard to launch it from
// the editor.
//
// The process is started and let go: it has its own window and its own life
// cycle, and closing the editor should not take a running dashboard down at a
// competition.
//
// There used to be a second application, the Simulation Studio. It is no
// longer distributed, and its command went with it.

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type App = 'desktop';

interface AppSpec {
	label: string;
	/** The setting that overrides the search entirely. */
	setting: string;
	/** An environment variable that points straight at the executable. */
	environment: string;
	/** Executable base name, without the platform extension. */
	binary: string;
	/** The app bundle the installer puts in the install folder on macOS. */
	macApp: string;
	/** Where a development build lands, relative to this repository's root. */
	devPaths: string[];
}

const APPS: Readonly<Record<App, AppSpec>> = {
	desktop: {
		label: 'MARS Desktop',
		setting: 'desktopPath',
		environment: 'MARS_DESKTOP',
		binary: 'mars-desktop',
		macApp: 'MARS Desktop.app',
		devPaths: [
			path.join('desktop', 'src-tauri', 'target', 'release'),
			path.join('desktop', 'src-tauri', 'target', 'debug'),
		],
	},
};

const RELEASES = 'https://github.com/STZ-Robotics/Mars/releases/latest';

function executableName(binary: string): string {
	return process.platform === 'win32' ? `${binary}.exe` : binary;
}

/** The folder the installer suggests, per platform. Never a system location. */
function defaultInstallDirectory(): string {
	const home = os.homedir();
	switch (process.platform) {
		case 'win32':
			// %LOCALAPPDATA%\Programs, where VS Code and Discord also live.
			return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'MARS');
		case 'darwin':
			return path.join(home, 'Applications', 'MARS');
		default:
			// ~/.local/share, as the XDG spec says.
			return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'MARS');
	}
}

/**
 * Where the installer keeps its record: Rust's `dirs::config_dir()` plus `MARS`,
 * the same folder MARS Desktop keeps its preferences in.
 */
function userDataDirectory(): string {
	const home = os.homedir();
	switch (process.platform) {
		case 'win32':
			return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'MARS');
		case 'darwin':
			return path.join(home, 'Library', 'Application Support', 'MARS');
		default:
			return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'MARS');
	}
}

/**
 * The install folder written in an installation record, or `undefined`.
 *
 * `carpeta` is the name the field had in the installer's first releases, whose
 * records are still on machines that installed then.
 */
export function installDirectoryFromRecord(text: string): string | undefined {
	try {
		const record = JSON.parse(text) as { dir?: unknown; carpeta?: unknown };
		const dir = record.dir ?? record.carpeta;
		return typeof dir === 'string' && dir.trim() ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** The folder MARS was actually installed in, from the installer's record. */
async function recordedInstallDirectory(): Promise<string | undefined> {
	for (const name of ['installation.json', 'instalacion.json']) {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(userDataDirectory(), name)));
			const dir = installDirectoryFromRecord(Buffer.from(bytes).toString('utf8'));
			if (dir) { return dir; }
		} catch {
			// No record under this name: try the next one.
		}
	}
	return undefined;
}

async function isFile(candidate: string): Promise<boolean> {
	try {
		const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
		return stat.type === vscode.FileType.File || stat.type === vscode.FileType.Directory;
	} catch {
		return false;
	}
}

/** Every folder from `start` up to the filesystem root. */
function ancestors(start: string): string[] {
	const out: string[] = [];
	let current = start;
	for (;;) {
		out.push(current);
		const parent = path.dirname(current);
		if (parent === current) { return out; }
		current = parent;
	}
}

/**
 * Where the application is, or `undefined`.
 *
 * Checked in the order somebody would expect to win: an explicit setting, the
 * environment variable, a development build in the repository the editor has
 * open, and finally the installed copy.
 */
export async function locate(app: App): Promise<string | undefined> {
	const spec = APPS[app];

	const configured = vscode.workspace.getConfiguration('mars').get<string>(spec.setting)?.trim();
	if (configured && await isFile(configured)) { return configured; }

	const fromEnvironment = process.env[spec.environment];
	if (fromEnvironment && await isFile(fromEnvironment)) { return fromEnvironment; }

	const exe = executableName(spec.binary);
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		for (const root of ancestors(folder.uri.fsPath)) {
			for (const relative of spec.devPaths) {
				const candidate = path.join(root, relative, exe);
				if (await isFile(candidate)) { return candidate; }
			}
		}
	}

	// Where the installer says it put MARS first: the user may have picked
	// another folder than the one it suggests.
	const recorded = await recordedInstallDirectory();
	const folders = [...new Set([recorded, defaultInstallDirectory()].filter((d): d is string => !!d))];
	for (const folder of folders) {
		// On macOS an app bundle, which `open` takes as a path and every other
		// platform's spawn would choke on (isFile accepts the bundle's folder).
		if (process.platform === 'darwin') {
			const bundle = path.join(folder, spec.macApp);
			if (await isFile(bundle)) { return bundle; }
		}
		const installed = path.join(folder, exe);
		if (await isFile(installed)) { return installed; }
	}
	return undefined;
}

/**
 * Starts the application, detached, and reports whether it went.
 *
 * The failure this actually has to handle well is "it is not installed": the
 * useful answer there is the installer, not an error code, so that is what the
 * message offers.
 */
export async function launch(app: App): Promise<boolean> {
	const spec = APPS[app];
	const location = await locate(app);

	if (!location) {
		const download = 'Download MARS';
		const setPath = 'Set the path';
		const choice = await vscode.window.showWarningMessage(
			`${spec.label} is not installed, or not where MARS installs it.`,
			download,
			setPath,
		);
		if (choice === download) {
			await vscode.env.openExternal(vscode.Uri.parse(RELEASES));
		} else if (choice === setPath) {
			await vscode.commands.executeCommand('workbench.action.openSettings', `mars.${spec.setting}`);
		}
		return false;
	}

	try {
		const child = location.endsWith('.app')
			? spawn('open', ['-a', location], { detached: true, stdio: 'ignore' })
			: spawn(location, [], { detached: true, stdio: 'ignore', cwd: path.dirname(location) });
		child.unref();
		return true;
	} catch (error) {
		await vscode.window.showErrorMessage(`Could not start ${spec.label}: ${String(error)}`);
		return false;
	}
}

export function labelOf(app: App): string {
	return APPS[app].label;
}
