// The completion added in 0.3.0 (rebuilt in 0.3.1): annotations after `@`, the
// @Unit vocabulary, and the Manifest's HAS_* switches wherever it is read.
//
// The provider only looks at the line up to the cursor, so a document of one
// line and a workspace with nothing but a Manifest are enough to drive it.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { COMPLETIONS, DIAGNOSTICS, helpHtml } from '../../help';
import { MarsCompletionProvider } from '../../language';
import { MarsWorkspace } from '../../project';
import { UNITS } from '../../units';

function complete(line: string, flags: [string, boolean][] = []): vscode.CompletionItem[] {
	const workspace = {
		model: { constants: new Map<string, string>(), subsystems: [], looseTopics: [] },
		project: { manifestFlags: new Map(flags) },
	} as unknown as MarsWorkspace;
	const document = { lineAt: () => ({ text: line }) } as unknown as vscode.TextDocument;
	return new MarsCompletionProvider(workspace).provideCompletionItems(document, new vscode.Position(0, line.length));
}

const labels = (items: vscode.CompletionItem[]) => items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));

suite('completion', () => {
	test('@ offers the MARS annotations', () => {
		assert.deepStrictEqual(labels(complete('    @')).sort(), ['Fallback', 'Signal', 'Tunable', 'Unit']);
	});

	test('@Tunable comes with its key ready to fill in', () => {
		const tunable = complete('    @Tun').find((i) => i.label === 'Tunable');
		assert.ok(tunable?.insertText instanceof vscode.SnippetString);
		assert.strictEqual((tunable.insertText as vscode.SnippetString).value, 'Tunable(key = "$1")');
	});

	test('@Unit opens its vocabulary as a choice', () => {
		const unit = complete('@').find((i) => i.label === 'Unit');
		const snippet = (unit?.insertText as vscode.SnippetString).value;
		assert.ok(snippet.startsWith('Unit(value = "${1|Volts,'), snippet);
		assert.ok(snippet.endsWith('|}", group = "$2")'), snippet);
	});

	test('inside @Unit(value = " the units are offered, not the annotations', () => {
		const items = complete('    @Unit(value = "Me');
		assert.strictEqual(items.length, UNITS.length);
		assert.strictEqual(items.find((i) => i.label === 'MetersPerSecond')?.detail, 'Linear velocity');
	});

	test('Manifest. offers the project\'s HAS_* switches anywhere', () => {
		const items = complete('        if (Manifest.', [['HAS_ARM', true], ['HAS_VISION', false]]);
		assert.deepStrictEqual(labels(items), ['HAS_ARM', 'HAS_VISION']);
		assert.strictEqual(items[1].detail, 'false');
	});

	test('a plain line offers nothing', () => {
		assert.deepStrictEqual(complete('    double x = 3;'), []);
	});
});

suite('reference page', () => {
	test('the unit vocabulary has no duplicates', () => {
		assert.strictEqual(new Set(UNITS.map((u) => u.name)).size, UNITS.length);
		assert.strictEqual(UNITS.length, 83, 'the vocabulary 0.3.0 shipped');
	});

	test('it lists exactly the diagnostics the extension produces', () => {
		const source = fs.readFileSync(path.join(__dirname, '../../../src/diagnostics.ts'), 'utf8');
		const produced = new Set(source.match(/'mars\.[A-Za-z]+'/g)?.map((c) => c.slice(1, -1)));
		assert.deepStrictEqual(new Set(DIAGNOSTICS.map((d) => d.code)), produced);
	});

	test('it renders every section, escaped', () => {
		const html = helpHtml([{ name: 'Subsystem', prefixes: 'marssub', description: 'A <subsystem>' }]);
		for (const heading of ['Autocomplete', 'Hovering', 'Snippets', 'Warnings &amp; errors']) {
			assert.ok(html.includes(`<h1>${heading}</h1>`), heading);
		}
		assert.ok(html.includes('A &lt;subsystem&gt;'));
		assert.strictEqual(COMPLETIONS.length, 6);
	});
});
