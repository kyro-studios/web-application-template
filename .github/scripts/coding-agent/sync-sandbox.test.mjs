import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseOptions, syncCommitMessage } from './sync-sandbox.mjs';

describe('parseOptions', () => {
  it('取り込むブランチを省略すると main を取り込む', () => {
    assert.deepEqual(parseOptions(['--template', 'kyro-studios/template', '--sandbox', 'kyro-studios/sandbox']), {
      template: 'kyro-studios/template',
      sandbox: 'kyro-studios/sandbox',
      ref: 'main',
    });
    assert.equal(parseOptions(['--template=a/t', '--sandbox=a/s', '--ref=feature/x']).ref, 'feature/x');
  });

  it('リポジトリやブランチの指定が正しくなければ失敗する', () => {
    assert.throws(() => parseOptions(['--sandbox', 'a/s']), /--template/);
    assert.throws(() => parseOptions(['--template', 'a/t']), /--sandbox/);
    assert.throws(() => parseOptions(['--template', 'a/t', '--sandbox', 'A/T']), /別のリポジトリ/);
    assert.throws(() => parseOptions(['--template', 'a/t', '--sandbox', 'a/s', '--ref', '--upload-pack=x']), /--ref/);
  });
});

describe('syncCommitMessage', () => {
  it('取り込んだテンプレートのコミットを本文に残す', () => {
    assert.equal(
      syncCommitMessage('kyro-studios/template', 'bb14e4966617b80816f50d471e6c20c7567fcb46'),
      'chore: sync with template\n\nBring in kyro-studios/template@bb14e4966617b80816f50d471e6c20c7567fcb46.\n',
    );
  });
});
