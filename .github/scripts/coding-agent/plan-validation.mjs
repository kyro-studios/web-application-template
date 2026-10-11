/**
 * 実装計画の作成担当が出力した計画 (JSON) を検証する。
 * 計画は信頼できない入力として扱い、Issue を 1 件も作成する前にすべての項目を確認する。
 */

/**
 * @typedef {object} PlanTask
 * @property {string} key 計画内で一意なタスクの識別子
 * @property {string} title Issue のタイトル
 * @property {string} body Issue の本文
 * @property {string | null} agent 担当エージェントの識別子 (人が対応するタスクなら null)
 * @property {string | null} parent 親タスクの key (実装計画の Issue の直下なら null)
 * @property {string[]} blocked_by 先に完了している必要があるタスクの key
 */

/**
 * @typedef {object} Plan
 * @property {string} summary 計画全体の概要
 * @property {PlanTask[]} tasks タスクの一覧
 */

/**
 * @typedef {object} ValidationOptions
 * @property {ReadonlySet<string>} agents 利用できるエージェントの識別子
 * @property {number} maxTasks 1 回の計画で作成できるタスクの上限
 * @property {number} maxDepth 実装計画の Issue の直下を 1 階層目とした、親子関係の深さの上限
 * @property {number} rootCapacity 実装計画の Issue の直下に追加できる Sub Issue の数
 */

export const TASK_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

/** GitHub の Issue のタイトルの上限 */
export const MAX_TITLE_LENGTH = 256;

/** GitHub の Issue の本文の上限 (65536 文字) から、ワークフローが追記する分を差し引いた長さ */
export const MAX_BODY_LENGTH = 60000;

/** GitHub で入れ子にできる Sub Issue の階層の上限 */
export const MAX_SUB_ISSUE_LEVELS = 8;

/** 仕組みが Issue やコメントに埋め込む印の書き出し。計画の本文には含めさせない */
const MARKER_PREFIX = '<!-- coding-agent';

/** GitHub で 1 つの Issue に紐づけられる Sub Issue の上限 */
export const MAX_SUB_ISSUES = 100;

const PLAN_FIELDS = ['summary', 'tasks'];
const TASK_FIELDS = ['key', 'title', 'body', 'agent', 'parent', 'blocked_by'];

/**
 * 計画を検証し、問題点の一覧を返す。空なら計画をそのまま適用できる。
 *
 * @param {unknown} input 計画役のエージェントの出力
 * @param {ValidationOptions} options
 * @returns {string[]}
 */
export function validatePlan(input, options) {
  if (!isRecord(input)) {
    return ['計画が JSON オブジェクトではありません'];
  }

  const errors = [
    ...findUnknownFields(input, PLAN_FIELDS, '計画'),
    ...(typeof input.summary === 'string' ? [] : ['summary は文字列にしてください']),
  ];
  if (!Array.isArray(input.tasks)) {
    return [...errors, 'tasks は配列にしてください'];
  }

  errors.push(...validateTaskCount(input.tasks.length, options.maxTasks));
  errors.push(...input.tasks.flatMap((task, index) => validateTaskFields(task, index, options.agents)));
  if (errors.length > 0) {
    return errors;
  }

  // ここから先は、各タスクの形式が正しいことを前提に、タスク同士の関係を確認する
  const tasks = /** @type {PlanTask[]} */ (input.tasks);
  const duplicates = findDuplicateKeys(tasks);
  if (duplicates.length > 0) {
    return duplicates.map((key) => `key "${key}" が重複しています`);
  }

  const references = validateReferences(tasks);
  if (references.length > 0) {
    return references;
  }

  return [
    ...validateHierarchy(tasks, options.maxDepth, options.rootCapacity),
    ...findDeadlocks(tasks),
  ];
}

/**
 * @param {number} count タスクの数
 * @param {number} maxTasks タスクの上限
 * @returns {string[]}
 */
function validateTaskCount(count, maxTasks) {
  if (count === 0) {
    return ['タスクが 1 件もありません'];
  }
  if (count > maxTasks) {
    return [`タスクが多すぎます (${count} 件、上限は ${maxTasks} 件)`];
  }
  return [];
}

/**
 * 1 件のタスクについて、各項目の型と値を確認する。
 *
 * @param {unknown} task
 * @param {number} index tasks 内の位置
 * @param {ReadonlySet<string>} agents 利用できるエージェントの識別子
 * @returns {string[]}
 */
function validateTaskFields(task, index, agents) {
  const label = `tasks[${index}]`;
  if (!isRecord(task)) {
    return [`${label} がオブジェクトではありません`];
  }

  const errors = findUnknownFields(task, TASK_FIELDS, label);

  if (typeof task.key !== 'string' || !TASK_KEY_PATTERN.test(task.key)) {
    errors.push(`${label}.key は小文字英数字とハイフンからなる 50 文字以内の文字列にしてください`);
  }

  if (typeof task.title !== 'string' || task.title.trim() === '') {
    errors.push(`${label}.title を入力してください`);
  } else if (task.title.length > MAX_TITLE_LENGTH) {
    errors.push(`${label}.title が長すぎます (${task.title.length} 文字、上限は ${MAX_TITLE_LENGTH} 文字)`);
  }

  if (typeof task.body !== 'string' || task.body.trim() === '') {
    errors.push(`${label}.body を入力してください`);
  } else if (task.body.length > MAX_BODY_LENGTH) {
    errors.push(`${label}.body が長すぎます (${task.body.length} 文字、上限は ${MAX_BODY_LENGTH} 文字)`);
  } else if (task.body.includes(MARKER_PREFIX)) {
    // 仕組みの印を偽造して、作成済みの Issue と取り違えさせないようにする
    errors.push(`${label}.body に、仕組みの印 (${MARKER_PREFIX}) を含めることはできません`);
  }

  if (task.agent !== null && (typeof task.agent !== 'string' || !agents.has(task.agent))) {
    errors.push(`${label}.agent は ${[...agents].join(' / ')} のいずれか、または null にしてください`);
  }

  if (task.parent !== null && typeof task.parent !== 'string') {
    errors.push(`${label}.parent は文字列または null にしてください`);
  }

  if (!Array.isArray(task.blocked_by) || !task.blocked_by.every((key) => typeof key === 'string')) {
    errors.push(`${label}.blocked_by は文字列の配列にしてください`);
  } else if (new Set(task.blocked_by).size !== task.blocked_by.length) {
    errors.push(`${label}.blocked_by に同じ key が重複しています`);
  }

  return errors;
}

/**
 * @param {PlanTask[]} tasks
 * @returns {string[]} 重複している key
 */
function findDuplicateKeys(tasks) {
  const seen = new Set();
  const duplicates = new Set();
  for (const task of tasks) {
    if (seen.has(task.key)) {
      duplicates.add(task.key);
    }
    seen.add(task.key);
  }
  return [...duplicates];
}

/**
 * parent と blocked_by が、計画内の別のタスクを指しているか確認する。
 *
 * @param {PlanTask[]} tasks
 * @returns {string[]}
 */
function validateReferences(tasks) {
  const keys = new Set(tasks.map((task) => task.key));
  /** @type {string[]} */
  const errors = [];

  for (const task of tasks) {
    if (task.parent === task.key) {
      errors.push(`"${task.key}" の parent に自分自身が指定されています`);
    } else if (task.parent !== null && !keys.has(task.parent)) {
      errors.push(`"${task.key}" の parent "${task.parent}" が計画内にありません`);
    }

    for (const blocker of task.blocked_by) {
      if (blocker === task.key) {
        errors.push(`"${task.key}" の blocked_by に自分自身が指定されています`);
      } else if (!keys.has(blocker)) {
        errors.push(`"${task.key}" の blocked_by "${blocker}" が計画内にありません`);
      }
    }
  }

  return errors;
}

/**
 * 親子関係が木構造になっているか、深さと子の数が上限を超えていないか確認する。
 *
 * @param {PlanTask[]} tasks
 * @param {number} maxDepth 親子関係の深さの上限
 * @param {number} rootCapacity 実装計画の Issue の直下に追加できる Sub Issue の数
 * @returns {string[]}
 */
function validateHierarchy(tasks, maxDepth, rootCapacity) {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  /** @type {string[]} */
  const errors = [];

  for (const task of tasks) {
    const depth = measureDepth(task, byKey);
    if (depth === undefined) {
      errors.push(`"${task.key}" の親子関係が循環しています`);
    } else if (depth > maxDepth) {
      errors.push(`"${task.key}" の親子関係が深すぎます (${depth} 階層、上限は ${maxDepth} 階層)`);
    }
  }

  const roots = tasks.filter((task) => task.parent === null).length;
  if (roots > rootCapacity) {
    errors.push(`実装計画の Issue の直下に置くタスクが多すぎます (${roots} 件、追加できるのは ${rootCapacity} 件)`);
  }

  for (const [parent, children] of groupChildren(tasks)) {
    if (children.length > MAX_SUB_ISSUES) {
      errors.push(`"${parent}" の子タスクが多すぎます (${children.length} 件、上限は ${MAX_SUB_ISSUES} 件)`);
    }
  }

  return errors;
}

/**
 * 実装計画の Issue の直下を 1 として、タスクの深さを返す。
 *
 * @param {PlanTask} task
 * @param {ReadonlyMap<string, PlanTask>} byKey
 * @returns {number | undefined} 親子関係が循環している場合は undefined
 */
export function measureDepth(task, byKey) {
  const visited = new Set([task.key]);
  let depth = 1;
  let current = task;
  while (current.parent !== null) {
    const parent = byKey.get(current.parent);
    if (parent === undefined || visited.has(parent.key)) {
      return undefined;
    }
    visited.add(parent.key);
    current = parent;
    depth += 1;
  }
  return depth;
}

/**
 * タスクどうしが互いの完了を待ち合い、どれも着手できなくなる組み合わせを探す。
 * 親タスクはすべての子タスクの完了を、各タスクは blocked_by のタスクの完了を待つ。
 *
 * @param {PlanTask[]} tasks
 * @returns {string[]}
 */
function findDeadlocks(tasks) {
  const children = groupChildren(tasks);
  /** @type {Map<string, string[]>} */
  const waitsFor = new Map(
    tasks.map((task) => [task.key, [...(children.get(task.key) ?? []), ...task.blocked_by]]),
  );

  /** @type {Map<string, 'visiting' | 'done'>} */
  const states = new Map();
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} key
   * @param {string[]} path ここまでにたどったタスク
   */
  const visit = (key, path) => {
    const state = states.get(key);
    if (state === 'done') {
      return;
    }
    if (state === 'visiting') {
      const cycle = [...path.slice(path.indexOf(key)), key];
      errors.push(`タスクが互いの完了を待ち合っています: ${cycle.join(' → ')}`);
      return;
    }
    states.set(key, 'visiting');
    for (const next of waitsFor.get(key) ?? []) {
      visit(next, [...path, key]);
    }
    states.set(key, 'done');
  };

  for (const task of tasks) {
    visit(task.key, []);
  }
  return errors;
}

/**
 * @param {PlanTask[]} tasks
 * @returns {Map<string, string[]>} 親タスクの key ごとの子タスクの key
 */
function groupChildren(tasks) {
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const task of tasks) {
    if (task.parent !== null) {
      children.set(task.parent, [...(children.get(task.parent) ?? []), task.key]);
    }
  }
  return children;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} allowed 許可する項目名
 * @param {string} label エラーメッセージに表示する名前
 * @returns {string[]}
 */
function findUnknownFields(value, allowed, label) {
  return Object.keys(value)
    .filter((field) => !allowed.includes(field))
    .map((field) => `${label} に想定外の項目 "${field}" があります`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
