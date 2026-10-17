import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTestFixPrompt, DEFAULT_TEST_FIX_ATTEMPTS, logTail, MAX_TEST_FIX_ATTEMPTS, maxTestFixAttempts } from './test-fix-prompt.mjs';

describe('maxTestFixAttempts', () => {
  it('Variables の値を使い、正しくなければ既定の 2 回にし、最大の 3 回を超えない', () => {
    assert.equal(DEFAULT_TEST_FIX_ATTEMPTS, 2);
    assert.equal(maxTestFixAttempts('1'), 1);
    assert.equal(maxTestFixAttempts(' 0 '), 0);
    assert.equal(maxTestFixAttempts('3'), 3);
    assert.equal(maxTestFixAttempts('10'), MAX_TEST_FIX_ATTEMPTS);
    assert.equal(maxTestFixAttempts(undefined), 2);
    assert.equal(maxTestFixAttempts(''), 2);
    assert.equal(maxTestFixAttempts('-1'), 2);
    assert.equal(maxTestFixAttempts('1.5'), 2);
  });

  it('コマンドとして実行すると、Variables の値から決めた上限を出力する (作成担当のワークフローと同じ呼び出し方)', async () => {
    const script = fileURLToPath(new URL('./test-fix-prompt.mjs', import.meta.url));
    const run = (/** @type {string | undefined} */ value) =>
      execFileSync(process.execPath, [script, '--print-max-attempts'], { encoding: 'utf8', env: { ...process.env, TEST_MAX_FIX_ATTEMPTS: value ?? '' } }).trim();
    assert.equal(run('3'), '3');
    assert.equal(run(''), String(DEFAULT_TEST_FIX_ATTEMPTS));

    const workflow = await readFile(new URL('../../workflows/coding-agent-claude.yml', import.meta.url), 'utf8');
    assert.ok(workflow.includes('max="$(node "$TRUSTED/.github/scripts/coding-agent/test-fix-prompt.mjs" --print-max-attempts)"'));
  });

  it('作成担当のワークフローに、テストの実行と直させるステップを、最大の回数まで並べている', async () => {
    const workflow = await readFile(new URL('../../workflows/coding-agent-claude.yml', import.meta.url), 'utf8');
    const fixSteps = [...workflow.matchAll(/^\s+id: claude-fix-(\d+)\r?$/gm)].map((match) => Number(match[1]));
    const testSteps = [...workflow.matchAll(/^\s+id: test-(\d+)\r?$/gm)].map((match) => Number(match[1]));
    assert.deepEqual(fixSteps, Array.from({ length: MAX_TEST_FIX_ATTEMPTS }, (_, index) => index + 1));
    assert.deepEqual(testSteps, Array.from({ length: MAX_TEST_FIX_ATTEMPTS + 1 }, (_, index) => index + 1));
  });
});

describe('logTail', () => {
  it('ログの末尾の決まった行数を取り出し、色の制御文字と改行の CR を取り除く', () => {
    const log = Array.from({ length: 5 }, (_, index) => `\u001b[31m行 ${index + 1}\u001b[0m\r`).join('\n');
    assert.equal(logTail(log, 2), '(先頭の 3 行を省略しました)\n行 4\n行 5');
    assert.equal(logTail('1 行だけ\n', 2), '1 行だけ');
  });
});

describe('buildTestFixPrompt', () => {
  it('最初の指示に、テストの失敗の指示、回数、失敗したログの末尾、前回の出力を続ける', () => {
    const prompt = buildTestFixPrompt({
      prompt: '最初の指示\n',
      instruction: '## テストの失敗\n\n直してください\n',
      log: 'FAILED HealthTest\n',
      previous: '{"commit_message":"feat: x"}',
      attempt: 1,
      maxAttempts: 2,
    });

    assert.match(prompt, /^最初の指示\n\n## テストの失敗\n\n直してください\n\n- 直させる回数: 1 回目 \(上限 2 回\)\n/);
    assert.match(prompt, /### 失敗したログの末尾\n\n~~~text\nFAILED HealthTest\n~~~/);
    assert.match(prompt, /### 前回の出力\n\n~~~text\n\{"commit_message":"feat: x"\}\n~~~\n$/);
  });

  it('前回の出力が無ければ、無いと書く', () => {
    const prompt = buildTestFixPrompt({ prompt: '指示', instruction: '失敗', log: 'x', previous: '', attempt: 2, maxAttempts: 3 });
    assert.match(prompt, /### 前回の出力\n\n~~~text\n\(ありません\)\n~~~/);
  });
});
