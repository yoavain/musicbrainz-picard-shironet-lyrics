import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheKey, cleanLyrics, collapseLines, hasHebrew, hasHebrewName, normalize, singleLine,
} from '../src/text.ts';

describe('normalize (ported cases)', () => {
  test('empty', () => {
    assert.equal(normalize(null), '');
    assert.equal(normalize(undefined), '');
    assert.equal(normalize('  '), '');
  });
  test('latin case and punctuation', () => {
    assert.equal(normalize("Don't Stop Me Now!"), 'dont stop me now');
    assert.equal(normalize('Beyoncé'), 'beyonce');
  });
  test('niqqud is dropped', () => {
    assert.equal(normalize('שִׁיר לַשָּׁלוֹם'), 'שיר לשלום');
  });
  test('geresh, gershayim and quotes', () => {
    assert.equal(normalize('ג׳ינס'), normalize("ג'ינס"));
    assert.equal(normalize('להקת הנח״ל'), normalize('להקת הנח"ל'));
    assert.equal(normalize('להקת הנח"ל'), 'להקת הנחל');
  });
  test('maqaf and dash separate words', () => {
    assert.equal(normalize('בית־לחם'), 'בית לחם');
    assert.equal(normalize('בית-לחם'), 'בית לחם');
  });
  test('featuring is dropped', () => {
    assert.equal(normalize('Song (feat. Someone)'), 'song');
    assert.equal(normalize('Artist ft. Other'), 'artist');
    assert.equal(normalize('Artist featuring Other'), 'artist');
  });
  test('featuring needs a whole word', () => {
    assert.equal(normalize('Gift'), 'gift');
    assert.equal(normalize('Feather'), 'feather');
  });
  test('version suffixes are dropped', () => {
    assert.equal(normalize('Song (Live)'), 'song');
    assert.equal(normalize('Song [Remastered 2011]'), 'song');
    assert.equal(normalize('Song - Remastered 2011'), 'song');
    assert.equal(normalize('Song (Live) [Remastered]'), 'song');
    assert.equal(normalize('שיר לשלום (בהופעה חיה)'), 'שיר לשלום');
    assert.equal(normalize('שיר לשלום - גרסה אקוסטית'), 'שיר לשלום');
  });
  test('other brackets are kept', () => {
    assert.equal(normalize('שיר (בלי שם)'), 'שיר בלי שם');
    assert.equal(normalize('Live and Let Die'), 'live and let die');
  });
});

describe('normalize (Hebrew cases added by the spec)', () => {
  test('word boundaries work next to Hebrew letters, as in Python', () => {
    // JavaScript's \b is ASCII-only; these pass only with the Unicode lookarounds.
    assert.equal(normalize('שיר (לייבים)'), 'שיר לייבים');
    assert.equal(normalize('שיר (סלייב)'), 'שיר סלייב');
    assert.equal(normalize('Song (Lively)'), 'song lively');
  });
  test('format characters are dropped from keys', () => {
    assert.equal(normalize('שיר\u200F לשלום'), 'שיר לשלום'); // RLM
    assert.equal(normalize('\u200Eשיר'), 'שיר'); // LRM
    assert.equal(normalize('\u2067שיר\u2069'), 'שיר'); // RLI ... PDI
    assert.equal(normalize('\u202Bשיר\u202C'), 'שיר'); // RLE ... PDF
    assert.equal(normalize('\uFEFFשיר'), 'שיר'); // BOM
    assert.equal(normalize('ש\u200Dי\u200Cר'), 'שיר'); // ZWJ, ZWNJ
  });
  test('a direction mark does not block a version suffix', () => {
    assert.equal(normalize('שיר לשלום\u200F (בהופעה חיה)\u200F'), 'שיר לשלום');
  });
  test('presentation forms match plain letters', () => {
    assert.equal(normalize('\uFB2A\uFB35'), 'שו'); // shin with shin dot, vav with dagesh
  });
  test('case folding follows Python casefold', () => {
    assert.equal(normalize('Straße'), 'strasse');
    assert.equal(normalize('ΣΟΦΟΣ'), normalize('σοφος'));
  });
  test('names with no letters give an empty key', () => {
    assert.equal(normalize('!!!'), '');
    assert.equal(normalize('\u05B8\u05B4'), ''); // niqqud only
    assert.equal(normalize('\u200F\u200E'), ''); // direction marks only
  });
  test('mixed Hebrew and Latin', () => {
    assert.equal(normalize('Love שיר (Live)'), 'love שיר');
  });
});

describe('cacheKey', () => {
  test('normalizes both parts', () => {
    assert.deepEqual(cacheKey('להקת הנח״ל', 'שִׁיר לַשָּׁלוֹם (Live)'), ['להקת הנחל', 'שיר לשלום']);
  });
});

describe('Hebrew rule', () => {
  test('hasHebrew', () => {
    assert.equal(hasHebrew('שיר לשלום'), true);
    assert.equal(hasHebrew('Love שיר'), true);
    assert.equal(hasHebrew('Love Song'), false);
    assert.equal(hasHebrew(null), false);
  });
  test('niqqud or punctuation alone is not Hebrew', () => {
    assert.equal(hasHebrew('\u05B8\u05BE\u05F3'), false); // qamats, maqaf, geresh
  });
  test('presentation forms are Hebrew', () => {
    assert.equal(hasHebrew('\uFB2A'), true);
  });
  test('a Hebrew title or artist makes a Hebrew name', () => {
    assert.equal(hasHebrewName(['Mashina', 'את לא כמו כולם']), true);
    assert.equal(hasHebrewName(['משינה', 'Rakevet Layla']), true);
    assert.equal(hasHebrewName(['R.E.M.', 'The One I Love']), false);
  });
  test('missing names are ignored', () => {
    assert.equal(hasHebrewName([null, undefined, 'שיר']), true);
    assert.equal(hasHebrewName([]), false);
  });
});

describe('cleanLyrics (ported cases)', () => {
  test('line endings and trailing spaces', () => {
    assert.equal(cleanLyrics('\r\n line 1  \r\nline 2\r\rline 3\n\n'), 'line 1\nline 2\n\nline 3');
  });
  test('empty', () => {
    assert.equal(cleanLyrics(null), '');
    assert.equal(cleanLyrics(' \n \n'), '');
  });
  test('language prefix is removed', () => {
    assert.equal(cleanLyrics('heb||שורה 1\nשורה 2'), 'שורה 1\nשורה 2');
    assert.equal(cleanLyrics('eng|None|Line 1'), 'Line 1');
    assert.equal(cleanLyrics('eng||\nLine 1'), 'Line 1');
  });
  test('pipes inside lyrics are kept', () => {
    assert.equal(cleanLyrics('a | b | c'), 'a | b | c');
    assert.equal(cleanLyrics('Line 1\nheb||Line 2'), 'Line 1\nheb||Line 2');
  });
  test('title and credit header is removed', () => {
    const text = 'שם השיר\n\nביצוע: להקה\nמילים: כותב\nלחן: מלחין\n\n\n\n שורה ראשונה\nשורה שנייה';
    assert.equal(cleanLyrics(text), 'שורה ראשונה\nשורה שנייה');
  });
  test('combined credit labels', () => {
    assert.equal(cleanLyrics('שיר\nמילים ולחן: שלמה ארצי\nשורה'), 'שורה');
    assert.equal(cleanLyrics('שיר\nלחן, עיבוד: מישהו\nשורה'), 'שורה');
    assert.equal(cleanLyrics('Song\nArrangement: Someone\nLine'), 'Line');
    assert.equal(cleanLyrics('heb||שיר\nביצוע: להקה\nשורה'), 'שורה');
  });
  test('spoken lines with a colon are kept', () => {
    const text = 'הוא אמר:\nבוא נלך\nפזמון:\nלה לה';
    assert.equal(cleanLyrics(text), text);
  });
  test('credit label far down is kept', () => {
    const text = [...Array(10).keys()].map((n) => `שורה ${n}`).join('\n') + '\nמילים: אלה מילים';
    assert.equal(cleanLyrics(text), text);
  });
  test('instrumental placeholder is empty', () => {
    assert.equal(cleanLyrics('instrumental'), '');
    assert.equal(cleanLyrics('heb||[Instrumental]'), '');
    assert.equal(cleanLyrics('heb||אינסטרומנטלי\n(ופתיחה לאלבום)'), '');
  });
  test('lyrics mentioning instrumental are kept', () => {
    const text = 'Instrumental break\nThen we sing\nAnd sing\nAnd sing again';
    assert.equal(cleanLyrics(text), text);
    assert.equal(cleanLyrics('An instrumental song'), 'An instrumental song');
  });
  test('stored text keeps niqqud and direction marks', () => {
    const text = 'שִׁיר\u200F לַשָּׁלוֹם';
    assert.equal(cleanLyrics(text), text);
  });
});

describe('collapseLines and singleLine', () => {
  test('collapseLines collapses whitespace per line and keeps line breaks', () => {
    assert.equal(collapseLines(' שורה  ראשונה \nשורה\u00A0שנייה\n\nבית'), 'שורה ראשונה\nשורה שנייה\n\nבית');
  });
  test('singleLine joins everything into one line', () => {
    assert.equal(singleLine(' שיר \n לשלום '), 'שיר לשלום');
  });
});
