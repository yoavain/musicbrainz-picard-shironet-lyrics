// A minimal Chrome DevTools Protocol client on Node's built-in WebSocket.
// One connection to the browser endpoint; page commands go through a flat session
// (sessionId on each message). Every call has a timeout.

export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
}

export class CdpError extends Error {}
export class CdpTimeout extends Error {}
export class CdpClosed extends Error {}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventListener = (method: string, params: unknown, sessionId: string | undefined) => void;

export class CdpConnection {
  private readonly socket: SocketLike;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<EventListener>();
  private closed = false;

  constructor(socket: SocketLike) {
    this.socket = socket;
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('close', () => this.onClose());
    socket.addEventListener('error', () => this.onClose());
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new CdpTimeout(`CDP connect to ${url} timed out`));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket as unknown as SocketLike));
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpClosed(`CDP connect to ${url} failed`));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string, timeoutMs = 45_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpClosed(`CDP connection closed before ${method}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeout(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  waitForEvent(method: string, sessionId: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        signal?.removeEventListener('abort', onAbort);
      };
      const listener: EventListener = (name, params, session) => {
        if (name === method && (sessionId === undefined || session === sessionId)) {
          done();
          resolve(params);
        }
      };
      const onAbort = () => {
        done();
        reject(new Error(`waiting for ${method} aborted`));
      };
      const timer = setTimeout(() => {
        done();
        reject(new CdpTimeout(`no ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.listeners.add(listener);
    });
  }

  close(): void {
    if (!this.closed) {
      try { this.socket.close(); } catch { /* already gone */ }
    }
    this.onClose();
  }

  private onMessage(text: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CdpError(message.error.message ?? 'CDP error'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of [...this.listeners]) listener(message.method, message.params, message.sessionId);
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpClosed(`CDP connection closed (call ${id})`));
    }
    this.pending.clear();
  }
}
