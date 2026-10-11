/**
 * エージェントに渡す指示 (プロンプト) を組み立てるときの、共通の書式。
 */

import { getFeatureStage, IMPLEMENTATION_STAGE } from './stages.mjs';

/**
 * 段階の名前を返す。
 *
 * @param {string} stage
 * @returns {string}
 */
export function stageName(stage) {
  return stage === IMPLEMENTATION_STAGE ? '実装タスク' : getFeatureStage(stage).name;
}

/**
 * 信頼できない文章を、Markdown のコードブロックに入れる。文章の中のどの区切りよりも長い区切りを使う。
 *
 * @param {string} text
 * @returns {string}
 */
export function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`{3,}|~{3,}/g)].map((match) => match[0].length));
  const marker = '~'.repeat(longest + 1);
  return `${marker}text\n${text}\n${marker}`;
}
