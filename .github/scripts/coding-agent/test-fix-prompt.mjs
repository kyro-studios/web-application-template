/**
 * テストの機械的な実行で失敗したときに、作成担当に直させる指示 (プロンプト) を組み立てる (仕様の 6.4)。
 *
 * 作成担当のワークフローは、エージェントの作業ごとに新しい会話を始めるため、最初の指示の全体に、
 * テストの失敗の指示 (prompts/fix/test-failure.md)、失敗したログの末尾、前回の出力を続ける。
 *
 * 使い方 (作成担当のワークフローから実行する):
 *   node test-fix-prompt.mjs --prompt <最初の指示> --prompts <指示のディレクトリ> --log <失敗したログ>
 *     --previous <前回の出力の JSON> --attempt <何回目か> --max-attempts <上限> --prompt-out <指示の出力先>
 *   node test-fix-prompt.mjs --print-max-attempts
 *     直させる回数の上限を、環境変数 TEST_MAX_FIX_ATTEMPTS (Variables の値) から決めて出力する
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fence } from './prompt-format.mjs';

/**
 * 直させる回数の上限の最大値。GitHub Actions ではステップを決まった回数より多く繰り返せないため、
 * 作成担当のワークフローに、テストの実行と直させるステップを、この回数まで並べて書く
 */
export const MAX_TEST_FIX_ATTEMPTS = 3;

/** 直させる回数の上限の既定値 */
export const DEFAULT_TEST_FIX_ATTEMPTS = 2;

/** 指示に載せる、失敗したログの末尾の行数 */
export const LOG_TAIL_LINES = 200;

/**
 * Variables の TEST_MAX_FIX_ATTEMPTS から、直させる回数の上限を求める。正しくなければ既定値にし、最大値より大きければ最大値にする。
 *
 * @param {string | undefined} value
 * @returns {number}
 */
export function maxTestFixAttempts(value) {
  const trimmed = value?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_TEST_FIX_ATTEMPTS;
  }
  return Math.min(Number.parseInt(trimmed, 10), MAX_TEST_FIX_ATTEMPTS);
}

/**
 * ログの末尾を取り出す。色の制御文字は取り除く。
 *
 * @param {string} log
 * @param {number} [lines]
 * @returns {string}
 */
export function logTail(log, lines = LOG_TAIL_LINES) {
  const plain = log.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
  const all = plain.replace(/\n+$/, '').split('\n');
  const tail = all.slice(-lines);
  return all.length > lines ? [`(先頭の ${all.length - lines} 行を省略しました)`, ...tail].join('\n') : tail.join('\n');
}

/**
 * テストの失敗を直させる指示を組み立てる。
 *
 * @param {object} args
 * @param {string} args.prompt 最初の指示の全体
 * @param {string} args.instruction テストの失敗の指示 (prompts/fix/test-failure.md)
 * @param {string} args.log 失敗したログ
 * @param {string} args.previous 前回の出力 (JSON)
 * @param {number} args.attempt 何回目か
 * @param {number} args.maxAttempts 上限
 * @returns {string}
 */
export function buildTestFixPrompt({ prompt, instruction, log, previous, attempt, maxAttempts }) {
  const lines = [
    prompt.trim(),
    '',
    instruction.trim(),
    '',
    `- 直させる回数: ${attempt} 回目 (上限 ${maxAttempts} 回)`,
    '',
    '### 失敗したログの末尾',
    '',
    fence(logTail(log)),
    '',
    '### 前回の出力',
    '',
    fence(previous.trim() === '' ? '(ありません)' : previous.trim()),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string[]} args
 */
async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      prompt: { type: 'string' },
      prompts: { type: 'string' },
      log: { type: 'string' },
      previous: { type: 'string' },
      attempt: { type: 'string' },
      'max-attempts': { type: 'string' },
      'prompt-out': { type: 'string' },
      'print-max-attempts': { type: 'boolean' },
    },
    strict: true,
  });
  if (values['print-max-attempts']) {
    console.log(maxTestFixAttempts(process.env.TEST_MAX_FIX_ATTEMPTS));
    return;
  }
  for (const name of /** @type {const} */ (['prompt', 'prompts', 'log', 'previous', 'attempt', 'max-attempts', 'prompt-out'])) {
    if (values[name] === undefined) {
      throw new Error(`--${name} を指定してください`);
    }
  }
  const attempt = Number.parseInt(/** @type {string} */ (values.attempt), 10);
  const maxAttempts = Number.parseInt(/** @type {string} */ (values['max-attempts']), 10);
  const [prompt, instruction, log, previous] = await Promise.all([
    readFile(/** @type {string} */ (values.prompt), 'utf8'),
    readFile(join(/** @type {string} */ (values.prompts), 'fix/test-failure.md'), 'utf8'),
    readFile(/** @type {string} */ (values.log), 'utf8'),
    readFile(/** @type {string} */ (values.previous), 'utf8').catch(() => ''),
  ]);
  await writeFile(/** @type {string} */ (values['prompt-out']), buildTestFixPrompt({ prompt, instruction, log, previous, attempt, maxAttempts }));
  console.log(`テストの失敗を直させる指示を作成しました (${attempt} 回目 / 上限 ${maxAttempts} 回)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
