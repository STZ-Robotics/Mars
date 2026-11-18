// The top half of the sidebar: the two applications, and what this project is.
//
// It answers the questions somebody asks before they start working -- is the
// dashboard installed, what team number is this, which run mode is the Manifest
// pinned to, which MARS am I compiling against, what is installed on top -- and
// every one of those answers is also a link to the file that decides it.

import * as vscode from 'vscode';
import { App, labelOf, locate } from '../launcher';
import { MarsProject } from '../project';
import { MarsModel } from '../scan/model';
import { RefreshableTree, TreeNode, group } from './tree';

/** Where each application was found, recomputed whenever the tree refreshes. */
type Locations = Partial<Record<App, string>>;

export class ProjectView extends RefreshableTree {
	private locations: Locations = {};

	constructor(
		private readonly projectOf: () => MarsProject | undefined,
		private readonly modelOf: () => MarsModel,
	) {
		super();
	}

	/** Re-checks the disk for the applications, then redraws. */
	async update(): Promise<void> {
		this.locations = {
			desktop: await locate('desktop'),
		};
		this.refresh();
	}

	protected roots(): TreeNode[] {
		const project = this.projectOf();
		return [
			group('Applications', this.applications(), 'symbol-function'),
			...(project ? this.projectSections(project) : []),
		];
	}

	private applications(): TreeNode[] {
		return (['desktop'] as const).map((app) => {
			const location = this.locations[app];
			return new TreeNode({
				label: labelOf(app),
				description: location ? 'installed' : 'not found',
				tooltip: location
					? new vscode.MarkdownString(`Click to launch.\n\n\`${location}\``)
					: 'Not installed, or not where the MARS installer puts it. Click for the download.',
				icon: new vscode.ThemeIcon(
					'dashboard',
					location ? undefined : new vscode.ThemeColor('disabledForeground'),
				),
				contextValue: `mars.app.${app}`,
				command: {
					command: 'mars.launchDesktop',
					title: `Launch ${labelOf(app)}`,
				},
			});
		});
	}

	private projectSections(project: MarsProject): TreeNode[] {
		const sections: TreeNode[] = [group('Project', this.identity(project), 'folder-opened')];

		if (project.features.length) {
			sections.push(group('Packages', project.features.map((feature) => new TreeNode({
				label: feature.name,
				description: `v${feature.version}`,
				tooltip: new vscode.MarkdownString(
					[
						`**${feature.name}** \`${feature.featureId}\``,
						feature.description ?? '',
						feature.author ? `_by ${feature.author}_` : '',
						feature.marsCoreRequired ? `Needs MARS core \`${feature.marsCoreRequired}\`` : '',
					].filter(Boolean).join('\n\n'),
				),
				icon: new vscode.ThemeIcon('package'),
				command: { command: 'vscode.open', title: 'Open descriptor', arguments: [feature.uri] },
			})), 'package'));
		}

		const flags = [...project.manifestFlags].map(([name, on]) => new TreeNode({
			label: name,
			description: on ? 'on' : 'off',
			icon: new vscode.ThemeIcon(on ? 'pass-filled' : 'circle-outline'),
			command: { command: 'mars.openManifest', title: 'Open the Manifest' },
		}));
		if (flags.length) { sections.push(group('Manifest flags', flags, 'settings', true)); }

		return sections;
	}

	private identity(project: MarsProject): TreeNode[] {
		const nodes: TreeNode[] = [
			new TreeNode({
				label: project.name,
				description: vscode.workspace.asRelativePath(project.root, false),
				icon: new vscode.ThemeIcon('symbol-function'),
				command: { command: 'revealFileInOS', title: 'Reveal', arguments: [project.root] },
			}),
		];

		const runMode = this.modelOf().runMode;
		if (runMode) {
			// The one line that decides whether Injector hands out real hardware
			// or simulated, so it is worth having in front of somebody's eyes.
			nodes.push(new TreeNode({
				label: 'Run mode',
				description: runMode.value,
				tooltip: 'Environment.setMode in Manifest.java. It decides what Injector.createIO hands out.',
				icon: new vscode.ThemeIcon(runMode.value === 'REAL' ? 'circuit-board' : 'debug-alt'),
				ref: runMode.ref,
			}));
		}

		if (project.teamNumber) {
			nodes.push(new TreeNode({
				label: 'Team',
				description: project.teamNumber,
				tooltip: 'From .wpilib/wpilib_preferences.json. MARS Desktop derives the roboRIO address from it.',
				icon: new vscode.ThemeIcon('organization'),
			}));
		}

		if (project.mars) {
			nodes.push(new TreeNode({
				label: 'MARS',
				description: `v${project.mars.version}`,
				tooltip: new vscode.MarkdownString(
					`The vendordep this project compiles against.\n\n\`${project.mars.jsonUrl ?? project.mars.uri.fsPath}\``,
				),
				icon: new vscode.ThemeIcon('versions'),
				command: { command: 'vscode.open', title: 'Open vendordep', arguments: [project.mars.uri] },
			}));
		}

		for (const dep of project.otherVendordeps) {
			nodes.push(new TreeNode({
				label: dep.name,
				description: `v${dep.version}`,
				icon: new vscode.ThemeIcon('library'),
				command: { command: 'vscode.open', title: 'Open vendordep', arguments: [dep.uri] },
			}));
		}

		if (project.hasProjectUnits) {
			nodes.push(new TreeNode({
				label: 'Project units',
				description: 'ProjectUnits.json',
				tooltip: 'The UnitProcessor is in use: generated code is unit-checked.',
				icon: new vscode.ThemeIcon('symbol-ruler'),
				command: {
					command: 'vscode.open',
					title: 'Open the units',
					arguments: [vscode.Uri.joinPath(project.root, 'ProjectUnits.json')],
				},
			}));
		}

		return nodes;
	}
}
