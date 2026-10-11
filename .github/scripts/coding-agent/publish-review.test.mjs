import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSubmission, commentableLines } from './publish-review.mjs';

describe('commentableLines', () => {
  it('追加した行と前後の行の、変更後の行の番号を返す', () => {
    const patch = ['@@ -1,3 +1,4 @@', ' 1 行目', '-古い 2 行目', '+新しい 2 行目', '+追加した 3 行目', ' 4 行目', '@@ -10,2 +11,2 @@', ' 11 行目', '\\ No newline at end of file'].join('\n');
    assert.deepEqual([...commentableLines(patch)], [1, 2, 3, 4, 11]);
  });

  it('差分が無いファイル (バイナリなど) では、どの行にもコメントできない', () => {
    assert.equal(commentableLines(undefined).size, 0);
  });
});

describe('buildSubmission', () => {
  const commentable = new Map([['docs/spec.md', new Set([3, 4])]]);
  const base = { commentable, stage: 'specification', reviewerName: 'Codex', runUrl: 'https://example.com/run' };

  it('must の指摘があれば差し戻し、差分の中の行への指摘は行へのコメントにする', () => {
    const submission = buildSubmission({
      ...base,
      review: {
        summary: '所見',
        findings: [
          { severity: 'must', path: 'docs/spec.md', line: 3, body: '要件が漏れている' },
          { severity: 'must', path: 'docs/spec.md', line: 99, body: '差分の外の指摘' },
          { severity: 'should', path: null, line: null, body: '全体への提案' },
          { severity: 'nit', path: 'docs/spec.md', line: 4, body: '表記の揺れ' },
        ],
      },
    });

    assert.equal(submission.event, 'REQUEST_CHANGES');
    assert.deepEqual(submission.comments, [{ path: 'docs/spec.md', line: 3, side: 'RIGHT', body: '**[must]** 要件が漏れている' }]);
    assert.match(submission.body, /^🤖 「仕様書」のレビューで、must の指摘があるため差し戻します。/);
    assert.match(submission.body, /## must\n\n- `docs\/spec\.md` の 99 行目: 差分の外の指摘/);
    assert.match(submission.body, /## should\n\n- 全体への提案/);
    // nit は差分の中の行でも、行へのコメントにせず本文にまとめる
    assert.match(submission.body, /## nit\n\n- `docs\/spec\.md` の 4 行目: 表記の揺れ/);
    assert.match(submission.body, /Codex によるレビューです \(\[ワークフロー\]\(https:\/\/example\.com\/run\)\)$/);
  });

  it('must の指摘が無ければ Approve し、should の指摘も残す', () => {
    const submission = buildSubmission({
      ...base,
      review: { summary: '問題ありません', findings: [{ severity: 'should', path: 'docs/spec.md', line: 4, body: '例を足すと良い' }] },
    });

    assert.equal(submission.event, 'APPROVE');
    assert.deepEqual(submission.comments, [{ path: 'docs/spec.md', line: 4, side: 'RIGHT', body: '**[should]** 例を足すと良い' }]);
    assert.match(submission.body, /承認し、Merge Queue でマージします/);
  });
});
