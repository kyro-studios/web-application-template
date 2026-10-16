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

/**
 * 段階に渡す知識 (knowledge.mjs) を、指示の節として組み立てる。知識が無ければ、何も返さない。
 * 知識のファイルの見出しは、この節の中に収まるよう、3 段下げる。
 *
 * @param {{ name: string, body: string }[]} knowledge
 * @returns {string[]}
 */
export function knowledgeLines(knowledge) {
  if (knowledge.length === 0) {
    return [];
  }
  const lines = ['## この段階の知識', ''];
  for (const { name, body } of knowledge) {
    const demoted = body.trim().replace(/^(#{1,6}) /gm, (_, marks) => `${'#'.repeat(Math.min(6, marks.length + 3))} `);
    lines.push(`### ${name}`, '', demoted, '');
  }
  return lines;
}
