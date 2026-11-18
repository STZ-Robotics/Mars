// The two language features: hovers over MARS types, and completion for the
// things only this project knows the names of.
//
// The split matters. Hovers are documentation -- what a Request is for, what
// happens if you leave `.key(null)` -- and they are attached to names the Java
// language server already resolves, so they add a paragraph rather than compete.
// Completion is the opposite: it offers key constants and existing topic names,
// which no language server can suggest because they are strings, and strings are
// where a typo turns into a topic nobody ever sees on the dashboard.

import * as vscode from 'vscode';
import { ApiEntry, CATALOG, documentationUrl, lookup } from './catalog';
import { MarsWorkspace } from './project';
import { topicPath } from './scan/model';
import { UNITS } from './units';

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

function documentation(entry: ApiEntry): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);
	markdown.appendMarkdown(`**${entry.name}** — ${entry.kind}\n\n`);
	markdown.appendMarkdown(`${entry.summary}\n\n`);
	if (entry.signature) { markdown.appendCodeblock(entry.signature, 'java'); }
	if (entry.note) { markdown.appendMarkdown(`\n${entry.note}\n`); }
	markdown.appendMarkdown(`\n[Documentation](${documentationUrl(entry)})`);
	return markdown;
}

export class MarsHoverProvider implements vscode.HoverProvider {
	constructor(private readonly workspace: MarsWorkspace) {}

	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		// An annotation is written `@Tunable`, so the word range has to be allowed
		// to start one character earlier than a Java identifier normally would.
		const range = document.getWordRangeAtPosition(position, /@?\w+/);
		if (!range) { return undefined; }
		const word = document.getText(range).replace(/^@/, '');

		const entry = lookup(word);
		if (entry) { return new vscode.Hover(documentation(entry), range); }

		return this.projectHover(word, range);
	}

	/**
	 * A hover for the project's own names: what a key constant resolves to, and
	 * what a subsystem publishes under. Both answer a question that otherwise
	 * needs another file open.
	 */
	private projectHover(word: string, range: vscode.Range): vscode.Hover | undefined {
		const model = this.workspace.model;

		const constant = model.constants.get(word);
		if (constant !== undefined) {
			const users = model.subsystems.filter((s) => s.key === constant);
			const markdown = new vscode.MarkdownString(undefined, true);
			markdown.appendMarkdown(`\`${word}\` is \`"${constant}"\`\n\n`);
			markdown.appendMarkdown(users.length
				? `The NetworkTables table of ${users.map((s) => `\`${s.name}\``).join(', ')}.`
				: 'Not used as a subsystem key anywhere in this project.');
			return new vscode.Hover(markdown, range);
		}

		const subsystem = model.subsystems.find((s) => s.name === word);
		if (subsystem) {
			const markdown = new vscode.MarkdownString(undefined, true);
			markdown.appendMarkdown(`**${subsystem.name}** — ${subsystem.role}\n\n`);
			markdown.appendMarkdown(subsystem.key
				? `Publishes under \`/${subsystem.key}\`, ${subsystem.topics.length} topics.\n\n`
				: 'Its NetworkTables table could not be resolved from source.\n\n');
			if (subsystem.dataType && subsystem.ioType) {
				markdown.appendCodeblock(
					`${subsystem.supertype}<${subsystem.dataType}, ${subsystem.ioType}>`, 'java');
			}
			return new vscode.Hover(markdown, range);
		}

		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/** The calls whose first argument is a NetworkTables table name. */
const EXPECTS_TABLE = /(?:NetworkIO\s*\.\s*set|\.key)\s*\(\s*[\w.]*$/;
/** The calls whose argument is a blackboard key. */
const EXPECTS_BLACKBOARD_KEY = /\.(?:read|write)\s*\(\s*[\w.]*$/;
/** The second argument of a NetworkIO.set: the key under an already-named table. */
const EXPECTS_TOPIC_KEY = /NetworkIO\s*\.\s*set\s*\(\s*([^,]+?)\s*,\s*"([^"]*)$/;
/** The start of an annotation. */
const EXPECTS_ANNOTATION = /@(\w*)$/;
/** A read of the Manifest, wherever it happens: its `HAS_*` switches. */
const EXPECTS_MANIFEST_FLAG = /\bManifest\s*\.\s*\w*$/;
/** The value of a `@Unit`, which only accepts the UnitProcessor's vocabulary. */
const EXPECTS_UNIT = /@Unit\s*\(\s*value\s*=\s*"[^"]*$/;

export class MarsCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly workspace: MarsWorkspace) {}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.CompletionItem[] {
		const line = document.lineAt(position.line).text.slice(0, position.character);
		const model = this.workspace.model;

		// Most specific first: a @Unit value is also the start of an annotation,
		// and a NetworkIO.set key also follows a table.
		if (EXPECTS_UNIT.test(line)) {
			return this.unitValues();
		}
		if (EXPECTS_TOPIC_KEY.test(line)) {
			return this.keysUnderTable(line);
		}
		if (EXPECTS_TABLE.test(line)) {
			return this.tableConstants();
		}
		if (EXPECTS_MANIFEST_FLAG.test(line)) {
			return this.manifestFlags();
		}
		if (EXPECTS_ANNOTATION.test(line)) {
			return this.annotations();
		}
		if (EXPECTS_BLACKBOARD_KEY.test(line)) {
			// Blackboard keys are declared as fields, not string constants, so the
			// only reliable handle on them is the naming the template establishes.
			return [...model.constants.keys()]
				.filter((name) => name.includes('.') && /KEY|Key/.test(name))
				.map((name) => this.item(name, vscode.CompletionItemKind.Constant, 'blackboard key'));
		}
		return [];
	}

	/**
	 * The MARS annotations, inserted with their argument ready to fill in:
	 * `@Tunable` and `@Signal` with `key`, `@Unit` with its vocabulary open as
	 * a choice. Without the argument a `@Tunable` publishes under the field's
	 * own name, which is rarely the one the dashboard layout expects.
	 */
	private annotations(): vscode.CompletionItem[] {
		return CATALOG.filter((entry) => entry.kind === 'annotation').map((entry) => {
			const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Class);
			item.detail = entry.summary;
			item.documentation = new vscode.MarkdownString(entry.note ?? entry.summary);
			item.insertText = this.annotationSnippet(entry.name);
			item.sortText = `0${entry.name}`;
			return item;
		});
	}

	private annotationSnippet(name: string): vscode.SnippetString | undefined {
		switch (name) {
			case 'Tunable':
			case 'Signal':
				return new vscode.SnippetString(`${name}(key = "$1")`);
			case 'Unit': {
				const choices = UNITS.map((unit) => unit.name).join(',');
				return new vscode.SnippetString(`${name}(value = "\${1|${choices}|}", group = "$2")`);
			}
			default:
				return undefined;
		}
	}

	/** The UnitProcessor's vocabulary, each with its category beside it. */
	private unitValues(): vscode.CompletionItem[] {
		return UNITS.map(({ name, category }) => this.item(name, vscode.CompletionItemKind.EnumMember, category));
	}

	/**
	 * The project's own `HAS_*` switches, read live from `Manifest.java`,
	 * wherever the Manifest is read and not only inside `Injector.createIO`.
	 */
	private manifestFlags(): vscode.CompletionItem[] {
		return [...this.workspace.project?.manifestFlags ?? new Map<string, boolean>()].map(([name, value]) => {
			const item = this.item(name, vscode.CompletionItemKind.Constant, value ? 'true' : 'false');
			item.documentation = new vscode.MarkdownString(`Declared in \`Manifest.java\` as \`${value}\`.`);
			return item;
		});
	}

	/**
	 * The project's string constants, offered where a table name goes.
	 *
	 * Typing the literal instead is what produces two subsystems publishing under
	 * "Arm" and "arm" and an afternoon spent looking for the second one.
	 */
	private tableConstants(): vscode.CompletionItem[] {
		const model = this.workspace.model;
		const qualified = [...model.constants].filter(([name]) => name.includes('.'));

		return qualified.map(([name, value]) => {
			const users = model.subsystems.filter((s) => s.key === value);
			const item = this.item(name, vscode.CompletionItemKind.Constant, `"${value}"`);
			item.documentation = new vscode.MarkdownString(users.length
				? `The table of ${users.map((s) => `\`${s.name}\``).join(', ')}.`
				: `Declared as \`"${value}"\`.`);
			return item;
		});
	}

	/** Keys already published under the table named in the same call. */
	private keysUnderTable(line: string): vscode.CompletionItem[] {
		const match = EXPECTS_TOPIC_KEY.exec(line);
		if (!match) { return []; }

		const model = this.workspace.model;
		const table = /^"(.*)"$/.exec(match[1].trim())?.[1]
			?? model.constants.get(match[1].trim())
			?? model.constants.get(match[1].trim().split('.').pop() ?? '');
		if (!table) { return []; }

		const seen = new Set<string>();
		const topics = [...model.subsystems.flatMap((s) => s.topics), ...model.looseTopics]
			.filter((t) => t.table === table && t.literal && !seen.has(t.key) && seen.add(t.key));

		return topics.map((topic) => {
			const item = this.item(topic.key, vscode.CompletionItemKind.Value, topic.kind);
			item.documentation = new vscode.MarkdownString(
				`Already published as \`${topicPath(topic)}\`. Reusing the name means one topic, not two.`);
			return item;
		});
	}

	private item(label: string, kind: vscode.CompletionItemKind, detail: string): vscode.CompletionItem {
		const item = new vscode.CompletionItem(label, kind);
		item.detail = detail;
		// Ahead of the language server's own suggestions: in these positions the
		// project's names are the answer and a class name never is.
		item.sortText = `0${label}`;
		return item;
	}
}
