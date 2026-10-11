/**
 * PR で変更されたファイルが、段階ごとに変更してよい範囲 (stages.json) に収まっているか判定する。
 */

import { minimatch } from 'minimatch';

/**
 * PR で変更されたファイル (REST API の pulls.listFiles の要素のうち、使う項目)
 * @typedef {object} ChangedFile
 * @property {string} filename 変更後のパス
 * @property {string} [previous_filename] 名前を変えた場合の、変更前のパス
 */

/**
 * パスが glob の一覧のどれかに当てはまるか判定する。. で始まるファイルやディレクトリにも当てはめる。
 *
 * @param {string} path
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
export function matchesAny(path, patterns) {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}

/**
 * 変更してよい範囲に収まっていないパスを返す。
 * 名前を変えたファイルは、変更前と変更後の両方のパスを確かめる (範囲外のファイルを移動させないため)。
 *
 * @param {readonly ChangedFile[]} files
 * @param {{ allow: readonly string[], deny: readonly string[] }} range 変更してよいファイルと、変更してはいけないファイルの glob
 * @returns {string[]} 範囲外のパス (重複なし、並びは変更されたファイルの順)
 */
export function findViolations(files, range) {
  const paths = files.flatMap((file) => (file.previous_filename === undefined ? [file.filename] : [file.previous_filename, file.filename]));
  const violations = paths.filter((path) => !matchesAny(path, range.allow) || matchesAny(path, range.deny));
  return [...new Set(violations)];
}
