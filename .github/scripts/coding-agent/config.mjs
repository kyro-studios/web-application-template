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
 * @property {string} bot GitHub App の Bot 名 (<slug>[bot])
 * @property {string} workflow エージェントを動かすワークフローのファイル名
 * @property {string} appClientId GitHub App の Client ID
 * @property {Execution} [fix] このエージェントが作った PR を修正するときのモデルと effort
 */

/**
 * モデルと effort。省略するか null なら、エージェントのツールの既定を使う
 * @typedef {object} Execution
 * @property {string | null} [model]
 * @property {string | null} [effort]
 */

/**
 * 担当のエージェントと、そのエージェントが使うモデルと effort
 * @typedef {Execution & { agent: string }} Assignment
 */

/**
 * @typedef {'specification' | 'domain-model' | 'architecture' | 'project' | 'planning'} AuthoredStage
 */

/**
 * 段階ごとの担当
 * @typedef {object} Roles
 * @property {{ reviewer: Assignment }} requirements
 * @property {{ author: Assignment, reviewer: Assignment }} specification
 * @property {{ author: Assignment, reviewer: Assignment }} domain-model
 * @property {{ author: Assignment, reviewer: Assignment }} architecture
 * @property {{ author: Assignment, reviewer: Assignment }} project
 * @property {{ author: Assignment }} planning
 * @property {{ implementers: Assignment[], reviewer: Assignment }} implementation
 */

/**
 * エージェントに依頼するときの、担当のエージェントとモデルと effort
 * @typedef {object} ResolvedAssignment
 * @property {RegisteredAgent} agent
 * @property {{ model: string | null, effort: string | null }} execution
 */

/**
 * 進行役の GitHub App。振り分け用のワークフローの書き込み (段階の Issue の作成など) に使う
 * @typedef {object} Coordinator
 * @property {string} bot GitHub App の Bot 名 (<slug>[bot])
 * @property {string} appClientId GitHub App の Client ID
 */

/**
 * @typedef {object} AgentsConfig
 * @property {Coordinator} coordinator 進行役の GitHub App
 * @property {Record<string, Agent>} agents 登録するエージェント (キーは識別子)
 * @property {Roles} roles 段階ごとの担当
 */

/**
 * @typedef {'requirements' | 'specification' | 'domain-model' | 'architecture' | 'project' | 'implementation'} ReviewedStage
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

/**
 * 作成担当 (roles.<段階>.author) を設定する段階
 * @type {readonly AuthoredStage[]}
 */
export const AUTHORED_STAGES = ['specification', 'domain-model', 'architecture', 'project', 'planning'];

/**
 * レビュー担当 (roles.<段階>.reviewer) を設定する段階
 * @type {readonly ReviewedStage[]}
 */
export const REVIEWED_STAGES = ['requirements', 'specification', 'domain-model', 'architecture', 'project', 'implementation'];

/** 設定ファイルを置くディレクトリ (リポジトリのルートからの相対パス) */
export const CONFIG_DIR = '.github/coding-agent';

/** 機能名 (ディレクトリ名に使う識別子) の形式 */
export const FEATURE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 機能名の長さの上限 */
export const MAX_FEATURE_NAME_LENGTH = 50;

/** 担当のエージェントを表すラベルの接頭辞。ラベルは agent:<識別子> */
export const AGENT_LABEL_PREFIX = 'agent:';

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

  for (const stage of AUTHORED_STAGES) {
    requireRegistered(`roles.${stage}.author`, config.roles[stage].author.agent);
  }
  const implementers = config.roles.implementation.implementers.map((assignment) => assignment.agent);
  for (const agentId of implementers) {
    requireRegistered('roles.implementation.implementers', agentId);
  }
  if (new Set(implementers).size !== implementers.length) {
    errors.push('agents.json: roles.implementation.implementers に同じエージェントが重複しています');
  }
  for (const stage of REVIEWED_STAGES) {
    requireRegistered(`roles.${stage}.reviewer`, config.roles[stage].reviewer.agent);
  }

  // PR の作成者は自分の PR を Approve できないため、レビュー担当は、その段階の PR を作るエージェントと別にする
  for (const stage of REVIEWED_STAGES) {
    const reviewer = config.roles[stage].reviewer.agent;
    const authors = stage === 'implementation' ? implementers : stage === 'requirements' ? [] : [config.roles[stage].author.agent];
    if (authors.includes(reviewer)) {
      errors.push(`agents.json: roles.${stage}.reviewer の "${reviewer}" は、その段階の作成担当と別のエージェントにしてください`);
    }
  }

  // 段階の Issue は作成者 (進行役の Bot) で見分けるため、エージェントの Bot と同じにしない
  const coordinatorBot = config.coordinator.bot.toLowerCase();
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (agent.bot.toLowerCase() === coordinatorBot) {
      errors.push(`agents.json: coordinator と "${agentId}" の bot が同じです`);
    }
  }

  // Bot 名からエージェントを引き当てるため、エージェントどうしで重複させない
  for (const field of /** @type {const} */ (['bot', 'workflow'])) {
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
 * アカウントが進行役の GitHub App の Bot か判定する。
 *
 * @param {AgentsConfig} config
 * @param {string | null | undefined} login 判定するアカウントのログイン名
 * @returns {boolean}
 */
export function isCoordinator(config, login) {
  // GitHub のログイン名は大文字と小文字を区別しない
  return typeof login === 'string' && login.toLowerCase() === config.coordinator.bot.toLowerCase();
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
 * 担当のエージェントを表すラベルを返す。
 *
 * @param {string} agentId エージェントの識別子
 * @returns {string}
 */
export function agentLabel(agentId) {
  return `${AGENT_LABEL_PREFIX}${agentId}`;
}

/**
 * ラベルの名前から、登録済みのエージェントを探す。
 *
 * @param {AgentsConfig} config
 * @param {string | null | undefined} name 探すラベルの名前
 * @returns {RegisteredAgent | undefined}
 */
export function findAgentByLabel(config, name) {
  // GitHub のラベルの名前は大文字と小文字を区別しない
  const lower = name?.toLowerCase();
  if (!lower?.startsWith(AGENT_LABEL_PREFIX)) {
    return undefined;
  }
  const agentId = lower.slice(AGENT_LABEL_PREFIX.length);
  return Object.hasOwn(config.agents, agentId) ? getAgent(config, agentId) : undefined;
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
 * 担当の設定から、依頼に使うエージェントとモデルと effort を求める。
 *
 * @param {AgentsConfig} config
 * @param {Assignment} assignment
 * @returns {ResolvedAssignment}
 */
function resolveAssignment(config, assignment) {
  return { agent: getAgent(config, assignment.agent), execution: toExecution(assignment) };
}

/**
 * @param {Execution | undefined} execution
 * @returns {{ model: string | null, effort: string | null }}
 */
function toExecution(execution) {
  return { model: execution?.model ?? null, effort: execution?.effort ?? null };
}

/**
 * 段階の作成担当を返す。
 *
 * @param {AgentsConfig} config
 * @param {AuthoredStage} stage
 * @returns {ResolvedAssignment}
 */
export function getAuthor(config, stage) {
  return resolveAssignment(config, config.roles[stage].author);
}

/**
 * 実装タスクの担当に選べるエージェントを返す。
 *
 * @param {AgentsConfig} config
 * @returns {ResolvedAssignment[]}
 */
export function getImplementers(config) {
  return config.roles.implementation.implementers.map((assignment) => resolveAssignment(config, assignment));
}

/**
 * 段階のレビュー担当を返す。
 *
 * @param {AgentsConfig} config
 * @param {ReviewedStage} stage
 * @returns {ResolvedAssignment}
 */
export function getReviewer(config, stage) {
  return resolveAssignment(config, config.roles[stage].reviewer);
}

/**
 * エージェントが自分の作った PR を修正するときの、モデルと effort を返す。
 *
 * @param {RegisteredAgent} agent
 * @returns {{ model: string | null, effort: string | null }}
 */
export function fixExecution(agent) {
  return toExecution(agent.fix);
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
 * @param {'bot'} field
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
