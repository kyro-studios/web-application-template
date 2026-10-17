/**
 * 実装タスクの受け入れ基準の確認 (仕様の 10.5)。受け入れテストの JSON のレポートを読み、次のすべてを満たすかを確かめる。
 *
 * - 割り当てた受け入れ基準ごとに、その識別子のタグが付いたテストが 1 つ以上あり、すべて通っている
 *   (スキップしたテストは、通ったものとして扱わない)
 * - すべての受け入れテストに、受け入れ基準の識別子のタグが、ちょうど 1 つ付いている
 *
 * 数えるのは、Playwright の acceptance のプロジェクト (acceptance/tests/) のテストだけで、仕組みが持つ起動の確認 (smoke) は数えない。
 * 割り当てた基準のほかに、ほかのタスクの基準のテストが含まれていても、通っていれば失敗にはしない。
 *
 * 使い方 (run-tests.sh から実行する):
 *   node check-acceptance.mjs --criteria "<割り当てた識別子を空白で区切ったもの>" [--report <レポートのパス>]
 *
 * --report を省略するか、ファイルが無いときは、受け入れテストを実行しなかった (テストが 1 つも無い) ものとして扱う。
 * 満たさなければ、満たさなかった内容を出力し、終了コード 1 で終わる。
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** 受け入れテストのプロジェクトの名前 (acceptance/playwright.config.ts) */
export const ACCEPTANCE_PROJECT = 'acceptance';

/** 受け入れ基準の識別子のタグ (レポートでは、先頭の @ が除かれる) */
const CRITERION_TAG = /^AC[1-9][0-9]*-[1-9][0-9]*$/;

/**
 * レポートの中の、受け入れテスト 1 件
 * @typedef {object} AcceptanceTest
 * @property {string} title テストの名前 (ファイルの位置を含む)
 * @property {string[]} criteria テストに付いた、受け入れ基準の識別子のタグ
 * @property {boolean} passed 通ったか
 */

/**
 * Playwright の JSON のレポートから、acceptance のプロジェクトのテストを取り出す。
 *
 * @param {unknown} report
 * @returns {AcceptanceTest[]}
 */
export function collectAcceptanceTests(report) {
  /** @type {AcceptanceTest[]} */
  const tests = [];
  /**
   * @param {any} suite
   * @param {string[]} path
   */
  const visit = (suite, path) => {
    const here = suite?.title ? [...path, suite.title] : path;
    for (const spec of suite?.specs ?? []) {
      const tags = Array.isArray(spec.tags) ? spec.tags.map((tag) => String(tag).replace(/^@/, '')) : [];
      for (const test of spec.tests ?? []) {
        if (test.projectName !== ACCEPTANCE_PROJECT) {
          continue;
        }
        tests.push({
          title: [...here, spec.title].join(' › '),
          criteria: tags.filter((tag) => CRITERION_TAG.test(tag)),
          passed: test.status === 'expected',
        });
      }
    }
    for (const child of suite?.suites ?? []) {
      visit(child, here);
    }
  };
  for (const suite of /** @type {{ suites?: unknown[] }} */ (report)?.suites ?? []) {
    visit(suite, []);
  }
  return tests;
}

/**
 * 受け入れ基準の確認を行い、満たさなかった内容の一覧を返す。空なら満たしている。
 *
 * @param {AcceptanceTest[]} tests
 * @param {readonly string[]} assigned 割り当てた受け入れ基準の識別子
 * @returns {string[]}
 */
export function checkAcceptance(tests, assigned) {
  /** @type {string[]} */
  const problems = [];
  for (const test of tests) {
    if (test.criteria.length !== 1) {
      problems.push(
        test.criteria.length === 0
          ? `受け入れテスト「${test.title}」に、受け入れ基準の識別子のタグ (例: @AC12-3) がありません`
          : `受け入れテスト「${test.title}」に、受け入れ基準の識別子のタグが ${test.criteria.length} つ付いています (${test.criteria.map((id) => `@${id}`).join(' ')})。ちょうど 1 つにしてください`,
      );
    }
  }
  for (const id of assigned) {
    const tagged = tests.filter((test) => test.criteria.includes(id));
    if (tagged.length === 0) {
      problems.push(`割り当てられた受け入れ基準 ${id} の受け入れテスト (タグ @${id}) がありません`);
      continue;
    }
    for (const test of tagged.filter((candidate) => !candidate.passed)) {
      problems.push(`受け入れ基準 ${id} の受け入れテスト「${test.title}」が通っていません (スキップしたテストも、通ったものとして扱いません)`);
    }
  }
  return problems;
}

/**
 * @param {string[]} args
 */
async function main(args) {
  const { values } = parseArgs({ args, options: { criteria: { type: 'string' }, report: { type: 'string' } }, strict: true });
  if (values.criteria === undefined) {
    throw new Error('--criteria を指定してください');
  }
  const assigned = values.criteria.split(/\s+/).filter((id) => id !== '');
  const invalid = assigned.filter((id) => !CRITERION_TAG.test(id));
  if (invalid.length > 0) {
    throw new Error(`受け入れ基準の識別子の形式が正しくありません: ${invalid.join(' ')}`);
  }

  /** @type {unknown} */
  let report = { suites: [] };
  if (values.report !== undefined) {
    try {
      report = JSON.parse(await readFile(values.report, 'utf8'));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw new Error(`受け入れテストのレポートを読めません: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  const problems = checkAcceptance(collectAcceptanceTests(report), assigned);
  if (problems.length > 0) {
    console.log('受け入れ基準の確認で、次の点を満たしていません。');
    for (const problem of problems) {
      console.log(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(assigned.length === 0 ? '割り当てられた受け入れ基準はありません' : `受け入れ基準 ${assigned.join(' ')} の受け入れテストが通りました`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
