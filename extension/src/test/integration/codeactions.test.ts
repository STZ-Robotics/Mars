// The quick fixes, applied for real against the fixture project.
//
// Asking the provider for its actions only proves the titles are right. What
// matters is the text afterwards, so these apply the edit and read the buffer
// back. Nothing is ever saved: `applyEdit` leaves the documents dirty and
// in-memory, and each test reverts what it touched, so the fixture on disk is
// the same before and after the run.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { MarsApi } from '../../extension';
import { planTableRename, upperSnake } from '../../codeactions';

const JAVA = 'src/main/java/frc/robot';
const ELEVATOR = `${JAVA}/subsystems/arm/Elevator.java`;
const ELEVATOR_IO = `${JAVA}/subsystems/arm/ElevatorIO.java`;
const MANIFEST = `${JAVA}/configuration/Manifest.java`;
const CONTAINER = `${JAVA}/RobotContainer.java`;

let root: vscode.Uri;
let workspace: MarsApi['workspace'];

function uriOf(relative: string): vscode.Uri {
	return vscode.Uri.joinPath(root, ...relative.split('/'));
}

async function eventually<T>(what: string, probe: () => T | undefined | false, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) { return value as T; }
		if (Date.now() > deadline) { assert.fail(`timed out waiting for ${what}`); }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/**
 * The actions offered where the diagnostic with this code is.
 *
 * They come back without their `diagnostics` field: `executeCodeActionProvider`
 * does not carry it across, so the only handle on an action here is its title.
 */
async function actionsFor(relative: string, code: string): Promise<vscode.CodeAction[]> {
	const uri = uriOf(relative);
	// executeCodeActionProvider refuses a document with no text model behind it,
	// which is what an unopened file is.
	await vscode.workspace.openTextDocument(uri);

	const diagnostic = await eventually(
		`the ${code} diagnostic on ${relative}`,
		() => vscode.languages.getDiagnostics(uri).find((d) => d.source === 'MARS' && d.code === code),
	);

	const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
		'vscode.executeCodeActionProvider', uri, diagnostic.range);
	return actions ?? [];
}

/**
 * Puts every open document back to what is on disk, and waits for the model to
 * agree again.
 *
 * The waiting is the part that matters. A fix applied in one test shifts the
 * lines below it, and a diagnostic published before the revert would then point
 * one line away from where the re-scanned model puts the declaration -- so the
 * next test finds its diagnostic but no fix matching it. Reverting the text is
 * not enough; the scan behind it has to have caught up.
 */
async function revertAll(): Promise<void> {
	for (const document of vscode.workspace.textDocuments) {
		if (document.isDirty) {
			await vscode.window.showTextDocument(document, { preview: false });
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	}
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');

	// Long enough for the store's own debounce to fire, then a full re-read so
	// the model is built from what is on disk rather than from a stale buffer.
	await new Promise((resolve) => setTimeout(resolve, 600));
	await workspace.refresh();
	await eventually(
		'the model to match the files on disk',
		() => workspace.model.subsystems.find((s) => s.name === 'Elevator')?.key === undefined,
	);
}

suite('quick fixes', () => {
	suiteSetup(async () => {
		const extension = vscode.extensions.all.find((e) => e.packageJSON.name === (require('../../../package.json') as { name: string }).name);
		assert.ok(extension, 'the MARS extension is not loaded');
		workspace = ((await extension.activate()) as MarsApi).workspace;
		root = (await eventually('the project', () => workspace.project)).root;
		await eventually('the first scan', () => workspace.model.subsystems.length > 0);
	});

	teardown(revertAll);

	test('a null key is fixed by the constant that already exists', async () => {
		// KeyManager already declares ELEVATOR_KEY -- the wizard's own TODO names
		// it -- so the fix is to use it, not to declare a second one.
		const actions = await actionsFor(ELEVATOR, 'mars.nullKey');
		const fix = actions.find((a) => a.title === 'Use KeyManager.ELEVATOR_KEY');
		assert.ok(fix, `expected the "use the existing constant" fix, got: ${actions.map((a) => a.title)}`);
		assert.ok(fix.isPreferred, 'it should be the preferred fix');

		await vscode.workspace.applyEdit(fix.edit!);

		const text = (await vscode.workspace.openTextDocument(uriOf(ELEVATOR))).getText();
		assert.ok(text.includes('.key(KeyManager.ELEVATOR_KEY)'), 'the key should now be the constant');
		assert.ok(text.includes('import frc.robot.configuration.KeyManager;'),
			'KeyManager is in another package, so the import has to come with it');
	});

	test('an orphan subsystem is constructed in the container', async () => {
		const actions = await actionsFor(ELEVATOR, 'mars.orphanSubsystem');
		const fix = actions.find((a) => a.title.startsWith('Construct Elevator'));
		assert.ok(fix, `expected the container fix, got: ${actions.map((a) => a.title)}`);

		await vscode.workspace.applyEdit(fix.edit!);

		const text = (await vscode.workspace.openTextDocument(uriOf(CONTAINER))).getText();
		assert.ok(/private final Elevator elevator\s*=/.test(text), text);
		// Only ArmIOReal exists in the fixture, so the Injector form would not
		// compile and the fix has to fall back to the one implementation there is.
		assert.ok(text.includes('new ArmIOReal()'), 'it should use the only implementation available');
		assert.ok(text.includes('import frc.robot.subsystems.arm.Elevator;'));
	});

	test('an interface with no implementation gets Real and Sim written', async () => {
		const actions = await actionsFor(ELEVATOR_IO, 'mars.unimplementedIo');
		const fix = actions.find((a) => a.title.includes('ElevatorIOReal'));
		assert.ok(fix, `expected the generate fix, got: ${actions.map((a) => a.title)}`);

		// Read the planned edit rather than running it: applying would put two new
		// files on disk, and the fixture has to come out of the run unchanged.
		const written = new Map(fix.edit!.entries().map(([uri, edits]) => [
			uri.path.split('/').pop(),
			edits.map((e) => e.newText).join(''),
		]));

		assert.deepStrictEqual(
			[...written.keys()].sort(), ['ElevatorIOReal.java', 'ElevatorIOSim.java']);

		const real = written.get('ElevatorIOReal.java')!;
		assert.ok(real.includes('public class ElevatorIOReal implements ElevatorIO'));
		assert.ok(real.includes('package frc.robot.subsystems.arm;'));
		// updateInputs is inherited from IO<T> and is not in the interface body,
		// so it only appears if the generator knows MARS declares it.
		assert.ok(real.includes('public void updateInputs(ElevatorInputs inputs)'), real);
		assert.ok(real.includes('public void applyOutput(double volts)'), real);
		// A non-void method needs a return or the stub does not compile.
		assert.ok(/public boolean isHomed\(\) \{\s*return false;/.test(real), real);
		// The fallback is generated by MarsProcessor from @Fallback; writing a
		// third class by hand would collide with it.
		assert.ok(!written.has('ElevatorIOFallback.java'));
	});

	test('the run mode is put back to REAL', async () => {
		const actions = await actionsFor(MANIFEST, 'mars.runMode');
		const fix = actions.find((a) => a.title.includes('REAL'));
		assert.ok(fix, `expected the run mode fix, got: ${actions.map((a) => a.title)}`);

		await vscode.workspace.applyEdit(fix.edit!);

		const text = (await vscode.workspace.openTextDocument(uriOf(MANIFEST))).getText();
		assert.ok(text.includes('CURRENT_MODE = RunMode.REAL'), text);
		assert.ok(!text.includes('RunMode.SIM'));
	});

	test('no fix is offered for a collision, because picking one would be a guess', async () => {
		// There is no topic collision in the fixture, so this asserts the shape of
		// the rule rather than the absence: a code with no handler yields nothing.
		const arm = uriOf(`${JAVA}/subsystems/arm/Arm.java`);
		await vscode.workspace.openTextDocument(arm);
		const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider', arm, new vscode.Range(0, 0, 0, 0));
		assert.ok(!(actions ?? []).some((a) => a.title.startsWith('Generate')));
	});
});

suite('renaming a table', () => {
	suiteSetup(async () => {
		const extension = vscode.extensions.all.find((e) => e.packageJSON.name === (require('../../../package.json') as { name: string }).name);
		workspace = ((await extension!.activate()) as MarsApi).workspace;
		root = (await eventually('the project', () => workspace.project)).root;
		await eventually('the first scan', () => workspace.model.subsystems.length > 0);
	});

	teardown(revertAll);

	test('the constant and every literal that names the table are rewritten', async () => {
		const model = workspace.model;
		const arm = model.subsystems.find((s) => s.name === 'Arm')!;
		assert.strictEqual(arm.key, 'Arm');

		const { edit, replacements } = await planTableRename(model, arm, 'Wrist');

		// One edit, in KeyManager: the table is named there once and addressed
		// through the constant everywhere else, which is the whole point of the
		// convention. Nothing in Arm.java spells "Arm" out.
		assert.strictEqual(replacements, 1);
		const [uri, edits] = edit.entries()[0];
		assert.ok(uri.path.endsWith('KeyManager.java'), uri.path);
		assert.strictEqual(edits[0].newText, '"Wrist"');

		await vscode.workspace.applyEdit(edit);
		const text = (await vscode.workspace.openTextDocument(uri)).getText();
		assert.ok(text.includes('ARM_KEY = "Wrist"'), text);
	});
});

suite('naming', () => {
	test('constants are spelled the way the wizard spells them', () => {
		assert.strictEqual(upperSnake('Elevator'), 'ELEVATOR');
		assert.strictEqual(upperSnake('targetAngle'), 'TARGET_ANGLE');
		assert.strictEqual(upperSnake('IntakeArm'), 'INTAKE_ARM');
	});
});
