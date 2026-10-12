import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { classifyPath, parseOptions, planSync, syncCommitMessage } from './sync-sandbox.mjs';

describe('parseOptions', () => {
  it('取り込むブランチを省略すると main を取り込む', () => {
    assert.deepEqual(parseOptions(['--template', 'kyro-studios/template', '--sandbox', 'kyro-studios/sandbox']), {
      template: 'kyro-studios/template',
      sandbox: 'kyro-studios/sandbox',
      ref: 'main',
      agents: undefined,
    });
    assert.equal(parseOptions(['--template=a/t', '--sandbox=a/s', '--ref=feature/x']).ref, 'feature/x');
    assert.equal(parseOptions(['--template=a/t', '--sandbox=a/s', '--agents=agents.json']).agents, resolve('agents.json'));
  });

  it('リポジトリやブランチの指定が正しくなければ失敗する', () => {
    assert.throws(() => parseOptions(['--sandbox', 'a/s']), /--template/);
    assert.throws(() => parseOptions(['--template', 'a/t']), /--sandbox/);
    assert.throws(() => parseOptions(['--template', 'a/t', '--sandbox', 'A/T']), /別のリポジトリ/);
    assert.throws(() => parseOptions(['--template', 'a/t', '--sandbox', 'a/s', '--ref', '--upload-pack=x']), /--ref/);
  });
});

describe('classifyPath', () => {
  it('仕組みのファイルは取り込む', () => {
    for (const path of [
      '.github/coding-agent/stages.json',
      '.github/coding-agent/prompts/create/common.md',
      '.github/scripts/coding-agent/handlers/launch-stage.mjs',
      '.github/workflows/coding-agent-router.yml',
      '.github/workflows/validate-conventional-commits.yml',
      '.github/ISSUE_TEMPLATE/feature.yml',
      '.husky/commit-msg',
      'commitlint.config.mjs',
      'package.json',
      'package-lock.json',
      'scripts/postinstall.js',
    ]) {
      assert.equal(classifyPath(path), 'synced', path);
    }
  });

  it('確認用のリポジトリに固有の設定と、テンプレートから作ったリポジトリが書き換えるファイルは取り込まない', () => {
    for (const path of ['.github/coding-agent/agents.json', '.gitignore', 'README.md', 'AGENTS.md', '.vscode/settings.json']) {
      assert.equal(classifyPath(path), 'not-synced', path);
    }
  });

  it('アプリケーションのコードや成果物は、どちらにも分類しない', () => {
    for (const path of [
      'backend/build.gradle.kts',
      'frontend/src/App.tsx',
      'compose.yaml',
      'docs/features/35-announcements/requirements.md',
      '.github/workflows/app-ci.yml',
      '.github/ISSUE_TEMPLATE/bug.yml',
      'scripts/seed.sh',
      'backend/README.md',
    ]) {
      assert.equal(classifyPath(path), undefined, path);
    }
  });
});

describe('planSync', () => {
  it('取り込む範囲の外のファイルには触れない', () => {
    const plan = planSync(
      ['.github/coding-agent/stages.json', 'README.md', '.gitignore'],
      ['.github/coding-agent/stages.json', 'README.md', '.gitignore', 'backend/Main.java', 'frontend/src/App.tsx', 'compose.yaml', 'docs/features/1-x/requirements.md'],
    );
    assert.deepEqual(plan, { checkout: ['.github/coding-agent/stages.json'], remove: [], unclassified: [] });
  });

  it('取り込む範囲の中で、テンプレートに無いファイルは削除する', () => {
    const plan = planSync(
      ['.github/scripts/coding-agent/route.mjs', '.github/workflows/coding-agent-router.yml'],
      [
        '.github/scripts/coding-agent/route.mjs',
        '.github/scripts/coding-agent/old.mjs',
        '.github/workflows/coding-agent-old.yml',
        '.github/workflows/app-ci.yml',
      ],
    );
    assert.deepEqual(plan.remove, ['.github/scripts/coding-agent/old.mjs', '.github/workflows/coding-agent-old.yml']);
    assert.deepEqual(plan.checkout, ['.github/scripts/coding-agent/route.mjs', '.github/workflows/coding-agent-router.yml']);
  });

  it('agents.json は、テンプレートにあっても無くても、変更も削除もしない', () => {
    assert.deepEqual(planSync(['.github/coding-agent/agents.json'], ['.github/coding-agent/agents.json']).checkout, []);
    assert.deepEqual(planSync([], ['.github/coding-agent/agents.json']).remove, []);
  });

  it('テンプレートのファイルのうち、分類されていないものを返す', () => {
    const plan = planSync(['package.json', 'renovate.json', 'docs/guide.md'], []);
    assert.deepEqual(plan.unclassified, ['renovate.json', 'docs/guide.md']);
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
