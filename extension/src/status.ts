// The status bar entry.
//
// It carries the one fact that is expensive to be wrong about and invisible
// everywhere else: which run mode the Manifest is pinned to. A project left in
// SIM looks exactly like a project in REAL until the robot is enabled and
// nothing moves, and by then somebody is on the field.

import * as vscode from 'vscode';
import { MarsWorkspace } from './project';

export class MarsStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;

	constructor(private readonly workspace: MarsWorkspace) {
		this.item = vscode.window.createStatusBarItem('mars.status', vscode.StatusBarAlignment.Left, 100);
		this.item.name = 'MARS';
		this.item.command = 'mars.focusSidebar';
		workspace.onDidChange(() => this.update());
		this.update();
	}

	update(): void {
		const project = this.workspace.project;
		if (!project) {
			this.item.hide();
			return;
		}

		const model = this.workspace.model;
		const mode = model.runMode?.value;
		const version = project.mars ? ` ${project.mars.version}` : '';

		this.item.text = `$(symbol-function) MARS${version}${mode ? ` · ${mode}` : ''}`;

		// Only a non-REAL mode gets the warning colour. Colouring the normal case
		// would make the bar shout permanently, and then it stops being a signal.
		this.item.backgroundColor = mode && mode !== 'REAL'
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: undefined;

		const counts = [
			[model.subsystems.length, 'subsystem'],
			[model.requests.length, 'request'],
			[model.subsystems.reduce((n, s) => n + s.topics.length, 0), 'topic'],
		] as const;

		this.item.tooltip = new vscode.MarkdownString([
			`**${project.name}**${project.teamNumber ? ` · team ${project.teamNumber}` : ''}`,
			project.mars ? `MARS vendordep \`${project.mars.version}\`` : '_no Mars vendordep_',
			mode
				? mode === 'REAL'
					? 'Run mode `REAL`'
					: `Run mode \`${mode}\` — the robot will not drive real hardware`
				: '',
			counts
				.filter(([n]) => n > 0)
				.map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`)
				.join(' · '),
			'',
			'Click to open the MARS sidebar.',
		].filter(Boolean).join('\n\n'));

		this.item.show();
	}

	dispose(): void { this.item.dispose(); }
}
