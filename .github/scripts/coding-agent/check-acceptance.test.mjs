import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAcceptance, collectAcceptanceTests } from './check-acceptance.mjs';

/**
 * Playwright の JSON のレポートの形 (手元で acceptance/playwright.config.ts を動かして得たものから、使う項目だけを残した)
 *
 * @param {{ file: string, title: string, tags: string[], project: string, status: string }[]} specs
 */
function report(specs) {
  return {
    suites: specs.map((spec) => ({
      title: spec.file,
      specs: [{ title: spec.title, tags: spec.tags, tests: [{ projectName: spec.project, status: spec.status }] }],
      suites: [],
    })),
  };
}

const smoke = { file: 'smoke/app-starts.spec.ts', title: 'アプリケーションが起動し、/ に応答する', tags: [], project: 'smoke', status: 'expected' };

describe('collectAcceptanceTests', () => {
  it('acceptance のプロジェクトのテストだけを取り出し、識別子のタグを読む (起動の確認は数えない)', () => {
    const tests = collectAcceptanceTests(
      report([smoke, { file: 'tests/greeting.spec.ts', title: '挨拶を返す', tags: ['AC1-1', 'slow'], project: 'acceptance', status: 'expected' }]),
    );
    assert.deepEqual(tests, [{ title: 'tests/greeting.spec.ts › 挨拶を返す', criteria: ['AC1-1'], passed: true }]);
  });

  it('入れ子の describe のテストも取り出し、タグの先頭の @ を除く', () => {
    const tests = collectAcceptanceTests({
      suites: [
        {
          title: 'tests/a.spec.ts',
          specs: [],
          suites: [{ title: '挨拶', specs: [{ title: '空の名前', tags: ['@AC1-2'], tests: [{ projectName: 'acceptance', status: 'skipped' }] }], suites: [] }],
        },
      ],
    });
    assert.deepEqual(tests, [{ title: 'tests/a.spec.ts › 挨拶 › 空の名前', criteria: ['AC1-2'], passed: false }]);
  });
});

describe('checkAcceptance', () => {
  it('割り当てた基準ごとにテストがあり、すべて通っていれば、問題は無い。ほかのタスクの基準のテストがあってもよい', () => {
    const tests = [
      { title: 'a', criteria: ['AC1-1'], passed: true },
      { title: 'b', criteria: ['AC1-1'], passed: true },
      { title: 'c', criteria: ['AC1-5'], passed: true },
    ];
    assert.deepEqual(checkAcceptance(tests, ['AC1-1']), []);
    assert.deepEqual(checkAcceptance([], []), []);
  });

  it('テストの無い基準、通っていないテスト、タグが無いか 2 つ以上のテストを、まとめて報告する', () => {
    const problems = checkAcceptance(
      [
        { title: 'a', criteria: ['AC1-1'], passed: false },
        { title: 'b', criteria: [], passed: true },
        { title: 'c', criteria: ['AC1-3', 'AC1-4'], passed: true },
      ],
      ['AC1-1', 'AC1-2'],
    );
    assert.equal(problems.length, 4);
    assert.match(problems[0], /「b」に、受け入れ基準の識別子のタグ \(例: @AC12-3\) がありません/);
    assert.match(problems[1], /「c」に、受け入れ基準の識別子のタグが 2 つ付いています \(@AC1-3 @AC1-4\)/);
    assert.match(problems[2], /AC1-1 の受け入れテスト「a」が通っていません/);
    assert.match(problems[3], /AC1-2 の受け入れテスト \(タグ @AC1-2\) がありません/);
  });
});

describe('コマンドとしての実行 (run-tests.sh と同じ呼び出し方)', () => {
  const script = fileURLToPath(new URL('./check-acceptance.mjs', import.meta.url));
  /** @type {string} */
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'check-acceptance-'));
    await writeFile(
      join(dir, 'report.json'),
      JSON.stringify(report([smoke, { file: 'tests/g.spec.ts', title: '挨拶を返す', tags: ['AC1-1'], project: 'acceptance', status: 'expected' }])),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * @param {string[]} args
   * @returns {{ status: number, stdout: string }}
   */
  const run = (args) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (error) {
      const failure = /** @type {{ status: number, stdout: string }} */ (error);
      return { status: failure.status, stdout: failure.stdout };
    }
  };

  it('満たしていれば成功し、満たしていなければ内容を出力して失敗する', () => {
    assert.equal(run(['--criteria', 'AC1-1', '--report', join(dir, 'report.json')]).status, 0);
    const failed = run(['--criteria', 'AC1-1 AC1-2', '--report', join(dir, 'report.json')]);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /受け入れ基準の確認で、次の点を満たしていません。\n- 割り当てられた受け入れ基準 AC1-2 の受け入れテスト/);
  });

  it('レポートが無ければ、テストが 1 つも無いものとして扱う', () => {
    assert.equal(run(['--criteria', '', '--report', join(dir, 'missing.json')]).status, 0);
    assert.equal(run(['--criteria', 'AC1-1', '--report', join(dir, 'missing.json')]).status, 1);
  });
});
