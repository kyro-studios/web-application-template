/**
 * プロジェクトの背景 (docs/project.md) をエージェントに渡す (仕様の 6.6)。
 *
 * 背景は人が書き、どのエージェントも変更できない。指示を組み立てるときに、作業ディレクトリ
 * (作成と修正では作業を始めるコミット、レビューでは PR の head をチェックアウトしたもの) から読む。
 * 同じ段階の作成、修正、レビューには、同じ背景を渡す。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** プロジェクトの背景のパス (リポジトリのルートから) */
export const PROJECT_BACKGROUND_PATH = 'docs/project.md';

/**
 * 背景を渡さない段階。概念モデルは、仕様書で決まった範囲の概念を、実装や運用の事情に左右されずに表す
 * (理想概念のモデリング) ため、背景を渡さない
 */
export const STAGES_WITHOUT_BACKGROUND = /** @type {const} */ (['domain-model']);

/**
 * 段階に、プロジェクトの背景を渡すか。
 *
 * @param {string} stage
 * @returns {boolean}
 */
export function receivesProjectBackground(stage) {
  return !(/** @type {readonly string[]} */ (STAGES_WITHOUT_BACKGROUND).includes(stage));
}

/**
 * 作業ディレクトリから、プロジェクトの背景を読む。ファイルが無ければ null を返す。
 *
 * @param {string} [workspace] 作業ディレクトリ (既定は今のディレクトリ)
 * @returns {Promise<string | null>}
 */
export async function readProjectBackground(workspace = '.') {
  try {
    return await readFile(join(workspace, PROJECT_BACKGROUND_PATH), 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * 背景から、書き方の説明 (HTML のコメント) を除く。見出しのほかに何も書かれていなければ、null を返す。
 *
 * @param {string | null} background
 * @returns {string | null}
 */
export function stripBackgroundGuide(background) {
  if (background === null) {
    return null;
  }
  const stripped = background
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const written = stripped.split('\n').some((line) => line.trim() !== '' && !/^#{1,6} /.test(line.trim()));
  return written ? stripped : null;
}

/**
 * 段階に渡すプロジェクトの背景を読む。背景を渡さない段階では undefined を返す。
 *
 * @param {string} stage
 * @param {string} [workspace]
 * @returns {Promise<string | null | undefined>} 書き方の説明を除いた背景 (書かれていなければ null)
 */
export async function projectBackgroundFor(stage, workspace) {
  return receivesProjectBackground(stage) ? stripBackgroundGuide(await readProjectBackground(workspace)) : undefined;
}

/**
 * プロジェクトの背景を、指示の節として組み立てる。背景を渡さない段階 (undefined) では、何も返さない。
 * 背景の見出しは、この節の中に収まるよう、2 段下げる。
 *
 * @param {string | null | undefined} background
 * @returns {string[]}
 */
export function projectBackgroundLines(background) {
  if (background === undefined) {
    return [];
  }
  const lines = ['## プロジェクトの背景', ''];
  if (background === null || background.trim() === '') {
    lines.push(
      `このリポジトリには、プロジェクトの背景 (\`${PROJECT_BACKGROUND_PATH}\`) がまだ書かれていません。機能の親 Issue と要件定義書に書かれた事情だけを頼りに判断し、判断に迷う点は PR の説明に書いてください。`,
      '',
    );
    return lines;
  }
  lines.push(
    `人が \`${PROJECT_BACKGROUND_PATH}\` に書いた、プロジェクトの目的、規模、方針です。どこまで作り込むかは、この方針と、機能の親 Issue と要件定義書に書かれた機能の事情に合わせてください。`,
    '',
  );
  const demoted = background.trim().replace(/^(#{1,6}) /gm, (_, marks) => `${'#'.repeat(Math.min(6, marks.length + 2))} `);
  lines.push(demoted, '');
  return lines;
}
