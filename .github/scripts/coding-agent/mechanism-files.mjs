/**
 * 仕組みのファイル (Coding Agent の仕組みそのものを構成するファイル) の範囲。
 *
 * - 確認用のリポジトリへの取り込み (sync-sandbox.mjs) は、この範囲のファイルだけを取り込む
 * - PR を通らない変更の検知 (handlers/detect-untracked-changes.mjs) は、この範囲の外のファイルが
 *   PR を通らずに変わったら、仕組みを止める
 */

import { matchesAny } from './changed-files.mjs';
import { CONFIG_DIR } from './config.mjs';

/**
 * 仕組みのファイルの glob。テンプレートにファイルを足したら、ここか sync-sandbox.mjs の NOT_SYNCED_PATTERNS の
 * どちらかに分類する (分類されていないファイルがあると、取り込みは失敗する)
 */
export const MECHANISM_FILE_PATTERNS = [
  `${CONFIG_DIR}/**`,
  '.github/scripts/coding-agent/**',
  '.github/workflows/coding-agent-*.yml',
  '.github/workflows/validate-conventional-commits.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.husky/**',
  'commitlint.config.mjs',
  'package.json',
  'package-lock.json',
  'scripts/postinstall.js',
  // 受け入れテストの実行の設定 (仕様の 10.3)。テストのファイル (acceptance/tests/) は含めない
  'acceptance/package.json',
  'acceptance/package-lock.json',
  'acceptance/playwright.config.ts',
  'acceptance/.gitignore',
  'acceptance/smoke/**',
];

/**
 * 仕組みのファイルか判定する。
 *
 * @param {string} path リポジトリのルートからのパス
 * @returns {boolean}
 */
export function isMechanismFile(path) {
  return matchesAny(path, MECHANISM_FILE_PATTERNS);
}
