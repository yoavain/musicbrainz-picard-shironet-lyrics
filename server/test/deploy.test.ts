import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOTE, destructiveSteps, healthPollScript, previousRelease, releaseId, releasesToDelete, sshArgs, switchCommand,
  systemctl,
} from '../tools/deploy-lib.ts';
import type { Migration } from '../src/migrations.ts';

const step = (to: number, destructive = false): Migration => ({ to, description: `v${to}`, destructive, up: () => {} });

describe('deploy helpers', () => {
  test('release ids sort by time and carry the short commit', () => {
    assert.equal(releaseId(new Date(Date.UTC(2026, 9, 7, 12, 30, 5)), 'abc1234def5678'), '20261007T123005Z-abc1234');
  });
  test('keep the newest releases and never the current one', () => {
    const names = ['20261001T000000Z-a', '20261002T000000Z-b', '20261003T000000Z-c', '20261004T000000Z-d', '20261005T000000Z-e'];
    assert.deepEqual(releasesToDelete(names, '20261005T000000Z-e', 3), ['20261001T000000Z-a', '20261002T000000Z-b']);
    // After a rollback the current one is older: it stays, and so do the newest.
    assert.deepEqual(releasesToDelete(names, '20261001T000000Z-a', 3), ['20261002T000000Z-b']);
    assert.deepEqual(releasesToDelete(names.slice(0, 2), null, 3), []);
  });
  test('the previous release is the newest one older than the current one', () => {
    const names = ['20261003T000000Z-c', '20261001T000000Z-a', '20261002T000000Z-b'];
    assert.equal(previousRelease(names, '20261003T000000Z-c'), '20261002T000000Z-b');
    assert.equal(previousRelease(names, '20261001T000000Z-a'), null);
    assert.equal(previousRelease(names, null), null);
  });
  test('destructive steps: those after the remote version; all of them when the version is unknown', () => {
    const steps = [step(2, true), step(3), step(4, true)];
    assert.deepEqual(destructiveSteps(3, steps).map((s) => s.to), [4]);
    assert.deepEqual(destructiveSteps(4, steps), []);
    assert.deepEqual(destructiveSteps(null, steps).map((s) => s.to), [2, 4]);
  });
  test('systemctl calls match the sudo rule exactly: nothing after the unit name', () => {
    assert.equal(systemctl('restart'), 'sudo -n systemctl restart shironet-lyrics');
    assert.equal(systemctl('is-active'), 'sudo -n systemctl is-active shironet-lyrics');
  });
  test('the switch replaces the current link in one rename', () => {
    assert.equal(
      switchCommand('20261007T123005Z-abc1234'),
      `ln -sfn ${REMOTE.releases}/20261007T123005Z-abc1234 ${REMOTE.app}/current.new && mv -Tf ${REMOTE.app}/current.new ${REMOTE.current}`,
    );
    assert.throws(() => switchCommand('../etc; rm -rf /'), /release id/);
  });
  test('ssh runs in batch mode with only the given key', () => {
    assert.deepEqual(sshArgs('C:\\Users\\u\\.ssh\\key', 'deploy@host', 'true'), [
      '-i', 'C:\\Users\\u\\.ssh\\key', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10', 'deploy@host', 'true',
    ]);
  });
  test('the health poll runs with the absolute node path and a time limit', () => {
    const script = healthPollScript(60);
    assert.ok(script.startsWith(`${REMOTE.node} -e `));
    assert.match(script, /127\.0\.0\.1:8735\/health/);
    assert.match(script, /60/);
  });
});
