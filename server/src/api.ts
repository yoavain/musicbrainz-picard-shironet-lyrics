// The HTTP API. Routes translate JSON to LyricsService calls and back; no logic here.
// Text rules (see the spec, "Hebrew text"): bodies are JSON in UTF-8, checked byte for
// byte; user text never travels in a URL or a header.

import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Entry } from './store.ts';
import type { Priority } from './queue.ts';
import type { LyricsService, Song } from './service.ts';

export const BODY_LIMIT = 256 * 1024;

export interface AppOptions {
  service: LyricsService;
  allowedHosts: readonly string[];
  version: string;
  logger?: boolean;
}

// No C0 controls and no DEL in names. Lyrics may keep tab, line feed and carriage return.
const NAME = { type: 'string', maxLength: 500, pattern: '^[^\\u0000-\\u001f\\u007f]*$' };
const LYRICS = { type: 'string', maxLength: 200000, pattern: '^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$' };
const SONG_PROPERTIES = {
  artist: NAME,
  title: NAME,
  language: { type: 'string', maxLength: 20, pattern: '^[^\\u0000-\\u001f\\u007f]*$' },
  alt: {
    type: 'object',
    additionalProperties: false,
    required: ['artist', 'title'],
    properties: { artist: NAME, title: NAME },
  },
};

function bodySchema(extra: Record<string, unknown> = {}, required: string[] = []) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['artist', 'title', ...required],
    properties: { ...SONG_PROPERTIES, ...extra },
  };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** True when every string inside the value is well-formed Unicode (no lone surrogates). */
function wellFormed(value: unknown): boolean {
  if (typeof value === 'string') return value.isWellFormed();
  if (Array.isArray(value)) return value.every(wellFormed);
  if (value && typeof value === 'object') return Object.values(value).every(wellFormed);
  return true;
}

function entryFields(entry: Entry) {
  return { lyrics: entry.lyrics, source: entry.source, artist: entry.artist, title: entry.title };
}

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { service } = options;
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: BODY_LIMIT,
    // Reject unknown fields instead of silently removing them; never coerce types.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  // Only JSON bodies (a web page cannot send JSON to localhost without a CORS preflight,
  // and this server sends no CORS headers). The bytes must be valid UTF-8.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    let text: string;
    try {
      text = UTF8.decode(body as Buffer); // also drops a leading BOM
    } catch {
      done(badRequest('Body is not valid UTF-8'), undefined);
      return;
    }
    parseJson(request, text, done);
  });

  // DNS rebinding: only our own host names.
  app.addHook('onRequest', async (request, reply) => {
    if (!allowedHosts.has((request.headers.host ?? '').toLowerCase())) {
      return reply.code(403).send({ error: 'Host not allowed' });
    }
  });

  app.addHook('preValidation', async (request: FastifyRequest) => {
    if (!wellFormed(request.body)) throw badRequest('Text is not valid Unicode');
  });

  app.post('/lyrics/lookup', { schema: { body: bodySchema() } }, async (request, reply) => {
    const entry = service.lookup(request.body as Song);
    if (!entry) return reply.code(404).send({ status: 'missing' });
    return { status: 'found', ...entryFields(entry) };
  });

  app.post('/lyrics/fetch', {
    schema: { body: bodySchema({ priority: { type: 'string', enum: ['interactive', 'bulk'] } }) },
  }, async (request, reply) => {
    const { priority = 'bulk', ...song } = request.body as Song & { priority?: Priority };
    const answer = service.fetch(song, priority);
    switch (answer.status) {
      case 'found':
        return { status: 'found', ...entryFields(answer.entry) };
      case 'queued':
        return reply.code(202).send({ status: 'queued', position: answer.position });
      case 'not_found':
      case 'failed':
        return reply.code(404).send({ status: answer.status, retryAfter: answer.retryAfter });
      case 'not_hebrew':
      case 'no_name':
        return reply.code(422).send({ status: answer.status });
    }
  });

  app.put('/lyrics', {
    schema: {
      body: bodySchema({
        lyrics: LYRICS,
        ref: { type: 'string', maxLength: 2000, pattern: '^[^\\u0000-\\u001f\\u007f]*$' },
        replace: { type: 'boolean' },
      }, ['lyrics']),
    },
  }, async (request) => {
    const { lyrics, ref, replace, ...song } = request.body as Song & { lyrics: string; ref?: string; replace?: boolean };
    return { result: service.put(song, lyrics, ref ?? null, replace ?? false) };
  });

  app.get('/status', async () => service.status());

  app.get('/health', async () => ({ ok: true, version: options.version }));

  return app;
}
