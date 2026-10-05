import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cueTexts,
  isSubtitleText,
  isSubtitleUrl,
  languageLabel,
  normalizeLanguage,
  parseSubtitle,
  parseTimestampOffset,
  shiftCues,
  toWebVtt,
  withTranslatedText,
} from '../src/subtitles';

test('an SRT file becomes WebVTT, cue numbers dropped and timings normalised', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    'Hello there',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    'Second line',
    '',
  ].join('\n');

  const file = parseSubtitle(srt);
  assert.equal(file.format, 'srt');
  assert.equal(file.cues.length, 2);
  // The `1` index line is structure, not text; the comma becomes a full stop.
  assert.deepEqual(file.cues[0], { timing: '00:00:01.000 --> 00:00:03.500', text: 'Hello there' });
  assert.deepEqual(file.cues[1], { timing: '00:00:04.000 --> 00:00:06.000', text: 'Second line' });

  const vtt = toWebVtt(file.cues);
  assert.ok(vtt.startsWith('WEBVTT\n'), 'the document is declared WebVTT');
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.500/);
  assert.match(vtt, /Hello there/);
});

test('a WebVTT file keeps its cue settings and gains padded hours', () => {
  const vtt = ['WEBVTT', 'Kind: captions', 'Language: en', '', 'NOTE a comment block', '', '01:02.500 --> 01:04.000 align:start position:0%', 'Short time', ''].join('\n');
  const file = parseSubtitle(vtt);
  assert.equal(file.format, 'vtt');
  assert.equal(file.cues.length, 1, 'the header and the NOTE block are not cues');
  assert.equal(file.cues[0]?.timing, '00:01:02.500 --> 00:01:04.000 align:start position:0%');
  assert.equal(file.cues[0]?.text, 'Short time');
});

test('multi-line cue text is preserved', () => {
  const file = parseSubtitle('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfirst line\nsecond line\n');
  assert.equal(file.cues[0]?.text, 'first line\nsecond line');
  assert.match(toWebVtt(file.cues), /first line\nsecond line/);
});

test('a language is normalised from whatever the manifest and host knew', () => {
  assert.equal(normalizeLanguage('en-US'), 'en');
  assert.equal(normalizeLanguage('ENG'), 'en');
  assert.equal(normalizeLanguage('ara'), 'ar');
  assert.equal(normalizeLanguage(undefined, 'English'), 'en');
  assert.equal(normalizeLanguage(undefined, 'العربية'), 'ar');
  assert.equal(normalizeLanguage(undefined, 'Arabic'), 'ar');
  assert.equal(normalizeLanguage(undefined, 'French (Canada)'), 'fr');
  // A guess would be worse than an honest unknown.
  assert.equal(normalizeLanguage(undefined, 'Klingon'), undefined);
  assert.equal(normalizeLanguage(''), undefined);
});

test('a language gets a readable label', () => {
  assert.equal(languageLabel('ar'), 'العربية');
  assert.equal(languageLabel('en'), 'English');
  assert.equal(languageLabel('xx'), 'XX');
});

test('the HLS timestamp map becomes a shift, so segments do not stack at zero', () => {
  assert.equal(parseTimestampOffset('X-TIMESTAMP-MAP=MPEGTS:180000,LOCAL:00:00:00.000'), 2);
  assert.equal(parseTimestampOffset('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx'), 0);

  const shifted = shiftCues([{ timing: '00:00:01.000 --> 00:00:03.000', text: 'x' }], 2);
  assert.equal(shifted[0]?.timing, '00:00:03.000 --> 00:00:05.000');
  assert.equal(shifted[0]?.text, 'x');
  // A zero shift is a no-op, not a rebuild that could lose a setting.
  const cues = [{ timing: '00:00:01.000 --> 00:00:02.000 align:center', text: 'x' }];
  assert.equal(shiftCues(cues, 0), cues);
});

test('translated text is applied without touching a single timing', () => {
  const cues = [
    { timing: '00:00:01.000 --> 00:00:02.000', text: 'one' },
    { timing: '00:00:03.000 --> 00:00:04.000', text: 'two' },
  ];
  assert.deepEqual(cueTexts(cues), ['one', 'two']);

  const arabic = withTranslatedText(cues, ['واحد', 'اثنان']);
  assert.deepEqual(
    arabic.map((cue) => cue.timing),
    cues.map((cue) => cue.timing),
  );
  assert.deepEqual(
    arabic.map((cue) => cue.text),
    ['واحد', 'اثنان'],
  );

  // A translation that came back empty keeps the original rather than blanking
  // a cue on screen.
  const partial = withTranslatedText(cues, ['واحد', '   ']);
  assert.equal(partial[1]?.text, 'two');
});

test('subtitle URLs and bodies are recognised without being guessed at', () => {
  assert.equal(isSubtitleUrl('https://host/subs/eng.vtt'), true);
  assert.equal(isSubtitleUrl('https://host/subs/eng.srt?token=1'), true);
  assert.equal(isSubtitleUrl('https://host/v1080/index.m3u8'), false);
  assert.equal(isSubtitleText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx'), true);
  assert.equal(isSubtitleText('<html><body>nope</body></html>'), false);
});
