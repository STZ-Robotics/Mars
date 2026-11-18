// The installer's record of where MARS went.
//
// The launcher used to look only in the installer's default folder, and a team
// that installed somewhere else was told MARS was not installed.

import * as assert from 'assert';
import { installDirectoryFromRecord } from '../../launcher';

suite('installation record', () => {
	test('the folder the installer recorded', () => {
		const record = JSON.stringify({ schema: 1, version: '1.1.7', edition: 'full', dir: 'D:\\Robotics\\MARS', files: [] });
		assert.strictEqual(installDirectoryFromRecord(record), 'D:\\Robotics\\MARS');
	});

	test('a record from the first installers, with Spanish field names', () => {
		const record = JSON.stringify({ schema: 1, version: '1.1.3', edicion: 'full', carpeta: '/home/team/MARS' });
		assert.strictEqual(installDirectoryFromRecord(record), '/home/team/MARS');
	});

	test('nothing usable in it', () => {
		assert.strictEqual(installDirectoryFromRecord('{"dir": ""}'), undefined);
		assert.strictEqual(installDirectoryFromRecord('{"dir": 3}'), undefined);
		assert.strictEqual(installDirectoryFromRecord('not json'), undefined);
	});
});
