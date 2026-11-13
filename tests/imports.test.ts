import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, parseCsv } from '../src/imports';

test('CSV preserves multiline cells, escaped quotes, Unicode and CRLF', () => {
  const rows = parseCsv('\uFEFFquestion,answer\r\n"Explain, with an example",yes\r\n"Line 1\nLine ""2""",réponse\r\n');
  assert.deepEqual(rows, [
    { question: 'Explain, with an example', answer: 'yes' },
    { question: 'Line 1\nLine "2"', answer: 'réponse' },
  ]);
});
test('malformed CSV and JSON fail explicitly rather than truncating or inventing records', () => {
  for (const bad of ['question,question\na,b', 'question,answer\n"unterminated', 'q,a\n1', 'q,a\n"x"oops,y']) assert.throws(() => parseCsv(bad));
  assert.throws(() => normalizeText('bad.json', '{broken'), /Invalid JSON/);
  assert.throws(() => normalizeText('bad.json', '4'), /object or array/);
  assert.throws(() => normalizeText('empty.csv', 'question,answer\n'), /no question records/);
  assert.throws(() => normalizeText('binary.txt', 'bad\u0000input'), /control characters/);
  assert.equal(normalizeText('text.md', '# Question\nExplain why.'), '# Question\nExplain why.');
  assert.deepEqual(JSON.parse(normalizeText('data.json', '[{"question":"Why?"}]')), [{ question: 'Why?' }]);
});
