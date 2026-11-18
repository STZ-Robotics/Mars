// Activation: build the one store everything reads from, then hang the views,
// the language features and the commands off it.
//
// Everything here is downstream of `MarsWorkspace`. It owns the scanned model
// and fires one event when it changes; the trees redraw, the lenses refresh and
// the diagnostics are republished from that single signal. Nothing else scans,
// and nothing keeps a second copy of the model.

import * as vscode from 'vscode';
import { MarsCodeActionProvider, renameTable } from './codeactions';
import { MarsCodeLensProvider, PickTarget } from './codelens';
import { publishDiagnostics } from './diagnostics';
import { MarsCompletionProvider, MarsHoverProvider } from './language';
import { launch } from './launcher';
import { LiveNetworkTables } from './nt/live';
import { MarsWorkspace } from './project';
import { SourceRef } from './scan/model';
import { MarsStatusBar } from './status';
import { ArchitectureView } from './views/architectureView';
import { ProjectView } from './views/projectView';
import { REVEAL_COMMAND, reveal } from './views/tree';

const JAVA: vscode.DocumentSelector = { language: 'java', scheme: 'file' };

/**
 * What `activate` hands back.
 *
 * It exists for the integration tests, which otherwise have no way to see the
 * model the extension built: the trees and the diagnostics are the only visible
 * output, and asserting on a tree through the VS Code API is a test of the tree
 * widget rather than of the scan behind it.
 */
export interface MarsApi {
	workspace: MarsWorkspace;
	live: LiveNetworkTables;
}

export function activate(context: vscode.ExtensionContext): MarsApi {
	const workspace = new MarsWorkspace();
	context.subscriptions.push(workspace);

	const live = new LiveNetworkTables(workspace);
	const projectView = new ProjectView(() => workspace.project, () => workspace.model);
	const architectureView = new ArchitectureView(() => workspace.model, live);
	const status = new MarsStatusBar(workspace);
	const diagnostics = vscode.languages.createDiagnosticCollection('mars');

	context.subscriptions.push(
		live,
		status,
		diagnostics,
		vscode.window.createTreeView('mars.projectView', { treeDataProvider: projectView }),
		vscode.window.createTreeView('mars.architectureView', { treeDataProvider: architectureView }),
	);

	// One subscription drives everything that depends on the model.
	context.subscriptions.push(workspace.onDidChange(() => {
		void projectView.update();
		architectureView.refresh();
		void publishDiagnostics(diagnostics, workspace.model, workspace.project);
		// The welcome view and the menu entries key off this, so a folder that
		// stops being a MARS project stops offering MARS things to do.
		void vscode.commands.executeCommand('setContext', 'mars.hasProject', Boolean(workspace.project));
	}));

	// Live values change far more often than the model, and only the tree and the
	// lenses show them; the diagnostics and the project view do not care.
	context.subscriptions.push(live.onDidChange(() => {
		architectureView.refresh();
		// Which of the two connection buttons the view's title bar shows.
		void vscode.commands.executeCommand(
			'setContext', 'mars.networkTablesConnected', live.connected);
	}));

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(JAVA, new MarsCodeLensProvider(workspace, live)),
		vscode.languages.registerCodeActionsProvider(JAVA, new MarsCodeActionProvider(workspace), {
			providedCodeActionKinds: MarsCodeActionProvider.kinds,
		}),
		vscode.languages.registerHoverProvider(JAVA, new MarsHoverProvider(workspace)),
		vscode.languages.registerCompletionItemProvider(
			JAVA, new MarsCompletionProvider(workspace), '.', '"'),
	);

	context.subscriptions.push(...commands(workspace, live, projectView, architectureView));

	void workspace.discover();

	return { workspace, live };
}

function commands(
	workspace: MarsWorkspace,
	live: LiveNetworkTables,
	projectView: ProjectView,
	architectureView: ArchitectureView,
): vscode.Disposable[] {
	const register = (id: string, handler: (...args: any[]) => unknown) =>
		vscode.commands.registerCommand(id, handler);

	return [
		register('mars.launchDesktop', () => launch('desktop')),

		register('mars.refresh', async () => {
			await workspace.refresh();
			await projectView.update();
			architectureView.refresh();
		}),

		register(REVEAL_COMMAND, (ref: SourceRef) => reveal(ref)),

		// One lens can have several destinations -- three implementations of an IO
		// interface, five requests on a subsystem -- and a lens has one command.
		register('mars.pick', async (title: string, targets: PickTarget[]) => {
			if (targets.length === 1) { return reveal(targets[0].ref); }
			const chosen = await vscode.window.showQuickPick(
				targets.map((target) => ({
					label: target.label,
					description: target.description,
					target,
				})),
				{ title, placeHolder: 'Go to' },
			);
			if (chosen) { await reveal(chosen.target.ref); }
		}),

		register('mars.renameTable', (subsystem?: string) => renameTable(workspace, subsystem)),

		register('mars.connectNetworkTables', () => live.connect()),
		register('mars.disconnectNetworkTables', () => live.disconnect()),
		register('mars.toggleNetworkTables', () => live.toggle()),
		register('mars.setTopic', (topic: string) => live.setFromInput(topic)),

		register('mars.copyTopic', async (topic: string) => {
			await vscode.env.clipboard.writeText(topic);
			vscode.window.setStatusBarMessage(`Copied ${topic}`, 2000);
		}),

		register('mars.focusSidebar', () =>
			vscode.commands.executeCommand('workbench.view.extension.mars')),

		register('mars.openManifest', async () => {
			const project = workspace.project;
			if (!project) { return; }
			const manifest = vscode.Uri.joinPath(
				project.root, 'src', 'main', 'java', 'frc', 'robot', 'configuration', 'Manifest.java');
			await vscode.window.showTextDocument(manifest);
		}),

		register('mars.openDocs', () =>
			vscode.env.openExternal(vscode.Uri.parse('https://stz-robotics.github.io/Mars/'))),

		// Somewhere to see what the scan actually understood, which is the first
		// thing to check when a lens or a diagnostic looks wrong.
		register('mars.showTopics', async () => {
			const model = workspace.model;
			const topics = [
				...model.subsystems.flatMap((s) => s.topics),
				...model.looseTopics,
			];
			if (!topics.length) {
				vscode.window.showInformationMessage('No NetworkTables topics found in this project.');
				return;
			}
			const chosen = await vscode.window.showQuickPick(
				topics.map((topic) => ({
					label: `/${topic.table ?? '?'}/${topic.key}`,
					description: topic.kind,
					detail: topic.owner,
					topic,
				})),
				{ title: 'NetworkTables topics this project publishes', placeHolder: 'Go to the line that publishes it' },
			);
			if (chosen) { await reveal(chosen.topic.ref); }
		}),
	];
}

export function deactivate() {}
