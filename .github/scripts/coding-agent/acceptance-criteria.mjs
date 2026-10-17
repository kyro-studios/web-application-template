/**
 * 受け入れ基準のファイル (docs/features/<機能>/acceptance-criteria.json) を、仕様書の段階のエージェントの出力から作る (仕様の 10.2)。
 *
 * - 今の受け入れ基準は、作業を始めたコミットから読む。作業ディレクトリのファイルは、エージェントが書き換えていても読まない
 * - エージェントは、残す基準には渡された識別子を、新しい基準には null を付けて返す。新しい基準には、続きの番号を振る
 * - 出力に無い基準は、消えたものとして扱い、その番号は使い回さない (next_number をファイルに持つ)
 *
 * 使い方 (作成担当のワークフローから実行する):
 *   node acceptance-criteria.mjs --request <依頼の JSON> --output <エージェントの出力の JSON> --base-sha <作業を始めたコミット>
 *
 * 作業ディレクトリ (リポジトリのルート) で実行し、受け入れ基準のファイルを書き出す。
 * 出力を検証できなければ、ファイルを書かずに、理由を出力して失敗する。
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateWithSchema } from './config.mjs';
import { ACCEPTANCE_CRITERIA_FILE, acceptanceCriteriaPath } from './stages.mjs';

/**
 * 受け入れ基準のファイルの形式。ワークフローでは、既定ブランチの仕組み (作業ディレクトリの外) から読む
 */
const FILE_SCHEMA_URL = new URL('../../coding-agent/acceptance-criteria-schema.json', import.meta.url);

/**
 * @typedef {'api' | 'screen'} CriterionKind
 */

/**
 * 受け入れ基準 1 件
 * @typedef {object} Criterion
 * @property {string} id
 * @property {CriterionKind} kind
 * @property {string} behavior
 * @property {string} expected
 * @property {string} spec_reference
 */

/**
 * 受け入れ基準のファイル
 * @typedef {object} CriteriaFile
 * @property {number} feature 機能の親 Issue の番号
 * @property {number} next_number 次に振る連番
 * @property {Criterion[]} criteria
 */

/**
 * エージェントが出力する受け入れ基準 1 件 (specification-result-schema.json)
 * @typedef {Omit<Criterion, 'id'> & { id: string | null }} OutputCriterion
 */

/**
 * 受け入れ基準を検証できなかったときのエラー。問題点の一覧を持つ
 */
export class AcceptanceCriteriaError extends Error {
  /**
   * @param {string[]} problems
   */
  constructor(problems) {
    super(`受け入れ基準に問題があります:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
    this.name = 'AcceptanceCriteriaError';
    this.problems = problems;
  }
}

/**
 * 機能の親 Issue の番号と連番から、識別子を作る。
 *
 * @param {number} feature
 * @param {number} number
 * @returns {string}
 */
export function criterionId(feature, number) {
  return `AC${feature}-${number}`;
}

/**
 * 識別子から、機能の親 Issue の番号と連番を取り出す。形式が正しくなければ undefined を返す。
 *
 * @param {string} id
 * @returns {{ feature: number, number: number } | undefined}
 */
export function parseCriterionId(id) {
  const match = /^AC([1-9][0-9]*)-([1-9][0-9]*)$/.exec(id);
  return match === null ? undefined : { feature: Number(match[1]), number: Number(match[2]) };
}

/**
 * 受け入れ基準のファイルの中身を検証する。形式に加えて、Schema で表せない決まり
 * (識別子が重ならない、機能の親 Issue の番号が合う、連番が next_number より小さい) も確かめる。
 *
 * @param {unknown} data
 * @param {object} schema acceptance-criteria-schema.json
 * @param {{ feature?: number }} [expected] 機能の親 Issue の番号が分かっていれば、一致するかも確かめる
 * @returns {string[]} 問題点の一覧
 */
export function validateCriteriaFile(data, schema, { feature } = {}) {
  const errors = validateWithSchema(ACCEPTANCE_CRITERIA_FILE, schema, data);
  if (errors.length > 0) {
    return errors;
  }
  const file = /** @type {CriteriaFile} */ (data);
  if (feature !== undefined && file.feature !== feature) {
    errors.push(`${ACCEPTANCE_CRITERIA_FILE}: feature が機能の親 Issue の番号 (${feature}) と一致しません: ${file.feature}`);
  }
  const seen = new Set();
  for (const criterion of file.criteria) {
    const parsed = parseCriterionId(criterion.id);
    if (seen.has(criterion.id)) {
      errors.push(`${ACCEPTANCE_CRITERIA_FILE}: 識別子 ${criterion.id} が重なっています`);
    }
    seen.add(criterion.id);
    if (parsed === undefined || parsed.feature !== file.feature) {
      errors.push(`${ACCEPTANCE_CRITERIA_FILE}: 識別子 ${criterion.id} が、機能の親 Issue の番号 (${file.feature}) の形式になっていません`);
    } else if (parsed.number >= file.next_number) {
      errors.push(`${ACCEPTANCE_CRITERIA_FILE}: 識別子 ${criterion.id} の連番が、next_number (${file.next_number}) より小さくありません`);
    }
  }
  return errors;
}

/**
 * エージェントの出力から、新しい受け入れ基準のファイルを作る。
 *
 * @param {object} args
 * @param {number} args.feature 機能の親 Issue の番号
 * @param {CriteriaFile | null} args.current 今の受け入れ基準 (無ければ null)
 * @param {unknown} args.output エージェントの出力の acceptance_criteria
 * @returns {CriteriaFile}
 * @throws {AcceptanceCriteriaError} 出力を検証できないとき
 */
export function buildCriteriaFile({ feature, current, output }) {
  if (!Array.isArray(output) || output.length === 0) {
    throw new AcceptanceCriteriaError(['受け入れ基準が 1 件もありません']);
  }

  /** @type {string[]} */
  const problems = [];
  const currentIds = new Set((current?.criteria ?? []).map((criterion) => criterion.id));
  const seen = new Set();
  output.forEach((/** @type {OutputCriterion} */ criterion, index) => {
    const label = `${index + 1} 件目`;
    for (const field of /** @type {const} */ (['behavior', 'expected', 'spec_reference'])) {
      if (typeof criterion?.[field] !== 'string' || criterion[field].trim() === '') {
        problems.push(`${label}: ${field} が空です`);
      }
    }
    if (criterion?.kind !== 'api' && criterion?.kind !== 'screen') {
      problems.push(`${label}: kind は api か screen にしてください: ${String(criterion?.kind)}`);
    }
    const id = criterion?.id;
    if (id === null || id === undefined) {
      return;
    }
    if (!currentIds.has(id)) {
      problems.push(`${label}: 識別子 ${String(id)} は、今の受け入れ基準にありません (新しい基準は null にしてください)`);
    } else if (seen.has(id)) {
      problems.push(`${label}: 識別子 ${id} が 2 回以上出てきます`);
    }
    seen.add(id);
  });
  if (problems.length > 0) {
    throw new AcceptanceCriteriaError(problems);
  }

  let nextNumber = current?.next_number ?? 1;
  const criteria = output.map((/** @type {OutputCriterion} */ criterion) => {
    const id = criterion.id ?? criterionId(feature, nextNumber++);
    return {
      id,
      kind: criterion.kind,
      behavior: criterion.behavior.trim(),
      expected: criterion.expected.trim(),
      spec_reference: criterion.spec_reference.trim(),
    };
  });
  return { feature, next_number: nextNumber, criteria };
}

/**
 * 受け入れ基準のファイルを、決まった整形 (インデントは 2 文字、最後に改行) の文字列にする。
 *
 * @param {CriteriaFile} file
 * @returns {string}
 */
export function formatCriteriaFile(file) {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * コミットから、受け入れ基準のファイルを読む。ファイルが無ければ null を返す。
 *
 * @param {object} args
 * @param {string} args.sha
 * @param {string} args.path リポジトリのルートからのパス
 * @param {string} [args.cwd]
 * @returns {unknown}
 */
export function readCriteriaAt({ sha, path, cwd }) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:${path}`], { cwd, stdio: 'ignore' });
  } catch {
    return null;
  }
  const content = execFileSync('git', ['show', `${sha}:${path}`], { cwd, encoding: 'utf8' });
  try {
    return JSON.parse(content);
  } catch {
    throw new AcceptanceCriteriaError([`${sha} の ${path} を JSON として読めません`]);
  }
}

/**
 * 受け入れ基準のファイルの形式を読み込む。
 *
 * @returns {Promise<object>}
 */
export async function readCriteriaSchema() {
  return JSON.parse(await readFile(FILE_SCHEMA_URL, 'utf8'));
}

/**
 * @param {string[]} args
 */
async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      request: { type: 'string' },
      output: { type: 'string' },
      'base-sha': { type: 'string' },
    },
    strict: true,
  });
  for (const name of /** @type {const} */ (['request', 'output', 'base-sha'])) {
    if (values[name] === undefined) {
      throw new Error(`--${name} を指定してください`);
    }
  }
  const baseSha = /** @type {string} */ (values['base-sha']);
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error(`作業を始めたコミットの SHA が正しくありません: ${baseSha}`);
  }

  const request = JSON.parse(await readFile(/** @type {string} */ (values.request), 'utf8'));
  if (request.stage !== 'specification') {
    throw new Error(`仕様書の段階の依頼ではありません: ${request.stage}`);
  }
  const feature = Number(request.materials?.feature?.number);
  const featureDir = String(request.materials?.featureDir ?? '');
  if (!Number.isSafeInteger(feature) || feature <= 0 || featureDir === '') {
    throw new Error('依頼に、機能の親 Issue の番号か、機能ごとのディレクトリがありません');
  }

  const outputText = await readFile(/** @type {string} */ (values.output), 'utf8');
  /** @type {{ acceptance_criteria?: unknown }} */
  let output;
  try {
    output = JSON.parse(outputText);
  } catch {
    throw new AcceptanceCriteriaError(['エージェントの出力を JSON として読めません']);
  }

  const path = acceptanceCriteriaPath(featureDir);
  const schema = await readCriteriaSchema();
  const current = readCriteriaAt({ sha: baseSha, path });
  if (current !== null) {
    const errors = validateCriteriaFile(current, schema, { feature });
    if (errors.length > 0) {
      throw new AcceptanceCriteriaError([`今の受け入れ基準 (${path}) が形式を満たしていません`, ...errors]);
    }
  }

  const file = buildCriteriaFile({ feature, current: /** @type {CriteriaFile | null} */ (current), output: output?.acceptance_criteria });
  // 作ったファイルも、念のため同じ決まりで確かめる
  const errors = validateCriteriaFile(file, schema, { feature });
  if (errors.length > 0) {
    throw new AcceptanceCriteriaError(errors);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatCriteriaFile(file));
  const added = file.criteria.filter((criterion) => !(/** @type {CriteriaFile | null} */ (current)?.criteria ?? []).some((before) => before.id === criterion.id));
  console.log(`${path} を書き出しました (${file.criteria.length} 件。新しい基準: ${added.map((criterion) => criterion.id).join(' ') || 'なし'})`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
