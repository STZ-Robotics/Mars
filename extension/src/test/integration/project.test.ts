// Activation against a real folder.
//
// The unit tests cover the scanner with strings; this covers everything between
// a folder on disk and what the user sees: that the extension wakes up for a
// MARS project at all, that it reads the descriptors the dashboard writes, and
// that the diagnostics land on the right lines of the right files.
//
// The fixture next door is a MARS project left in three states worth catching:
// pinned to SIM, with one subsystem still carrying the wizard's `.key(null)`
// and never wired into the container, and with a Feature installed that wants a
// MARS core newer than the vendordep.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { MarsApi } from '../../extension';
import { satisfies } from '../../diagnostics';

/** Waits for a condition, polling, because activation and scanning are async. */
async function eventually<T>(
	describe: string,
	probe: () => T | undefined,
	timeoutMs = 15000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) { return value; }
		if (Date.now() > deadline) { assert.fail(`timed out waiting for ${describe}`); }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function api(): Promise<MarsApi> {
	const extension = vscode.extensions.getExtension('mars')
		?? vscode.extensions.all.find((e) => e.packageJSON.name === 'mars');
	assert.ok(extension, 'the MARS extension is not loaded');
	return await extension.activate() as MarsApi;
}

suite('activation against a MARS project', () => {
	test('the project is recognised and its descriptors read', async () => {
		const { workspace } = await api();
		const project = await eventually('the project to be discovered', () => workspace.project);

		assert.strictEqual(project.name, 'fixture');
		assert.strictEqual(project.teamNumber, '3472');
		assert.strictEqual(project.mars?.version, '1.6.7');
		assert.ok(project.hasProjectUnits, 'ProjectUnits.json should be seen');
		assert.deepStrictEqual([...project.manifestFlags], [['HAS_ARM', true]]);
		assert.deepStrictEqual(project.features.map((f) => f.featureId), ['FromTheFuture']);
	});

	test('the architecture is scanned off disk', async () => {
		const { workspace } = await api();
		await eventually('the scan to find subsystems', () => workspace.model.subsystems.length > 0);
		const model = workspace.model;

		assert.deepStrictEqual(model.subsystems.map((s) => s.name).sort(), ['Arm', 'Elevator']);

		const arm = model.subsystems.find((s) => s.name === 'Arm');
		assert.strictEqual(arm?.key, 'Arm', 'KeyManager.ARM_KEY should resolve to "Arm"');
		assert.deepStrictEqual(
			arm?.topics.map((t) => `/${t.table}/${t.key}`).sort(),
			['/Arm/Position', '/Arm/kP'],
		);

		assert.strictEqual(model.ios.find((i) => i.name === 'ArmIOReal')?.role, 'ioImpl');
		assert.strictEqual(model.runMode?.value, 'SIM');
	});

	test('the diagnostics land on the files that cause them', async () => {
		const { workspace } = await api();
		const root = workspace.project?.root
			?? (await eventually('the project', () => workspace.project)).root;

		const codesIn = (relative: string) =>
			vscode.languages
				.getDiagnostics(vscode.Uri.joinPath(root, ...relative.split('/')))
				.filter((d) => d.source === 'MARS')
				.map((d) => d.code);

		const manifest = 'src/main/java/frc/robot/configuration/Manifest.java';
		const elevator = 'src/main/java/frc/robot/subsystems/arm/Elevator.java';
		const feature = 'workspace-mars/features/FromTheFuture.json';

		await eventually('diagnostics to be published', () => codesIn(manifest).length > 0);

		assert.ok(codesIn(manifest).includes('mars.runMode'), 'RunMode.SIM should be reported');
		assert.ok(codesIn(elevator).includes('mars.nullKey'), 'the wizard .key(null) should be reported');
		assert.ok(codesIn(elevator).includes('mars.orphanSubsystem'), 'an unwired subsystem should be reported');
		assert.ok(codesIn(feature).includes('mars.featureRequirement'),
			'a Feature wanting MARS 9.0.0 against a 1.6.7 vendordep should be reported');

		// The one that must stay quiet: Arm is wired, keyed and published.
		const arm = 'src/main/java/frc/robot/subsystems/arm/Arm.java';
		assert.deepStrictEqual(codesIn(arm), [], 'a correct subsystem should produce nothing');
	});

	test('the commands are registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const id of ['mars.launchDesktop', 'mars.refresh', 'mars.showTopics']) {
			assert.ok(commands.includes(id), `${id} is not registered`);
		}
	});
});

suite('version requirements', () => {
	test('the comparisons the Feature descriptors actually use', () => {
		assert.ok(satisfies('1.6.7', '>=1.6.0'));
		assert.ok(satisfies('1.6.0', '>=1.6.0'));
		assert.ok(!satisfies('1.5.9', '>=1.6.0'));
		assert.ok(!satisfies('1.6.7', '>=9.0.0'));
		assert.ok(satisfies('1.6.7', '1.6.0'), 'a bare version reads as a floor');
		// Numeric, not lexical: "1.10" is above "1.9".
		assert.ok(satisfies('1.10.0', '>=1.9.0'));
		// An unparseable requirement is not grounds for a warning.
		assert.ok(satisfies('1.6.7', 'whatever the author meant'));
	});
});
