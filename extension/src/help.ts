// `MARS: Show what MARS autocompletes and warns about`: one page listing every
// completion trigger, the hover catalog, the snippet prefixes and every
// diagnostic code with what it means and whether a quick fix exists.
//
// It is a reference, not a tutorial: somebody who sees a squiggle or a
// suggestion they did not expect can find out here what produced it.

import * as vscode from 'vscode';
import { CATALOG } from './catalog';
import { UNITS } from './units';

type Severity = 'Error' | 'Warning' | 'Information';

interface DiagnosticInfo {
	code: string;
	severity: Severity;
	summary: string;
	/** What the quick fix does, if there is one. */
	quickFix?: string;
}

/** Every diagnostic `diagnostics.ts` can produce. */
export const DIAGNOSTICS: readonly DiagnosticInfo[] = [
	{ code: 'mars.duplicateKey', severity: 'Error', summary: 'Two subsystems publish under the same NetworkTables table and overwrite each other on the wire.' },
	{ code: 'mars.topicCollision', severity: 'Warning', summary: 'The same topic path is published from more than one place; only the last write each loop survives.' },
	{ code: 'mars.nullKey', severity: 'Warning', summary: "A subsystem still has the wizard's .key(null) and publishes under no table at all.", quickFix: 'Create or reuse a KeyManager constant' },
	{ code: 'mars.nonLiteralKey', severity: 'Information', summary: 'The table name comes from an expression this extension cannot resolve, so its topics cannot be traced here.' },
	{ code: 'mars.missingKey', severity: 'Warning', summary: 'A subsystem never calls .key(...), so its data has no table to publish under.' },
	{ code: 'mars.orphanSubsystem', severity: 'Warning', summary: 'Nothing constructs this subsystem in the robot container, so it never runs.', quickFix: 'Construct it in the container' },
	{ code: 'mars.unimplementedIo', severity: 'Information', summary: 'An IO interface has no real or simulated implementation for Injector.createIO to hand out.', quickFix: 'Generate the Real and Sim classes' },
	{ code: 'mars.runMode', severity: 'Warning', summary: 'The Manifest is pinned to SIM or REPLAY, so the robot will not drive real hardware.', quickFix: 'Set the run mode to REAL' },
	{ code: 'mars.featureRequirement', severity: 'Warning', summary: 'An installed Feature needs a newer MARS core than the vendordep in this project provides.' },
];

interface CompletionInfo {
	trigger: string;
	where: string;
	suggests: string;
}

/** Every place `MarsCompletionProvider` offers something. */
export const COMPLETIONS: readonly CompletionInfo[] = [
	{ trigger: '.key( / NetworkIO.set(', where: 'the table-name argument', suggests: 'the project\'s own KeyManager-style constants, so two subsystems never end up publishing under "Arm" and "arm".' },
	{ trigger: 'NetworkIO.set(table, "', where: 'the second argument, once the table is known', suggests: 'topic keys already published under that same table, so an existing topic gets reused instead of duplicated under a slightly different name.' },
	{ trigger: '.read( / .write(', where: 'a Blackboard call', suggests: 'the BlackboardKey constants this project declares.' },
	{ trigger: '@', where: 'the start of an annotation', suggests: '@Tunable and @Signal with the key argument ready to fill in, @Fallback, and @Unit with its value list open as a choice.' },
	{ trigger: '@Unit(value = "', where: 'the annotation\'s value argument', suggests: `its fixed vocabulary -- ${UNITS.length} names such as Volts, Degrees or MetersPerSecond, grouped by category.` },
	{ trigger: 'Manifest.', where: 'anywhere it is read, not only inside Injector.createIO', suggests: 'this project\'s own HAS_* switches, read live from Manifest.java.' },
];

const SEVERITY_CLASS: Readonly<Record<Severity, string>> = {
	Error: 'sev-error',
	Warning: 'sev-warning',
	Information: 'sev-info',
};

function escape(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface SnippetInfo {
	name: string;
	prefixes: string;
	description: string;
}

/** The snippets, read from the file the extension ships, so the page cannot drift from it. */
async function readSnippets(extensionUri: vscode.Uri): Promise<SnippetInfo[]> {
	try {
		const uri = vscode.Uri.joinPath(extensionUri, 'snippets', 'mars-java.json');
		const json = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as
			Record<string, { prefix: string | string[]; description: string }>;
		return Object.entries(json).map(([name, snippet]) => ({
			name,
			prefixes: Array.isArray(snippet.prefix) ? snippet.prefix.join(', ') : snippet.prefix,
			description: snippet.description,
		}));
	} catch {
		return [];
	}
}

function completionTable(): string {
	return `<table><thead><tr><th>Type this</th><th>Where</th><th>Suggests</th></tr></thead><tbody>${COMPLETIONS.map((c) => `
		<tr>
			<td><code>${escape(c.trigger)}</code></td>
			<td>${escape(c.where)}</td>
			<td>${escape(c.suggests)}</td>
		</tr>`).join('')}</tbody></table>`;
}

function diagnosticTable(): string {
	return `<table><thead><tr><th>Severity</th><th>Code</th><th>Means</th><th>Quick fix</th></tr></thead><tbody>${DIAGNOSTICS.map((d) => `
		<tr>
			<td><span class="badge ${SEVERITY_CLASS[d.severity]}">${d.severity}</span></td>
			<td><code>${escape(d.code)}</code></td>
			<td>${escape(d.summary)}</td>
			<td>${d.quickFix ? escape(d.quickFix) : '<span class="muted">none -- would have to guess</span>'}</td>
		</tr>`).join('')}</tbody></table>`;
}

function hoverTable(): string {
	return `<table><thead><tr><th>Name</th><th>Kind</th><th>Summary shown on hover</th></tr></thead><tbody>${CATALOG.map((e) => `
		<tr>
			<td><code>${e.kind === 'annotation' ? '@' : ''}${escape(e.name)}</code></td>
			<td class="muted">${escape(e.kind)}</td>
			<td>${escape(e.summary)}</td>
		</tr>`).join('')}</tbody></table>`;
}

function snippetTable(snippets: SnippetInfo[]): string {
	if (!snippets.length) { return '<p class="muted">Snippets could not be read.</p>'; }
	return `<table><thead><tr><th>Type</th><th>Inserts</th><th>Description</th></tr></thead><tbody>${snippets.map((s) => `
		<tr>
			<td><code>${escape(s.prefixes)}</code></td>
			<td>${escape(s.name)}</td>
			<td>${escape(s.description)}</td>
		</tr>`).join('')}</tbody></table>`;
}

export function helpHtml(snippets: SnippetInfo[]): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
	body {
		font-family: var(--vscode-font-family);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 0 24px 40px;
		line-height: 1.5;
	}
	h1 { font-size: 1.4em; margin-top: 28px; }
	h1:first-of-type { margin-top: 12px; }
	p.lede { color: var(--vscode-descriptionForeground); max-width: 70ch; }
	table { border-collapse: collapse; width: 100%; margin: 12px 0 28px; }
	th, td { text-align: left; padding: 6px 10px; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border); }
	th { color: var(--vscode-descriptionForeground); font-weight: 600; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.02em; }
	code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
	.muted { color: var(--vscode-descriptionForeground); }
	a { color: var(--vscode-textLink-foreground); }
	.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.85em; font-weight: 600; }
	.badge.sev-error { color: var(--vscode-errorForeground, #f14c4c); background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 18%, transparent); }
	.badge.sev-warning { color: var(--vscode-editorWarning-foreground, #cca700); background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 18%, transparent); }
	.badge.sev-info { color: var(--vscode-editorInfo-foreground, #3794ff); background: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 18%, transparent); }
</style>
</head>
<body>
	<h1>Autocomplete</h1>
	<p class="lede">Completion here is deliberately narrow: it only fires where a language server cannot help, because the answer is a string this project defines rather than a class on the classpath.</p>
	${completionTable()}

	<h1>Hovering</h1>
	<p class="lede">Hovering a MARS type name adds the paragraph Javadoc does not have. Hovering a project's own key constant or subsystem name shows what it resolves to and who uses it.</p>
	${hoverTable()}

	<h1>Snippets</h1>
	<p class="lede">Type the prefix in a Java file and press Tab.</p>
	${snippetTable(snippets)}

	<h1>Warnings &amp; errors</h1>
	<p class="lede">Every one of these is a mistake Java's own compiler cannot see, because the code compiles fine either way. Hover a squiggle for the specific case; this is the general one.</p>
	${diagnosticTable()}

	<p class="muted">Source: <a href="https://stz-robotics.github.io/Mars/">stz-robotics.github.io/Mars</a></p>
</body>
</html>`;
}

let panel: vscode.WebviewPanel | undefined;

/** Opens the page, or brings the open one forward. */
export async function showHelp(context: vscode.ExtensionContext): Promise<void> {
	const snippets = await readSnippets(context.extensionUri);
	if (panel) {
		panel.reveal(vscode.ViewColumn.Active);
		return;
	}
	panel = vscode.window.createWebviewPanel(
		'mars.help', 'MARS: Autocomplete & Warnings', vscode.ViewColumn.Active, { enableScripts: false });
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mars.svg');
	panel.webview.html = helpHtml(snippets);
	panel.onDidDispose(() => { panel = undefined; });
}
