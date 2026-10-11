import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findViolations, matchesAny } from './changed-files.mjs';

describe('matchesAny', () => {
  it('. で始まるパスにも ** を当てはめる', () => {
    assert.equal(matchesAny('.github/workflows/ci.yml', ['**']), true);
    assert.equal(matchesAny('.github/workflows/ci.yml', ['.github/**']), true);
    assert.equal(matchesAny('src/main.ts', ['.github/**']), false);
  });
});

describe('findViolations', () => {
  const documentRange = { allow: ['docs/features/1-login/requirements.md'], deny: [] };
  const implementationRange = { allow: ['**'], deny: ['.github/**', 'docs/features/**', 'AGENTS.md'] };

  it('変更してよいファイルだけなら、何も返さない', () => {
    assert.deepEqual(findViolations([{ filename: 'docs/features/1-login/requirements.md' }], documentRange), []);
    assert.deepEqual(findViolations([{ filename: 'src/main/App.java' }, { filename: 'web/src/App.tsx' }], implementationRange), []);
  });

  it('allow に当てはまらないファイルや、deny に当てはまるファイルを返す', () => {
    assert.deepEqual(
      findViolations(
        [{ filename: 'docs/features/1-login/requirements.md' }, { filename: 'docs/features/1-login/specification.md' }, { filename: 'README.md' }],
        documentRange,
      ),
      ['docs/features/1-login/specification.md', 'README.md'],
    );
    assert.deepEqual(
      findViolations([{ filename: 'src/App.java' }, { filename: '.github/workflows/ci.yml' }, { filename: 'AGENTS.md' }], implementationRange),
      ['.github/workflows/ci.yml', 'AGENTS.md'],
    );
  });

  it('名前を変えたファイルは、変更前のパスも確かめる', () => {
    assert.deepEqual(findViolations([{ filename: 'src/old.md', previous_filename: 'docs/features/1-login/architecture.md' }], implementationRange), [
      'docs/features/1-login/architecture.md',
    ]);
  });
});
