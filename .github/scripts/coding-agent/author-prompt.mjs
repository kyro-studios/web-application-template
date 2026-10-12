/**
 * 作成や修正の依頼から、作成担当に渡す指示 (プロンプト) を組み立てる。
 *
 * 指示の本文は、既定ブランチの .github/coding-agent/prompts/ から読む (promptFiles を参照)。
 *
 * 使い方 (作成担当のワークフローから実行する):
 *   node author-prompt.mjs --request <依頼の JSON> --prompts <指示のディレクトリ> --prompt-out <指示の出力先>
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fence, stageName } from './prompt-format.mjs';
import { IMPLEMENTATION_STAGE } from './stages.mjs';

/**
 * 作成の依頼の資料 (handlers/launch-stage.mjs が作る)
 * @typedef {object} CreateMaterials
 * @property {{ number: number, title: string, body: string }} issue
 * @property {{ number: number, title: string, body: string }} feature
 * @property {string} featureDir
 * @property {string | null} artifact
 * @property {{ name: string, path: string }[]} documents
 * @property {{ allow: string[], deny: string[] } | null} allowedFiles 変更してよいファイル (ファイルを変更しない実装計画では null)
 * @property {{ id: string, name: string }[]} [implementers] 実装タスクの担当に選べるエージェント (実装計画のみ)
 * @property {{ maxTasks: number, maxDepth: number }} [planLimits] タスクの数と親子関係の深さの上限 (実装計画のみ)
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
 * 依頼の種類と段階に応じて、読み込む指示のファイル (prompts/ からの相対パス) を返す。
 * - 作成: 共通の指示に、段階の種類ごとの指示を続ける。文書の段階は、文書に共通する指示と段階ごとの指示を続ける。
 *   実装タスクは、実装の指示と、作成のときの出力の指示を続ける
 * - 修正: 修正に共通する指示に、段階ごとの作成の指示を参考として続ける。出力の指示は修正に共通する指示にあるため、
 *   作成のときの出力の指示は含めない
 *
 * @param {'create' | 'fix'} mode
 * @param {string} stage
 * @returns {string[]}
 */
export function promptFiles(mode, stage) {
  if (mode === 'fix') {
    return ['fix/common.md', `create/${stage}.md`];
  }
  if (stage === 'planning') {
    return ['create/common.md', 'create/planning.md'];
  }
  if (stage === IMPLEMENTATION_STAGE) {
    return ['create/common.md', 'create/implementation.md', 'create/implementation-output.md'];
  }
  return ['create/common.md', 'create/documents.md', `create/${stage}.md`];
}

/**
 * glob の一覧を、読みやすい形にする。
 *
 * @param {string[]} patterns
 * @returns {string}
 */
function formatPatterns(patterns) {
  return patterns.map((pattern) => `\`${pattern}\``).join('、');
}

/**
 * 依頼の内容のうち、作成と修正で共通の部分を組み立てる。
 *
 * @param {import('./agent-request.mjs').AgentRequest & { materials: CreateMaterials }} request
 * @returns {string[]}
 */
function requestLines(request) {
  const { issue, feature, artifact, documents, allowedFiles, implementers, planLimits } = request.materials;
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
  if (allowedFiles !== null) {
    lines.push(`- 変更してよいファイル: ${formatPatterns(allowedFiles.allow)}`);
    if (allowedFiles.deny.length > 0) {
      lines.push(`- 変更してはいけないファイル: ${formatPatterns(allowedFiles.deny)}`);
    }
  }
  if (implementers !== undefined) {
    lines.push(`- 実装タスクの担当に選べるエージェント: ${implementers.map((agent) => `\`${agent.id}\` (${agent.name})`).join('、')}`);
  }
  if (planLimits !== undefined) {
    lines.push(`- タスクの数の上限: ${planLimits.maxTasks} 件`);
    lines.push(`- 親子関係の深さの上限: ${planLimits.maxDepth} 階層 (実装計画の Issue の直下を 1 階層目とする)`);
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
 * @param {string[]} args.prompts 指示のファイルの本文 (promptFiles の順)
 * @returns {string}
 */
export function buildCreatePrompt({ request, prompts }) {
  const lines = [...prompts.flatMap((prompt) => [prompt.trim(), '']), '## 依頼の内容', '', ...requestLines(request), ...issueBodyLines(request.materials)];
  return `${lines.join('\n')}\n`;
}

/**
 * 作成担当に渡す、修正の指示を組み立てる。
 *
 * @param {object} args
 * @param {import('./agent-request.mjs').AgentRequest & { materials: FixMaterials }} args.request
 * @param {string[]} args.prompts 指示のファイルの本文 (promptFiles の順。修正に共通する指示と、段階ごとの作成の指示)
 * @returns {string}
 */
export function buildFixPrompt({ request, prompts }) {
  const [common, stagePrompt] = prompts;
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
  const prompts = await Promise.all(promptFiles(request.mode, request.stage).map((file) => readFile(join(promptsDir, file), 'utf8')));
  const build = request.mode === 'fix' ? buildFixPrompt : buildCreatePrompt;
  await writeFile(/** @type {string} */ (values['prompt-out']), build({ request, prompts }));
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
