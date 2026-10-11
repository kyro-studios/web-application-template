/**
 * 作成や修正の依頼から、作成担当に渡す指示 (プロンプト) を組み立てる。
 *
 * 指示の本文は、既定ブランチの .github/coding-agent/prompts/ から読む。
 * - 作成: create/common.md と、段階ごとの create/<段階>.md
 * - 修正: fix/common.md と、段階ごとの create/<段階>.md (成果物に求められることを確かめるため)
 *
 * 使い方 (作成担当のワークフローから実行する):
 *   node author-prompt.mjs --request <依頼の JSON> --prompts <指示のディレクトリ> --prompt-out <指示の出力先>
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fence, stageName } from './prompt-format.mjs';

/**
 * 作成の依頼の資料 (handlers/launch-stage.mjs が作る)
 * @typedef {object} CreateMaterials
 * @property {{ number: number, title: string, body: string }} issue
 * @property {{ number: number, title: string, body: string }} feature
 * @property {string} featureDir
 * @property {string | null} artifact
 * @property {{ name: string, path: string }[]} documents
 * @property {{ allow: string[], deny: string[] }} allowedFiles
 */

/**
 * 修正の依頼の資料 (handlers/request-fix.mjs が作る)
 * @typedef {CreateMaterials & {
 *   pullRequest: { number: number, title: string, body: string, headRef: string },
 *   review: { id: number, body: string, comments: { path: string, line: number | null, body: string }[] },
 *   fixRound: number,
 *   maxFixRounds: number,
 * }} FixMaterials
 */

/**
 * 依頼の内容のうち、作成と修正で共通の部分を組み立てる。
 *
 * @param {import('./agent-request.mjs').AgentRequest & { materials: CreateMaterials }} request
 * @returns {string[]}
 */
function requestLines(request) {
  const { issue, feature, artifact, documents, allowedFiles } = request.materials;
  const lines = [`- 段階: ${stageName(request.stage)}`, `- Issue: #${issue.number} ${issue.title}`, `- 機能の親 Issue: #${feature.number} ${feature.title}`];
  if (artifact !== null) {
    lines.push(`- ${request.mode === 'fix' ? '修正する' : '作成する'}成果物: \`${artifact}\``);
  }
  if (documents.length > 0) {
    lines.push('- 参考資料 (前の段階の成果物):');
    for (const document of documents) {
      lines.push(`  - ${document.name}: \`${document.path}\``);
    }
  }
  lines.push(`- 変更してよいファイル: ${allowedFiles.allow.map((pattern) => `\`${pattern}\``).join('、')}`);
  if (allowedFiles.deny.length > 0) {
    lines.push(`- 変更してはいけないファイル: ${allowedFiles.deny.map((pattern) => `\`${pattern}\``).join('、')}`);
  }
  return lines;
}

/**
 * Issue と機能の親 Issue の本文を組み立てる。
 *
 * @param {CreateMaterials} materials
 * @returns {string[]}
 */
function issueBodyLines({ issue, feature }) {
  return ['', '### Issue の本文', '', fence(issue.body), '', '### 機能の親 Issue の本文', '', fence(feature.body)];
}

/**
 * 作成担当に渡す、作成の指示を組み立てる。
 *
 * @param {object} args
 * @param {import('./agent-request.mjs').AgentRequest & { materials: CreateMaterials }} args.request
 * @param {string} args.common すべての段階に共通する指示 (create/common.md)
 * @param {string} args.stagePrompt 段階ごとの指示 (create/<段階>.md)
 * @returns {string}
 */
export function buildCreatePrompt({ request, common, stagePrompt }) {
  const lines = [common.trim(), '', stagePrompt.trim(), '', '## 依頼の内容', '', ...requestLines(request), ...issueBodyLines(request.materials)];
  return `${lines.join('\n')}\n`;
}

/**
 * 作成担当に渡す、修正の指示を組み立てる。
 *
 * @param {object} args
 * @param {import('./agent-request.mjs').AgentRequest & { materials: FixMaterials }} args.request
 * @param {string} args.common 修正に共通する指示 (fix/common.md)
 * @param {string} args.stagePrompt 段階ごとの作成の指示 (create/<段階>.md)
 * @returns {string}
 */
export function buildFixPrompt({ request, common, stagePrompt }) {
  const { pullRequest, review, fixRound, maxFixRounds } = request.materials;
  const lines = [
    common.trim(),
    '',
    '## 参考: この段階の成果物に求められること',
    '',
    stagePrompt.trim(),
    '',
    '## 依頼の内容',
    '',
    `- PR: #${pullRequest.number} ${pullRequest.title}`,
    `- 修正の回数: ${fixRound} 回目 (上限 ${maxFixRounds} 回)`,
    ...requestLines(request),
    '',
    '### レビューの所見',
    '',
    fence(review.body),
  ];
  if (review.comments.length > 0) {
    lines.push('', '### 行への指摘');
    for (const comment of review.comments) {
      lines.push('', `- \`${comment.path}\`${comment.line === null ? '' : ` の ${comment.line} 行目`}:`, '', fence(comment.body));
    }
  }
  lines.push(...issueBodyLines(request.materials));
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string[]} args
 */
async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      request: { type: 'string' },
      prompts: { type: 'string' },
      'prompt-out': { type: 'string' },
    },
    strict: true,
  });
  for (const name of /** @type {const} */ (['request', 'prompts', 'prompt-out'])) {
    if (values[name] === undefined) {
      throw new Error(`--${name} を指定してください`);
    }
  }

  const request = JSON.parse(await readFile(/** @type {string} */ (values.request), 'utf8'));
  if (request.mode !== 'create' && request.mode !== 'fix') {
    throw new Error(`作成や修正の依頼ではありません: ${request.mode}`);
  }
  const promptsDir = /** @type {string} */ (values.prompts);
  const [common, stagePrompt] = await Promise.all([
    readFile(join(promptsDir, request.mode, 'common.md'), 'utf8'),
    readFile(join(promptsDir, 'create', `${request.stage}.md`), 'utf8'),
  ]);
  const build = request.mode === 'fix' ? buildFixPrompt : buildCreatePrompt;
  await writeFile(/** @type {string} */ (values['prompt-out']), build({ request, common, stagePrompt }));
  console.log(request.mode === 'fix' ? '修正の指示を作成しました' : '作成の指示を作成しました');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
