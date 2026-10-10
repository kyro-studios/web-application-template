/**
 * Issue フォームで作られた Issue の本文を読み取る。
 *
 * Issue フォームの入力は、入力欄のラベルを見出し (### ラベル) にした Markdown として本文に記録される。
 * 本文は Issue の作成後に編集できるため、信頼できない入力として扱う。
 */

/** 「新規機能」の Issue フォームの、機能名の入力欄のラベル */
export const FEATURE_NAME_FIELD = '機能名';

/** 「新規機能」の Issue フォームの、概要の入力欄のラベル */
export const OVERVIEW_FIELD = '概要';

/** 任意の入力欄が空のときに、GitHub が本文に記録する文字列 */
const NO_RESPONSE = '_No response_';

/**
 * 本文から、入力欄ごとの値を取り出す。同じラベルの見出しが複数あれば、最初のものを使う。
 *
 * @param {string | null | undefined} body Issue の本文
 * @returns {Map<string, string>} 入力欄のラベルと値
 */
export function parseIssueForm(body) {
  /** @type {Map<string, string>} */
  const fields = new Map();
  /** @type {string | undefined} */
  let label;
  /** @type {string[]} */
  let lines = [];

  const flush = () => {
    if (label !== undefined && !fields.has(label)) {
      const value = lines.join('\n').trim();
      fields.set(label, value === NO_RESPONSE ? '' : value);
    }
  };

  for (const line of (body ?? '').replaceAll('\r\n', '\n').split('\n')) {
    const heading = /^### (.+)$/.exec(line);
    if (heading !== null) {
      flush();
      label = heading[1].trim();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return fields;
}
