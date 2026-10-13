import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMechanismFile } from './mechanism-files.mjs';

describe('isMechanismFile', () => {
  it('仕組みの設定、スクリプト、ワークフローと、ルートの開発用のファイルを仕組みのファイルとする', () => {
    for (const path of [
      '.github/coding-agent/agents.json',
      '.github/scripts/coding-agent/route.mjs',
      '.github/workflows/coding-agent-router.yml',
      '.husky/commit-msg',
      'package.json',
    ]) {
      assert.equal(isMechanismFile(path), true, path);
    }
  });

  it('アプリケーションのコード、成果物、仕組みでないワークフローは、仕組みのファイルとしない', () => {
    for (const path of ['frontend/src/App.tsx', 'docs/features/1-login/requirements.md', '.github/workflows/ci.yml', 'README.md']) {
      assert.equal(isMechanismFile(path), false, path);
    }
  });
});
