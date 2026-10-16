/**
 * エージェントに渡す知識 (仕様の 6.5)。
 *
 * 知識は段階ごとの小さなファイルに分け、その段階の作業に要るものだけを渡す。
 * 同じ段階の作成、修正、レビューには、同じ知識を渡す (レビュー担当が、作成担当と同じ基準で判断できるようにするため)。
 * どの段階にどの知識を渡すかは、割り当てが頻繁には変わらないため、設定ファイルにせずここに書く。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {'tech-stacks' | 'architecture-documents' | 'project' | 'architecture-rules' | 'implementation'} KnowledgeId
 */

/**
 * 知識のファイルを置くディレクトリ。ワークフローでは、既定ブランチの仕組み (作業ディレクトリの外) から読む
 */
export const KNOWLEDGE_ROOT = fileURLToPath(new URL('../../coding-agent/', import.meta.url));

/**
 * 知識の名前と、KNOWLEDGE_ROOT からのパス
 * @type {Readonly<Record<KnowledgeId, { name: string, path: string }>>}
 */
export const KNOWLEDGE = {
  'tech-stacks': { name: '既定の技術スタック', path: 'tech-stacks.md' },
  'architecture-documents': { name: '全体の構成と API の契約の書き方', path: 'prompts/knowledge/architecture-documents.md' },
  project: { name: 'プロジェクトの約束', path: 'prompts/knowledge/project.md' },
  'architecture-rules': { name: 'アーキテクチャのルールの書き方', path: 'prompts/knowledge/architecture-rules.md' },
  implementation: { name: '実装の約束', path: 'prompts/knowledge/implementation.md' },
};

/**
 * 段階ごとに渡す知識。ここに無い段階には、知識を渡さない
 * @type {Readonly<Record<string, readonly KnowledgeId[]>>}
 */
export const STAGE_KNOWLEDGE = {
  architecture: ['tech-stacks', 'architecture-documents'],
  project: ['project', 'architecture-rules'],
  implementation: ['implementation'],
};

/**
 * 段階に渡す知識を返す。
 *
 * @param {string} stage 段階の識別子
 * @returns {{ id: KnowledgeId, name: string, path: string }[]}
 */
export function knowledgeFor(stage) {
  const ids = Object.hasOwn(STAGE_KNOWLEDGE, stage) ? STAGE_KNOWLEDGE[stage] : [];
  return ids.map((id) => ({ id, ...KNOWLEDGE[id] }));
}

/**
 * 段階に渡す知識を、ファイルから読み込む。
 *
 * @param {string} stage 段階の識別子
 * @param {string} [root] 知識のファイルを置くディレクトリ
 * @returns {Promise<{ name: string, body: string }[]>}
 */
export async function readKnowledge(stage, root = KNOWLEDGE_ROOT) {
  return Promise.all(knowledgeFor(stage).map(async ({ name, path }) => ({ name, body: await readFile(join(root, path), 'utf8') })));
}
