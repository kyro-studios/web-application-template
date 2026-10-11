/**
 * 作成の依頼から、作成担当に渡す指示 (プロンプト) を組み立てる。
 *
 * 指示の本文は、既定ブランチの .github/coding-agent/prompts/create/ から読む。
 *
 * 使い方 (作成担当のワークフローから実行する):
 *   node create-prompt.mjs --request <依頼の JSON> --prompts <指示のディレクトリ> --prompt-out <指示の出力先>
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
 * 作成担当に渡す指示を組み立てる。
 *
 * @param {object} args
 * @param {import('./agent-request.mjs').AgentRequest & { materials: CreateMaterials }} args.request
 * @param {string} args.common すべての段階に共通する指示
 * @param {string} args.stagePrompt 段階ごとの指示
 * @returns {string}
 */
export function buildCreatePrompt({ request, common, stagePrompt }) {
  const { issue, feature, artifact, documents, allowedFiles } = request.materials;
  const lines = [
    common.trim(),
    '',
    stagePrompt.trim(),
    '',
    '## 依頼の内容',
    '',
    `- 段階: ${stageName(request.stage)}`,
    `- Issue: #${issue.number} ${issue.title}`,
    `- 機能の親 Issue: #${feature.number} ${feature.title}`,
  ];
  if (artifact !== null) {
    lines.push(`- 作成する成果物: \`${artifact}\``);
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

  lines.push('', '### Issue の本文', '', fence(issue.body), '', '### 機能の親 Issue の本文', '', fence(feature.body));
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
  if (request.mode !== 'create') {
    throw new Error(`作成の依頼ではありません: ${request.mode}`);
  }
  const promptsDir = /** @type {string} */ (values.prompts);
  const [common, stagePrompt] = await Promise.all([
    readFile(join(promptsDir, 'common.md'), 'utf8'),
    readFile(join(promptsDir, `${request.stage}.md`), 'utf8'),
  ]);
  await writeFile(/** @type {string} */ (values['prompt-out']), buildCreatePrompt({ request, common, stagePrompt }));
  console.log('作成の指示を作成しました');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
