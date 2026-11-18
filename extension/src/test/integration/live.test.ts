// The live layer, from the command the user runs to the value on the line.
//
// The client's own tests prove the wire format. This proves the half above it:
// that connecting picks up the configured address, that the subscription is
// narrowed to the tables this project actually publishes, and that a value
// arriving on the socket comes back out as the text the editor shows.
//
// The fixture's Arm publishes /Arm/kP, so that is the topic used throughout --
// the same one a person would be looking at.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { MarsApi } from '../../extension';
import { FakeServer, until } from '../fakeNt';

const ADDRESS = 'networkTables.address';

let api: MarsApi;
let server: FakeServer;

async function settings() {
	return vscode.workspace.getConfiguration('mars');
}

suite('live NetworkTables in the editor', () => {
	suiteSetup(async () => {
		const extension = vscode.extensions.all.find((e) => e.packageJSON.name === (require('../../../package.json') as { name: string }).name);
		assert.ok(extension, 'the MARS extension is not loaded');
		api = (await extension.activate()) as MarsApi;

		const deadline = Date.now() + 15000;
		while (!api.workspace.model.subsystems.length) {
			assert.ok(Date.now() < deadline, 'the project was never scanned');
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	setup(async () => {
		server = await FakeServer.start();
		// Global rather than workspace: a workspace setting would write a
		// .vscode/settings.json into the fixture, and the fixture is checked in.
		await (await settings()).update(
			ADDRESS, `localhost:${server.port}`, vscode.ConfigurationTarget.Global);
	});

	teardown(async () => {
		api.live.disconnect();
		await (await settings()).update(ADDRESS, undefined, vscode.ConfigurationTarget.Global);
		await server.close();
	});

	test('connecting uses the configured address without asking', async () => {
		// With no address set this opens a quick pick, which a test cannot answer.
		// The setting exists partly for that: one place that means "just connect".
		await vscode.commands.executeCommand('mars.connectNetworkTables');
		await until('the connection', () => api.live.connected);
		assert.strictEqual(api.live.state, 'connected');
	});

	test('it asks only for the tables this project publishes', async () => {
		await vscode.commands.executeCommand('mars.connectNetworkTables');
		await until('the subscription', () => server.text.some((m) => m.method === 'subscribe'));

		const subscribe = server.text.find((m) => m.method === 'subscribe')!;
		// Arm has a resolved key; Elevator's is still the wizard's null, so there
		// is no table to ask for. Robot.java's System table is published outside
		// any subsystem and has to be picked up too.
		assert.deepStrictEqual([...subscribe.params.topics].sort(), ['/Arm/', '/System/']);
		assert.ok(subscribe.params.options.prefix);
	});

	test('a value on the socket becomes the text shown on the line', async () => {
		await vscode.commands.executeCommand('mars.connectNetworkTables');
		await until('the connection', () => api.live.connected);

		server.announce('/Arm/kP', 3, 'double');
		server.value(3, 1, 0.8234567);
		await until('the value', () => api.live.raw('/Arm/kP') !== undefined);

		assert.strictEqual(api.live.raw('/Arm/kP'), 0.8234567);
		assert.strictEqual(api.live.display('/Arm/kP'), '0.823');
		// A topic the robot never announced has nothing to show, rather than a zero.
		assert.strictEqual(api.live.display('/Arm/never'), undefined);
	});

	test('disconnecting forgets the values rather than showing stale ones', async () => {
		await vscode.commands.executeCommand('mars.connectNetworkTables');
		await until('the connection', () => api.live.connected);

		server.announce('/Arm/kP', 3, 'double');
		server.value(3, 1, 1.25);
		await until('the value', () => api.live.raw('/Arm/kP') !== undefined);

		await vscode.commands.executeCommand('mars.disconnectNetworkTables');
		assert.strictEqual(api.live.connected, false);
		assert.strictEqual(api.live.raw('/Arm/kP'), undefined);
	});
});
