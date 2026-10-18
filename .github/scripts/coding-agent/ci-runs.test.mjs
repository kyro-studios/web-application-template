import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { CI_WORKFLOW_FILE, CI_WORKFLOW_NAME, parseMergeQueueBranch } from './ci-runs.mjs';

describe('parseMergeQueueBranch', () => {
  const sha = 'df4207b923124bf7d195d9660ca411deae40994f';

  it('Merge Queue の CI のブランチ名から、PR の番号を読む', () => {
    // 確認用のリポジトリで実際に使われた形
    assert.equal(parseMergeQueueBranch(`gh-readonly-queue/develop/pr-59-${sha}`, 'develop'), 59);
  });

  it('既定ブランチの違うもの、形式の合わないものは読まない', () => {
    assert.equal(parseMergeQueueBranch(`gh-readonly-queue/main/pr-59-${sha}`, 'develop'), undefined);
    assert.equal(parseMergeQueueBranch(`gh-readonly-queue/develop/pr-59`, 'develop'), undefined);
    assert.equal(parseMergeQueueBranch(`gh-readonly-queue/develop/pr-0-${sha}`, 'develop'), undefined);
    assert.equal(parseMergeQueueBranch(`gh-readonly-queue/develop/pr-59-${sha}/extra`, 'develop'), undefined);
    assert.equal(parseMergeQueueBranch('coding-agent/claude/issue-1-1', 'develop'), undefined);
    assert.equal(parseMergeQueueBranch(null, 'develop'), undefined);
  });
});

describe('CI のワークフロー', () => {
  it('ファイル名と名前が、CI のワークフローと、振り分け用のワークフローの workflow_run に書いたものと一致する', async () => {
    const ci = await readFile(new URL(`../../workflows/${CI_WORKFLOW_FILE}`, import.meta.url), 'utf8');
    assert.match(ci, new RegExp(`^name: ${CI_WORKFLOW_NAME}$`, 'm'));
    const router = await readFile(new URL('../../workflows/coding-agent-router.yml', import.meta.url), 'utf8');
    assert.match(router, new RegExp(`workflows: \\[${CI_WORKFLOW_NAME}\\]`));
  });
});
