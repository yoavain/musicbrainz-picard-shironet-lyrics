import os
import random
import unittest

import _support

_support.load_plugin_package()

from shironet_lyrics.src import shironet_queue as queue  # noqa: E402
from shironet_lyrics.src.lyrics_cache import SOURCE_EMBEDDED, SOURCE_SHIRONET, LyricsCache  # noqa: E402
from shironet_lyrics.src.shironet_worker import (  # noqa: E402
    CHALLENGE,
    ERROR,
    MAX_ATTEMPTS,
    OK,
    PaceLimits,
    Pacer,
    PaceState,
    Response,
    load_pace,
    pace_report,
    process_item,
    run,
    save_pace,
    similarity,
)


FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
SEARCH = open(os.path.join(FIXTURES, 'shironet_search.html'), encoding='utf-8').read()
LYRICS = open(os.path.join(FIXTURES, 'shironet_lyrics.html'), encoding='utf-8').read()
FIXTURE_LYRICS = 'שורה ראשונה\nשורה שנייה "בגרשיים"\n\nבית שני, שורה ראשונה\nבית שני, שורה שנייה'
ARTIST, TITLE = 'להקת הנח"ל', 'שיר לשלום'


class FakeClient:
    """Answers search URLs with the search fixture and lyrics URLs with the lyrics fixture,
    unless a scripted response is queued for the next request."""

    def __init__(self):
        self.urls = []
        self.scripted = []

    def get(self, url):
        self.urls.append(url)
        if self.scripted:
            return self.scripted.pop(0)
        return Response(OK, 200, SEARCH if 'searchSongs' in url else LYRICS)


class FakeTime:
    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def make_pacer(interval=100.0, **limits):
    return Pacer(PaceState(interval=interval, cooldown=1800.0), PaceLimits(**limits), random.Random(1))


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.cache = LyricsCache(':memory:')

    def tearDown(self):
        self.cache.close()

    def test_enqueue_once(self):
        self.assertTrue(queue.enqueue(self.cache, ARTIST, TITLE))
        self.assertFalse(queue.enqueue(self.cache, ARTIST, TITLE + ' (Live)'))
        self.assertEqual(queue.counts(self.cache), {('fetch', 'pending'): 1})

    def test_cached_song_is_not_queued_for_fetch(self):
        self.cache.put(ARTIST, TITLE, 'text', SOURCE_EMBEDDED)
        self.assertFalse(queue.enqueue(self.cache, ARTIST, TITLE))
        self.assertTrue(queue.enqueue(self.cache, ARTIST, TITLE, queue.PURPOSE_CALIBRATE))

    def test_empty_names_are_not_queued(self):
        self.assertFalse(queue.enqueue(self.cache, '', TITLE))

    def test_next_pending_prefers_fewer_attempts(self):
        queue.enqueue(self.cache, 'A', 'One')
        queue.enqueue(self.cache, 'A', 'Two')
        first = queue.next_pending(self.cache)
        queue.update(self.cache, first, add_attempt=True)
        self.assertEqual(queue.next_pending(self.cache).title, 'Two')

    def test_request_log_records_gaps(self):
        queue.log_request(self.cache, 'search', OK, 200, at=100.0)
        queue.log_request(self.cache, 'lyrics', CHALLENGE, 302, 'x', at=130.0)
        self.assertEqual(
            queue.request_log(self.cache),
            [(100.0, 'search', OK, 200, None), (130.0, 'lyrics', CHALLENGE, 302, 30.0)],
        )


class PacerTest(unittest.TestCase):
    def test_speeds_up_after_a_streak(self):
        pacer = make_pacer(100.0, speedup_after=3)
        for _ in range(3):
            pacer.on_success()
        self.assertAlmostEqual(pacer.state.interval, 90.0)
        self.assertEqual(pacer.state.streak, 0)

    def test_never_below_the_minimum(self):
        pacer = make_pacer(21.0, speedup_after=1, min_interval=20.0)
        pacer.on_success()
        pacer.on_success()
        self.assertEqual(pacer.state.interval, 20.0)

    def test_challenge_backs_off_and_doubles_the_cooldown(self):
        pacer = make_pacer(100.0)
        self.assertEqual(pacer.on_challenge(), 1800.0)
        self.assertEqual(pacer.on_challenge(), 3600.0)
        self.assertAlmostEqual(pacer.state.interval, 225.0)
        pacer.on_success()
        self.assertEqual(pacer.state.cooldown, 1800.0)
        self.assertFalse(pacer.state.challenged)

    def test_cooldown_and_interval_have_ceilings(self):
        pacer = make_pacer(1500.0, max_interval=1800.0, max_cooldown=5000.0)
        for _ in range(5):
            pacer.on_challenge()
        self.assertEqual((pacer.state.interval, pacer.state.cooldown), (1800.0, 5000.0))

    def test_jitter(self):
        pacer = make_pacer(100.0)
        waits = [pacer.next_wait() for _ in range(50)]
        self.assertTrue(all(80.0 <= wait <= 120.0 for wait in waits))
        self.assertGreater(len(set(waits)), 1)

    def test_pace_is_saved(self):
        cache = LyricsCache(':memory:')
        save_pace(cache, PaceState(interval=77.0, cooldown=60.0, streak=2, challenged=True))
        self.assertEqual(load_pace(cache, PaceState()), PaceState(77.0, 60.0, 2, True))
        cache.set_meta('shironet_pace', 'not json')
        self.assertEqual(load_pace(cache, PaceState()), PaceState())
        cache.close()


class ProcessItemTest(unittest.TestCase):
    def setUp(self):
        self.cache = LyricsCache(':memory:')
        self.client = FakeClient()
        self.pacer = make_pacer()
        self.waits = []

    def tearDown(self):
        self.cache.close()

    def process(self):
        item = queue.next_pending(self.cache)
        return process_item(self.cache, self.client, self.pacer, item, lambda: self.waits.append(1), lambda: 0.0)

    def test_fetch_stores_lyrics(self):
        queue.enqueue(self.cache, ARTIST, TITLE)
        self.assertEqual(self.process(), queue.DONE)
        entry = self.cache.get(ARTIST, TITLE)
        self.assertEqual((entry.lyrics, entry.source), (FIXTURE_LYRICS, SOURCE_SHIRONET))
        self.assertIn('wrkid=3005', entry.source_ref)
        self.assertEqual(len(self.client.urls), 2)
        self.assertEqual(len(self.waits), 2)
        self.assertEqual(queue.counts(self.cache), {('fetch', 'done'): 1})

    def test_no_match_is_not_found(self):
        queue.enqueue(self.cache, 'אמן אחר', TITLE)
        self.assertEqual(self.process(), queue.NOT_FOUND)
        self.assertEqual(len(self.client.urls), 1)
        self.assertEqual(queue.results(self.cache, 'fetch')[0][3], 'no match in 10 results')

    def test_challenge_on_lyrics_keeps_the_url_and_no_attempt(self):
        queue.enqueue(self.cache, ARTIST, TITLE)
        self.client.scripted = [Response(OK, 200, SEARCH), Response(CHALLENGE, 302, detail='perfdrive')]
        self.assertEqual(self.process(), CHALLENGE)
        item = queue.next_pending(self.cache)
        self.assertEqual(item.attempts, 0)
        self.assertIn('wrkid=3005', item.lyrics_url)
        # The retry skips the search.
        self.client.urls.clear()
        self.assertEqual(self.process(), queue.DONE)
        self.assertEqual(len(self.client.urls), 1)

    def test_errors_count_until_failed(self):
        queue.enqueue(self.cache, ARTIST, TITLE)
        for _ in range(MAX_ATTEMPTS):
            self.client.scripted = [Response(ERROR, 500, detail='500')]
            self.assertEqual(self.process(), ERROR)
        self.assertEqual(queue.counts(self.cache), {('fetch', 'failed'): 1})

    def test_calibration_compares_and_does_not_store(self):
        self.cache.put(ARTIST, TITLE, FIXTURE_LYRICS.replace('ראשונה', 'אחת'), SOURCE_EMBEDDED)
        queue.enqueue(self.cache, ARTIST, TITLE, queue.PURPOSE_CALIBRATE)
        self.assertEqual(self.process(), queue.DONE)
        result = queue.results(self.cache, queue.PURPOSE_CALIBRATE)[0][3]
        self.assertTrue(result.startswith('similarity 0.9'), result)
        self.assertEqual(self.cache.get(ARTIST, TITLE).source, SOURCE_EMBEDDED)

    def test_ok_requests_feed_the_pacer(self):
        queue.enqueue(self.cache, ARTIST, TITLE)
        self.process()
        self.assertEqual(self.pacer.state.streak, 2)


class RunTest(unittest.TestCase):
    def setUp(self):
        self.cache = LyricsCache(':memory:')
        self.client = FakeClient()
        self.time = FakeTime()

    def tearDown(self):
        self.cache.close()

    def run_worker(self, pacer, **kwargs):
        return run(self.cache, self.client, pacer, sleep=self.time.sleep, clock=self.time.clock, **kwargs)

    def test_drains_the_queue_with_waits_between_requests(self):
        queue.enqueue(self.cache, ARTIST, TITLE)
        queue.enqueue(self.cache, 'עופרה חזה', TITLE)
        stats = self.run_worker(make_pacer(100.0))
        self.assertEqual((stats.done, stats.requests, stats.stopped_because), (2, 4, 'queue empty'))
        self.assertEqual(len(self.time.sleeps), 3)  # none before the first request
        self.assertTrue(all(80.0 <= wait <= 120.0 for wait in self.time.sleeps))
        self.assertEqual(load_pace(self.cache, PaceState()).streak, 4)

    def test_challenge_cools_down_then_resumes(self):
        queue.enqueue(self.cache, ARTIST, TITLE)
        self.client.scripted = [Response(CHALLENGE, 302, detail='perfdrive')]
        challenges = []
        stats = self.run_worker(make_pacer(100.0), on_challenge=challenges.append)
        self.assertEqual((stats.challenges, stats.done), (1, 1))
        self.assertEqual(challenges, [1800.0])
        self.assertIn(1800.0, self.time.sleeps)
        state = load_pace(self.cache, PaceState())
        self.assertAlmostEqual(state.interval, 150.0)
        self.assertFalse(state.challenged)

    def test_stop_on_challenge(self):
        queue.enqueue(self.cache, ARTIST, TITLE)
        self.client.scripted = [Response(CHALLENGE, 302)]
        stats = self.run_worker(make_pacer(), stop_on_challenge=True)
        self.assertEqual(stats.stopped_because, 'challenge')
        self.assertEqual(self.time.sleeps, [])

    def test_limits(self):
        for number in range(5):
            queue.enqueue(self.cache, ARTIST, f'{TITLE} {number}')
        self.assertEqual(self.run_worker(make_pacer(), max_requests=3).stopped_because, 'request limit')
        self.assertEqual(self.run_worker(make_pacer(), max_seconds=0).stopped_because, 'time limit')
        self.assertEqual(self.run_worker(make_pacer(), should_stop=lambda: True).stopped_because, 'stopped')


class PaceReportTest(unittest.TestCase):
    def test_stretches_and_recovery(self):
        log = [
            (0.0, 'search', OK, 200, None),
            (60.0, 'lyrics', OK, 200, 60.0),
            (180.0, 'search', OK, 200, 120.0),
            (200.0, 'lyrics', CHALLENGE, 302, 20.0),
            (2000.0, 'lyrics', CHALLENGE, 302, 1800.0),
            (5600.0, 'lyrics', OK, 200, 3600.0),
            (5700.0, 'search', ERROR, None, 100.0),
        ]
        report = pace_report(log)
        self.assertEqual((report.requests, report.ok, report.challenges, report.errors), (7, 4, 2, 1))
        self.assertEqual(report.stretches, [(3, 90.0), (1, 3600.0)])
        self.assertEqual(report.recoveries, [5400.0])

    def test_empty(self):
        self.assertEqual(pace_report([]).stretches, [])


class SimilarityTest(unittest.TestCase):
    def test_whitespace_does_not_matter(self):
        self.assertEqual(similarity('a  b\nc', 'a b c'), 1.0)
        self.assertLess(similarity('abc', 'xyz'), 0.5)


if __name__ == '__main__':
    unittest.main()
