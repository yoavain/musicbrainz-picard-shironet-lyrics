import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import _support

_support.load_plugin_package()

from shironet_lyrics.plugin.server_client import Answer, ServerClient, ServerUnavailable, Unauthorized  # noqa: E402


class StubServer:
    """A local HTTP server that records each request and answers from a script."""

    def __init__(self):
        self.requests = []
        self.answers = {}  # (method, path) -> (status, body dict)
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length) if length else b''
                stub.requests.append({
                    'method': self.command, 'path': self.path,
                    'content_type': self.headers.get('Content-Type'), 'raw': raw,
                    'authorization': self.headers.get('Authorization'),
                })
                status, body = stub.answers.get((self.command, self.path), (404, {'status': 'missing'}))
                data = json.dumps(body, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = _serve

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


SONG = {'artist': 'דן תורן', 'title': 'אוטו כחול'}


class ServerClientTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubServer()
        self.client = ServerClient(self.stub.url, timeout=5)

    def tearDown(self):
        self.stub.close()

    def body(self, index=-1):
        return json.loads(self.stub.requests[index]['raw'].decode('utf-8'))

    def test_health(self):
        self.stub.answers[('GET', '/health')] = (200, {'ok': True, 'version': '0.1.0'})
        self.assertEqual(self.client.health(), Answer(200, {'ok': True, 'version': '0.1.0'}))

    def test_fetch_sends_raw_utf8_json_and_reads_a_202(self):
        self.stub.answers[('POST', '/lyrics/fetch')] = (202, {'status': 'queued', 'position': 3})
        answer = self.client.fetch(SONG, 'interactive')
        self.assertEqual(answer, Answer(202, {'status': 'queued', 'position': 3}))
        request = self.stub.requests[-1]
        self.assertEqual(request['content_type'], 'application/json; charset=utf-8')
        self.assertIn('דן תורן'.encode('utf-8'), request['raw'])  # raw UTF-8, not \u escapes
        self.assertEqual(self.body(), {**SONG, 'priority': 'interactive'})

    def test_status(self):
        self.stub.answers[('GET', '/status')] = (200, {'lyrics': 3, 'due': 1})
        self.assertEqual(self.client.status(), Answer(200, {'lyrics': 3, 'due': 1}))

    def test_no_token_sends_no_authorization(self):
        self.client.lookup(SONG)
        self.assertIsNone(self.stub.requests[-1]['authorization'])

    def test_a_token_goes_in_a_bearer_header(self):
        client = ServerClient(self.stub.url, timeout=5, token='  secret-token  ')
        client.lookup(SONG)
        self.assertEqual(self.stub.requests[-1]['authorization'], 'Bearer secret-token')
        ServerClient(self.stub.url, timeout=5, token='   ').lookup(SONG)
        self.assertIsNone(self.stub.requests[-1]['authorization'])

    def test_401_raises_unauthorized(self):
        self.stub.answers[('POST', '/lyrics/fetch')] = (401, {'error': 'Unauthorized'})
        with self.assertRaises(Unauthorized) as caught:
            self.client.fetch(SONG, 'bulk')
        self.assertIsInstance(caught.exception, ServerUnavailable)  # callers stop as for a server that is down
        self.assertIn('token', str(caught.exception))

    def test_error_answers_keep_their_body(self):
        self.stub.answers[('POST', '/lyrics/fetch')] = (422, {'status': 'not_hebrew'})
        self.assertEqual(self.client.fetch({'artist': 'Band', 'title': 'Song'}, 'bulk'), Answer(422, {'status': 'not_hebrew'}))
        self.stub.answers[('POST', '/lyrics/lookup')] = (404, {'status': 'missing'})
        self.assertEqual(self.client.lookup(SONG), Answer(404, {'status': 'missing'}))

    def test_lookup_returns_hebrew_lyrics_unchanged(self):
        lyrics = 'שִׁיר\u200F שורה\nשורה "שנייה"'
        self.stub.answers[('POST', '/lyrics/lookup')] = (200, {'status': 'found', 'lyrics': lyrics, 'source': 'shironet'})
        self.assertEqual(self.client.lookup(SONG).body['lyrics'], lyrics)

    def test_put_sends_lyrics_ref_and_replace(self):
        self.stub.answers[('PUT', '/lyrics')] = (200, {'result': 'added'})
        answer = self.client.put(SONG, 'שורה', 'c:\\music\\a.mp3', True)
        self.assertEqual(answer, Answer(200, {'result': 'added'}))
        self.assertEqual(self.body(), {**SONG, 'lyrics': 'שורה', 'ref': 'c:\\music\\a.mp3', 'replace': True})

    def test_no_null_fields_are_sent(self):
        self.stub.answers[('POST', '/lyrics/lookup')] = (404, {'status': 'missing'})
        self.client.lookup({'artist': 'א', 'title': 'ב', 'alt': None, 'language': None})
        self.assertEqual(self.body(), {'artist': 'א', 'title': 'ב'})
        self.stub.answers[('PUT', '/lyrics')] = (200, {'result': 'added'})
        self.client.put(SONG, 'שורה', None, False)
        self.assertNotIn('ref', self.body())

    def test_requeue_not_found(self):
        self.stub.answers[('POST', '/admin/requeue-not-found')] = (200, {'count': 4})
        self.assertEqual(self.client.requeue_not_found(), 4)
        self.assertEqual(self.body(), {})

    def test_a_server_that_is_down_raises_server_unavailable(self):
        url = self.stub.url
        self.stub.close()
        with self.assertRaises(ServerUnavailable):
            ServerClient(url, timeout=2).health()

    def test_a_body_that_is_not_json_raises_server_unavailable(self):
        class Broken(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b'<html>oops</html>')

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Broken)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with self.assertRaises(ServerUnavailable):
                ServerClient(f'http://127.0.0.1:{server.server_address[1]}', timeout=2).health()
        finally:
            server.shutdown()
            server.server_close()

    def test_the_base_url_may_end_with_a_slash(self):
        self.stub.answers[('GET', '/health')] = (200, {'ok': True})
        self.assertEqual(ServerClient(self.stub.url + '/', timeout=5).health().status, 200)


if __name__ == '__main__':
    unittest.main()
