/**
 * Coding Agent の設定ファイル (agents.json と stages.json) を読み込み、検証する。
 *
 * 形式は JSON Schema で検証し、Schema では表せないファイルの中の関係 (担当が登録済みか、
 * レビュー担当が作成担当と別かなど) はこのスクリプトで検証する。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

/**
 * @typedef {object} Agent
 * @property {string} name 表示名
 * @property {string} assignee Issue に Assign するアカウントのログイン名
 * @property {string} bot GitHub App の Bot 名 (<slug>[bot])
 * @property {string} workflow エージェントを動かすワークフローのファイル名
 * @property {string} appClientId GitHub App の Client ID
 * @property {string} appPrivateKeyRef GitHub App の秘密鍵の 1Password の参照
 * @property {string} apiKeyRef エージェントの API キーの 1Password の参照
 * @property {string | null} [model] エージェントが使うモデル (null ならエージェントの既定)
 */

/**
 * @typedef {'specification' | 'domain-model' | 'architecture' | 'planning'} AuthoredStage
 */

/**
 * @typedef {object} AgentsConfig
 * @property {Record<string, Agent>} agents 登録するエージェント (キーは識別子)
 * @property {{ author: Record<AuthoredStage, string>, implementers: string[], reviewer: string }} roles 段階ごとの担当
 */

/**
 * @typedef {'requirements' | 'specification' | 'domain-model' | 'architecture' | 'implementation'} ReviewedStage
 */

/**
 * @typedef {object} StageFiles
 * @property {string[]} allow 変更してよいファイルの glob
 * @property {string[]} [deny] allow に当てはまっても変更してはいけないファイルの glob
 */

/**
 * @typedef {object} StagesConfig
 * @property {string} featureRoot 機能ごとのディレクトリを置くディレクトリ
 * @property {Record<ReviewedStage, StageFiles>} stages 段階ごとに変更してよいファイル
 */

/**
 * @typedef {object} CodingAgentConfig
 * @property {AgentsConfig} agents
 * @property {StagesConfig} stages
 */

/**
 * @typedef {Agent & { id: string }} RegisteredAgent
 */

/** 設定ファイルを置くディレクトリ (リポジトリのルートからの相対パス) */
export const CONFIG_DIR = '.github/coding-agent';

/** 機能名 (ディレクトリ名に使う識別子) の形式 */
export const FEATURE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 機能名の長さの上限 */
export const MAX_FEATURE_NAME_LENGTH = 50;

/** 設定の検証に失敗したことを表すエラー。errors に問題点の一覧を持つ */
export class ConfigError extends Error {
  /**
   * @param {string[]} errors 問題点の一覧
   */
  constructor(errors) {
    super(`Coding Agent の設定に問題があります:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

/**
 * 設定ファイルを読み込んで検証する。
 *
 * @param {string} rootDir リポジトリのルート
 * @returns {Promise<CodingAgentConfig>}
 * @throws {ConfigError} 設定に問題がある場合
 */
export async function loadConfig(rootDir) {
  const configDir = join(rootDir, CONFIG_DIR);
  const [agents, agentsSchema, stages, stagesSchema] = await Promise.all([
    readJson(join(configDir, 'agents.json')),
    readJson(join(configDir, 'agents-schema.json')),
    readJson(join(configDir, 'stages.json')),
    readJson(join(configDir, 'stages-schema.json')),
  ]);

  const errors = [
    ...validateWithSchema('agents.json', agentsSchema, agents),
    ...validateWithSchema('stages.json', stagesSchema, stages),
  ];
  // 形式が正しくないと関係の検証で例外が起こりうるため、形式の検証が通ってから行う
  if (errors.length === 0) {
    errors.push(...validateAgentRelations(/** @type {AgentsConfig} */ (agents)));
  }
  if (errors.length > 0) {
    throw new ConfigError(errors);
  }

  return { agents: /** @type {AgentsConfig} */ (agents), stages: /** @type {StagesConfig} */ (stages) };
}

/**
 * JSON Schema で形式を検証する。
 *
 * @param {string} fileName エラーメッセージに表示するファイル名
 * @param {object} schema JSON Schema
 * @param {unknown} data 検証する値
 * @returns {string[]} 問題点の一覧
 */
export function validateWithSchema(fileName, schema, data) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const validate = ajv.compile(schema);
  if (validate(data)) {
    return [];
  }
  return (validate.errors ?? []).map((error) => `${fileName}: ${error.instancePath || '(ルート)'} ${error.message ?? ''}`.trim());
}

/**
 * agents.json の中の関係を検証する。形式は JSON Schema で検証済みであることを前提とする。
 *
 * @param {AgentsConfig} config
 * @returns {string[]} 問題点の一覧
 */
export function validateAgentRelations(config) {
  /** @type {string[]} */
  const errors = [];
  const agentIds = new Set(Object.keys(config.agents));

  /**
   * @param {string} role エラーメッセージに表示する役割
   * @param {string} agentId
   */
  const requireRegistered = (role, agentId) => {
    if (!agentIds.has(agentId)) {
      errors.push(`agents.json: ${role} の "${agentId}" は agents に登録されていません`);
    }
  };

  for (const [stage, agentId] of Object.entries(config.roles.author)) {
    requireRegistered(`roles.author.${stage}`, agentId);
  }
  for (const agentId of config.roles.implementers) {
    requireRegistered('roles.implementers', agentId);
  }
  requireRegistered('roles.reviewer', config.roles.reviewer);

  // PR の作成者は自分の PR を Approve できないため、レビュー担当は PR を作るエージェントと別にする
  const authors = new Set([...Object.values(config.roles.author), ...config.roles.implementers]);
  if (authors.has(config.roles.reviewer)) {
    errors.push(`agents.json: roles.reviewer の "${config.roles.reviewer}" は、作成担当 (roles.author) や実装担当 (roles.implementers) と別のエージェントにしてください`);
  }

  // Bot 名と Assignee からエージェントを引き当てるため、エージェントどうしで重複させない
  for (const field of /** @type {const} */ (['bot', 'assignee', 'workflow'])) {
    /** @type {Map<string, string>} */
    const owners = new Map();
    for (const [agentId, agent] of Object.entries(config.agents)) {
      const value = agent[field].toLowerCase();
      const owner = owners.get(value);
      if (owner === undefined) {
        owners.set(value, agentId);
      } else {
        errors.push(`agents.json: "${owner}" と "${agentId}" の ${field} が同じです`);
      }
    }
  }

  return errors;
}

/**
 * GitHub App の Bot 名から、登録済みのエージェントを探す。
 *
 * @param {AgentsConfig} config
 * @param {string | null | undefined} login 探すアカウントのログイン名
 * @returns {RegisteredAgent | undefined}
 */
export function findAgentByBot(config, login) {
  return findAgent(config, 'bot', login);
}

/**
 * Assignee のログイン名から、登録済みのエージェントを探す。
 *
 * @param {AgentsConfig} config
 * @param {string | null | undefined} login 探すアカウントのログイン名
 * @returns {RegisteredAgent | undefined}
 */
export function findAgentByAssignee(config, login) {
  return findAgent(config, 'assignee', login);
}

/**
 * 識別子から、登録済みのエージェントを取り出す。
 *
 * @param {AgentsConfig} config
 * @param {string} agentId
 * @returns {RegisteredAgent}
 * @throws {Error} 登録されていない場合
 */
export function getAgent(config, agentId) {
  const agent = Object.hasOwn(config.agents, agentId) ? config.agents[agentId] : undefined;
  if (agent === undefined) {
    throw new Error(`エージェント "${agentId}" は登録されていません`);
  }
  return { id: agentId, ...agent };
}

/**
 * 機能ごとのディレクトリのパスを返す。
 *
 * @param {StagesConfig} config
 * @param {number} issueNumber 機能の親 Issue の番号
 * @param {string} featureName 機能名
 * @returns {string}
 * @throws {Error} 機能名の形式が正しくない場合
 */
export function featureDirectory(config, issueNumber, featureName) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Issue の番号が正しくありません: ${issueNumber}`);
  }
  if (!isValidFeatureName(featureName)) {
    throw new Error(`機能名は英小文字・数字とハイフンで、${MAX_FEATURE_NAME_LENGTH} 文字以内にしてください: "${featureName}"`);
  }
  return `${config.featureRoot}/${issueNumber}-${featureName}`;
}

/**
 * 機能名の形式が正しいか判定する。
 *
 * @param {string} featureName
 * @returns {boolean}
 */
export function isValidFeatureName(featureName) {
  return featureName.length <= MAX_FEATURE_NAME_LENGTH && FEATURE_NAME_PATTERN.test(featureName);
}

/**
 * 段階ごとに変更してよいファイルの glob から、{featureRoot} と {featureDir} を置き換えたものを返す。
 *
 * @param {StagesConfig} config
 * @param {ReviewedStage} stage
 * @param {string} featureDir featureDirectory で求めた機能ごとのディレクトリ
 * @returns {{ allow: string[], deny: string[] }}
 */
export function expandStageFiles(config, stage, featureDir) {
  const files = config.stages[stage];
  /** @param {string} pattern */
  const expand = (pattern) => pattern.replaceAll('{featureRoot}', config.featureRoot).replaceAll('{featureDir}', featureDir);
  return { allow: files.allow.map(expand), deny: (files.deny ?? []).map(expand) };
}

/**
 * @param {AgentsConfig} config
 * @param {'bot' | 'assignee'} field
 * @param {string | null | undefined} login
 * @returns {RegisteredAgent | undefined}
 */
function findAgent(config, field, login) {
  if (!login) {
    return undefined;
  }
  // GitHub のログイン名は大文字と小文字を区別しない
  const target = login.toLowerCase();
  const entry = Object.entries(config.agents).find(([, agent]) => agent[field].toLowerCase() === target);
  return entry === undefined ? undefined : { id: entry[0], ...entry[1] };
}

/**
 * @param {string} path
 * @returns {Promise<unknown>}
 * @throws {ConfigError} ファイルを読めないか、JSON として正しくない場合
 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ConfigError([`${path} を読み込めません: ${error instanceof Error ? error.message : String(error)}`]);
  }
}
