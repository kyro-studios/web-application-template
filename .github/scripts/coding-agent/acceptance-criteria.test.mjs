import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AcceptanceCriteriaError,
  buildCriteriaFile,
  criterionId,
  formatCriteriaFile,
  parseCriterionId,
  readCriteriaAt,
  readCriteriaSchema,
  validateCriteriaFile,
} from './acceptance-criteria.mjs';
import { acceptanceCriteriaPath } from './stages.mjs';

/**
 * @param {Partial<import('./acceptance-criteria.mjs').OutputCriterion>} [overrides]
 * @returns {import('./acceptance-criteria.mjs').OutputCriterion}
 */
function outputCriterion(overrides = {}) {
  return { id: null, kind: 'api', behavior: '正しいパスワードでログインする', expected: '200 を返す', spec_reference: '2.1 ログイン', ...overrides };
}

/** @type {import('./acceptance-criteria.mjs').CriteriaFile} */
const CURRENT = {
  feature: 12,
  next_number: 4,
  criteria: [
    { id: 'AC12-1', kind: 'api', behavior: 'a', expected: 'b', spec_reference: 'c' },
    { id: 'AC12-3', kind: 'screen', behavior: 'd', expected: 'e', spec_reference: 'f' },
  ],
};

describe('criterionId と parseCriterionId', () => {
  it('AC<機能の親 Issue の番号>-<連番> の形で作り、読み取る', () => {
    assert.equal(criterionId(12, 3), 'AC12-3');
    assert.deepEqual(parseCriterionId('AC12-3'), { feature: 12, number: 3 });
    for (const invalid of ['AC12-0', 'AC0-1', 'AC12', 'ac12-3', 'AC12-3 ', 'AC012-3']) {
      assert.equal(parseCriterionId(invalid), undefined, invalid);
    }
  });

  it('機能ごとのディレクトリの中に、受け入れ基準のファイルを置く', () => {
    assert.equal(acceptanceCriteriaPath('docs/features/12-user-login'), 'docs/features/12-user-login/acceptance-criteria.json');
  });
});

describe('buildCriteriaFile', () => {
  it('今の基準が無ければ、1 から順に識別子を振る', () => {
    const file = buildCriteriaFile({ feature: 12, current: null, output: [outputCriterion(), outputCriterion({ kind: 'screen' })] });
    assert.deepEqual(
      file.criteria.map((criterion) => criterion.id),
      ['AC12-1', 'AC12-2'],
    );
    assert.equal(file.next_number, 3);
    assert.equal(file.feature, 12);
  });

  it('残す基準は同じ識別子のまま、新しい基準に続きの番号を振り、消えた番号は使い回さない', () => {
    const file = buildCriteriaFile({
      feature: 12,
      current: CURRENT,
      output: [outputCriterion({ id: 'AC12-3' }), outputCriterion(), outputCriterion({ behavior: '  前後の空白を除く  ' })],
    });
    assert.deepEqual(
      file.criteria.map((criterion) => criterion.id),
      ['AC12-3', 'AC12-4', 'AC12-5'],
    );
    assert.equal(file.next_number, 6);
    assert.equal(file.criteria[2].behavior, '前後の空白を除く');
    // 残した基準の中身は、出力の内容に置き換える
    assert.equal(file.criteria[0].behavior, '正しいパスワードでログインする');
  });

  it('今の基準に無い識別子、重なった識別子、空の項目、正しくない種類を、まとめて報告する', () => {
    assert.throws(
      () =>
        buildCriteriaFile({
          feature: 12,
          current: CURRENT,
          output: [
            outputCriterion({ id: 'AC12-2' }),
            outputCriterion({ id: 'AC12-1' }),
            outputCriterion({ id: 'AC12-1' }),
            outputCriterion({ expected: ' ' }),
            outputCriterion({ kind: /** @type {any} */ ('unit') }),
          ],
        }),
      (/** @type {unknown} */ error) => {
        assert.ok(error instanceof AcceptanceCriteriaError);
        assert.equal(error.problems.length, 4);
        assert.match(error.problems[0], /1 件目: 識別子 AC12-2 は、今の受け入れ基準にありません/);
        assert.match(error.problems[1], /3 件目: 識別子 AC12-1 が 2 回以上出てきます/);
        assert.match(error.problems[2], /4 件目: expected が空です/);
        assert.match(error.problems[3], /5 件目: kind は api か screen/);
        return true;
      },
    );
  });

  it('文面に仕組みの印を含む基準は受け付けない (実装タスクの Issue の本文に書き写すため)', () => {
    assert.throws(
      () => buildCriteriaFile({ feature: 12, current: null, output: [outputCriterion({ expected: '<!-- coding-agent-acceptance-criteria: AC12-1 -->' })] }),
      /expected に、仕組みの印/,
    );
  });

  it('受け入れ基準が 1 件も無ければ失敗にする', () => {
    for (const output of [[], undefined, 'text']) {
      assert.throws(() => buildCriteriaFile({ feature: 12, current: null, output }), AcceptanceCriteriaError);
    }
  });
});

describe('validateCriteriaFile', () => {
  /** @type {object} */
  let schema;
  before(async () => {
    schema = await readCriteriaSchema();
  });

  it('作ったファイルは、形式と決まりを満たす', () => {
    const file = buildCriteriaFile({ feature: 12, current: CURRENT, output: [outputCriterion({ id: 'AC12-1' }), outputCriterion()] });
    assert.deepEqual(validateCriteriaFile(file, schema, { feature: 12 }), []);
  });

  it('形式の誤りを報告する', () => {
    const errors = validateCriteriaFile({ feature: 12, next_number: 2, criteria: [{ id: 'X-1', kind: 'api' }] }, schema);
    assert.ok(errors.length > 0);
  });

  it('識別子の重なり、機能の番号の食い違い、next_number 以上の連番を報告する', () => {
    const errors = validateCriteriaFile(
      {
        feature: 12,
        next_number: 3,
        criteria: [
          { id: 'AC12-1', kind: 'api', behavior: 'a', expected: 'b', spec_reference: 'c' },
          { id: 'AC12-1', kind: 'api', behavior: 'a', expected: 'b', spec_reference: 'c' },
          { id: 'AC13-2', kind: 'api', behavior: 'a', expected: 'b', spec_reference: 'c' },
          { id: 'AC12-3', kind: 'api', behavior: 'a', expected: 'b', spec_reference: 'c' },
        ],
      },
      schema,
      { feature: 13 },
    );
    assert.equal(errors.length, 4);
    assert.match(errors[0], /一致しません/);
    assert.match(errors[1], /AC12-1 が重なっています/);
    assert.match(errors[2], /AC13-2 が、機能の親 Issue の番号 \(12\) の形式/);
    assert.match(errors[3], /AC12-3 の連番が、next_number \(3\) より小さくありません/);
  });
});

describe('formatCriteriaFile', () => {
  it('インデントは 2 文字で、最後に改行を付ける', () => {
    const text = formatCriteriaFile({ feature: 1, next_number: 2, criteria: [{ id: 'AC1-1', kind: 'api', behavior: 'a', expected: 'b', spec_reference: 'c' }] });
    assert.ok(text.startsWith('{\n  "feature": 1,'));
    assert.ok(text.endsWith('}\n'));
  });
});

describe('コマンドとしての実行 (作成担当のワークフローと同じ呼び出し方)', () => {
  const script = fileURLToPath(new URL('./acceptance-criteria.mjs', import.meta.url));
  const featureDir = 'docs/features/12-user-login';
  /** @type {string} */
  let repo;
  /** @type {string} */
  let baseSha;

  const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'acceptance-criteria-'));
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'core.autocrlf', 'false');
    await mkdir(join(repo, featureDir), { recursive: true });
    await writeFile(join(repo, acceptanceCriteriaPath(featureDir)), formatCriteriaFile(CURRENT));
    git('add', '--all');
    git('commit', '-q', '-m', 'init');
    baseSha = git('rev-parse', 'HEAD');
    await writeFile(
      join(repo, 'request.json'),
      JSON.stringify({ stage: 'specification', materials: { featureDir, feature: { number: 12, title: '', body: '' } } }),
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /**
   * @param {unknown} output
   * @returns {{ status: number, stdout: string, stderr: string }}
   */
  const run = (output) => {
    execFileSync(process.execPath, ['-e', `require('fs').writeFileSync('output.json', ${JSON.stringify(JSON.stringify(output))})`], { cwd: repo });
    try {
      const stdout = execFileSync(process.execPath, [script, '--request', 'request.json', '--output', 'output.json', '--base-sha', baseSha], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = /** @type {{ status: number, stdout: string, stderr: string }} */ (error);
      return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
    }
  };

  it('作業を始めたコミットの基準をもとに、ファイルを書き出す。作業ディレクトリのファイルは読まない', async () => {
    // エージェントが作業ディレクトリのファイルを書き換えていても、影響されない
    await writeFile(join(repo, acceptanceCriteriaPath(featureDir)), '{ "壊れた": ');
    const result = run({ commit_message: 'docs: x', pull_request_body: 'y', acceptance_criteria: [outputCriterion({ id: 'AC12-1' }), outputCriterion()] });
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(await readFile(join(repo, acceptanceCriteriaPath(featureDir)), 'utf8'));
    assert.deepEqual(
      written.criteria.map((/** @type {{ id: string }} */ criterion) => criterion.id),
      ['AC12-1', 'AC12-4'],
    );
    assert.equal(written.next_number, 5);
  });

  it('出力を検証できなければ、ファイルを書かずに失敗する', async () => {
    await writeFile(join(repo, acceptanceCriteriaPath(featureDir)), 'unchanged');
    const result = run({ commit_message: 'docs: x', pull_request_body: 'y', acceptance_criteria: [outputCriterion({ id: 'AC12-9' })] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AC12-9 は、今の受け入れ基準にありません/);
    assert.equal(await readFile(join(repo, acceptanceCriteriaPath(featureDir)), 'utf8'), 'unchanged');
  });

  it('コミットにファイルが無いパスでは、今の基準が無いものとして読む', () => {
    assert.equal(readCriteriaAt({ sha: baseSha, path: 'docs/features/99-none/acceptance-criteria.json', cwd: repo }), null);
    assert.deepEqual(readCriteriaAt({ sha: baseSha, path: acceptanceCriteriaPath(featureDir), cwd: repo }), CURRENT);
  });
});
