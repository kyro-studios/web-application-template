/**
 * 振り分け用のワークフローから、エージェントのワークフローへの依頼を扱う。
 *
 * workflow_dispatch の入力は文字列しか渡せず、数にも上限がある。そのため、エージェントに渡す資料を含む
 * 依頼の全体は Artifact に JSON で保存し、エージェントのワークフローには、それを取りに行くための情報と、
 * チェックアウトなどに必要な最小限の情報だけを入力として渡す。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @typedef {'create' | 'fix'} RequestMode
 */

/**
 * @typedef {'specification' | 'domain-model' | 'architecture' | 'planning' | 'implementation'} AgentStage
 */

/**
 * エージェントへの依頼
 * @typedef {object} AgentRequest
 * @property {string} id 依頼の識別子 (同じ実行の中で一意)
 * @property {string} agent 担当エージェントの識別子
 * @property {RequestMode} mode 作成 (create) か修正 (fix) か
 * @property {AgentStage} stage 段階
 * @property {number} issueNumber 対象の Issue の番号
 * @property {number | null} pullRequestNumber 修正の対象の PR の番号 (作成のときは null)
 * @property {string} targetSha 作業を始めるコミット
 * @property {Record<string, unknown>} materials エージェントに渡す資料
 */

/**
 * エージェントのワークフローの呼び出し方
 * @typedef {object} AgentDispatch
 * @property {string} requestId 依頼の識別子
 * @property {string} agent 担当エージェントの識別子
 * @property {string} workflow 呼び出すワークフローのファイル名
 * @property {Record<string, string>} inputs workflow_dispatch の入力
 */

/** 依頼を保存する Artifact の名前 */
export const REQUEST_ARTIFACT_NAME = 'coding-agent-requests';

/** 依頼の識別子の形式 (Artifact の中のファイル名に使う) */
export const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** @type {ReadonlySet<string>} */
const MODES = new Set(['create', 'fix']);

/** @type {ReadonlySet<string>} */
const STAGES = new Set(['specification', 'domain-model', 'architecture', 'planning', 'implementation']);

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * 依頼の形式を検証する。
 *
 * @param {AgentRequest} request
 * @returns {string[]} 問題点の一覧
 */
export function validateRequest(request) {
  /** @type {string[]} */
  const errors = [];
  if (!REQUEST_ID_PATTERN.test(request.id)) {
    errors.push(`依頼の識別子の形式が正しくありません: "${request.id}"`);
  }
  if (!MODES.has(request.mode)) {
    errors.push(`mode は create か fix にしてください: "${request.mode}"`);
  }
  if (!STAGES.has(request.stage)) {
    errors.push(`stage が正しくありません: "${request.stage}"`);
  }
  if (!isPositiveInteger(request.issueNumber)) {
    errors.push(`Issue の番号が正しくありません: ${request.issueNumber}`);
  }
  if (request.mode === 'fix' && !isPositiveInteger(request.pullRequestNumber)) {
    errors.push(`修正の依頼には PR の番号が必要です: ${request.pullRequestNumber}`);
  }
  if (request.mode === 'create' && request.pullRequestNumber !== null) {
    errors.push('作成の依頼に PR の番号は指定できません');
  }
  if (!SHA_PATTERN.test(request.targetSha)) {
    errors.push(`作業を始めるコミットの SHA が正しくありません: "${request.targetSha}"`);
  }
  return errors;
}

/**
 * 依頼から、エージェントのワークフローの呼び出し方を作る。
 *
 * @param {AgentRequest} request
 * @param {string} workflow 担当エージェントのワークフローのファイル名
 * @param {string} requestRunId 依頼の Artifact を保存した実行の ID
 * @returns {AgentDispatch}
 */
export function toDispatch(request, workflow, requestRunId) {
  return {
    requestId: request.id,
    agent: request.agent,
    workflow,
    inputs: {
      mode: request.mode,
      stage: request.stage,
      'issue-number': String(request.issueNumber),
      'pull-request-number': request.pullRequestNumber === null ? '' : String(request.pullRequestNumber),
      'target-sha': request.targetSha,
      'request-run-id': requestRunId,
      'request-id': request.id,
    },
  };
}

/**
 * 依頼を Artifact に含めるファイルとして保存する。
 *
 * @param {string} dir 保存先のディレクトリ
 * @param {AgentRequest} request
 * @returns {Promise<string>} 保存したファイルのパス
 */
export async function writeRequest(dir, request) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${request.id}.json`);
  await writeFile(path, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx' });
  return path;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
