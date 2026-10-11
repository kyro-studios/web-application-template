import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { toDispatch, validateRequest, writeRequest } from './agent-request.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * @param {Partial<import('./agent-request.mjs').AgentRequest>} [overrides]
 * @returns {import('./agent-request.mjs').AgentRequest}
 */
function createRequest(overrides = {}) {
  return {
    id: 'issue-12',
    agent: 'claude',
    mode: 'create',
    stage: 'specification',
    issueNumber: 12,
    pullRequestNumber: null,
    targetSha: SHA,
    materials: { documents: ['docs/features/10-login/requirements.md'] },
    ...overrides,
  };
}

describe('validateRequest', () => {
  it('正しい依頼では問題を報告しない', () => {
    assert.deepEqual(validateRequest(createRequest()), []);
    assert.deepEqual(validateRequest(createRequest({ mode: 'fix', pullRequestNumber: 34 })), []);
    assert.deepEqual(validateRequest(createRequest({ mode: 'review', stage: 'requirements', pullRequestNumber: 34 })), []);
  });

  it('修正やレビューの依頼には PR の番号が必要で、作成の依頼には指定できない', () => {
    assert.match(validateRequest(createRequest({ mode: 'fix' })).join('\n'), /PR の番号が必要/);
    assert.match(validateRequest(createRequest({ mode: 'review' })).join('\n'), /PR の番号が必要/);
    assert.match(validateRequest(createRequest({ pullRequestNumber: 34 })).join('\n'), /PR の番号は指定できません/);
  });

  it('識別子、段階、Issue の番号、SHA の形式を確認する', () => {
    const errors = validateRequest(
      createRequest({
        id: '../issue',
        // @ts-expect-error 想定外の値を渡す
        stage: 'design',
        issueNumber: 0,
        targetSha: 'main',
      }),
    );
    assert.equal(errors.length, 4);
  });
});

describe('toDispatch', () => {
  it('workflow_dispatch の入力をすべて文字列にする', () => {
    const dispatch = toDispatch(createRequest({ mode: 'fix', pullRequestNumber: 34 }), 'coding-agent-claude.yml', '987');
    assert.deepEqual(dispatch, {
      requestId: 'issue-12',
      agent: 'claude',
      workflow: 'coding-agent-claude.yml',
      inputs: {
        mode: 'fix',
        stage: 'specification',
        'issue-number': '12',
        'pull-request-number': '34',
        'target-sha': SHA,
        'request-run-id': '987',
        'request-id': 'issue-12',
      },
    });
    assert.equal(toDispatch(createRequest(), 'coding-agent-claude.yml', '987').inputs['pull-request-number'], '');
  });
});

describe('writeRequest', () => {
  it('依頼を識別子のファイル名で保存し、同じ識別子の上書きを防ぐ', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-agent-request-'));
    try {
      const request = createRequest();
      const path = await writeRequest(dir, request);
      assert.equal(path, join(dir, 'issue-12.json'));
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), request);
      await assert.rejects(writeRequest(dir, request), { code: 'EEXIST' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
