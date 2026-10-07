import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpClosed, CdpConnection, CdpError, CdpTimeout } from '../src/cdp.ts';
import type { SocketLike } from '../src/cdp.ts';

/** A socket that records what is sent and lets the test answer. */
class FakeSocket implements SocketLike {
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, Array<(event: { data?: unknown }) => void>> = {};
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.emit('close', {}); }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, event: { data?: unknown }) { for (const l of this.listeners[type] ?? []) l(event); }
  reply(message: object) { this.emit('message', { data: JSON.stringify(message) }); }
}

describe('CdpConnection', () => {
  test('send gets the result with the same id, with sessionId when given', async () => {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket);
    const answer = cdp.send<{ frameId: string }>('Page.navigate', { url: 'https://x' }, 'S1');
    assert.deepEqual(socket.sent[0], { id: 1, method: 'Page.navigate', params: { url: 'https://x' }, sessionId: 'S1' });
    socket.reply({ id: 1, result: { frameId: 'F' } });
    assert.deepEqual(await answer, { frameId: 'F' });
  });
  test('an error answer rejects with CdpError', async () => {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket);
    const answer = cdp.send('Bad.method');
    socket.reply({ id: 1, error: { code: -32601, message: "'Bad.method' wasn't found" } });
    await assert.rejects(answer, (error: Error) => error instanceof CdpError && /wasn't found/.test(error.message));
  });
  test('a call without an answer times out', async () => {
    const cdp = new CdpConnection(new FakeSocket());
    await assert.rejects(cdp.send('Page.enable', {}, undefined, 20), CdpTimeout);
  });
  test('a closed connection rejects pending and later calls', async () => {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket);
    const pending = cdp.send('Page.enable');
    socket.emit('close', {});
    await assert.rejects(pending, CdpClosed);
    await assert.rejects(cdp.send('Page.enable'), CdpClosed);
    assert.equal(cdp.isClosed, true);
  });
  test('waitForEvent matches the method and the session', async () => {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket);
    const loaded = cdp.waitForEvent('Page.loadEventFired', 'S1', 1000);
    socket.reply({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'OTHER' });
    socket.reply({ method: 'Page.loadEventFired', params: { timestamp: 2 }, sessionId: 'S1' });
    assert.deepEqual(await loaded, { timestamp: 2 });
  });
  test('waitForEvent rejects on abort and on timeout', async () => {
    const cdp = new CdpConnection(new FakeSocket());
    const controller = new AbortController();
    const aborted = cdp.waitForEvent('Page.loadEventFired', 'S1', 1000, controller.signal);
    controller.abort();
    await assert.rejects(aborted, /aborted/);
    await assert.rejects(cdp.waitForEvent('Page.loadEventFired', 'S1', 20), CdpTimeout);
  });
  test('Hebrew text crosses the socket unchanged', async () => {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket);
    const answer = cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: '"שִׁיר\u200F"' });
    socket.reply({ id: 1, result: { result: { value: 'שִׁיר\u200F' } } });
    assert.equal((await answer).result.value, 'שִׁיר\u200F');
  });
});
