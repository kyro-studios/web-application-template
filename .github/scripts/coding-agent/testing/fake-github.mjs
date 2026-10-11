/**
 * テスト用に、actions/github-script の github のうち、Issue の操作に使うものをメモリ上で再現する。
 */

/**
 * @typedef {object} FakeIssue
 * @property {number} id
 * @property {string} node_id
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {'open' | 'closed'} state
 * @property {string | null} state_reason
 * @property {{ login: string }} user
 * @property {{ name: string }[]} labels
 * @property {{ login: string }[]} assignees
 * @property {number | undefined} parent 親 Issue の番号
 * @property {number[]} blockedBy この Issue を Blocking している Issue の番号
 */

/**
 * @param {object} options
 * @param {string} options.actor API を呼び出すアカウント (作成した Issue の作成者になる)
 * @param {Record<string, string>} [options.permissions] アカウントごとのリポジトリの権限 (無ければコラボレーターでない)
 */
export function createFakeGitHub({ actor, permissions = {} }) {
  /** @type {Map<number, FakeIssue>} */
  const issues = new Map();
  /** @type {{ issue_number: number, body: string }[]} */
  const comments = [];
  let nextNumber = 1;

  /**
   * @param {{ title?: string, body?: string, labels?: string[], user?: string, state?: 'open' | 'closed', parent?: number }} fields
   * @returns {FakeIssue}
   */
  const addIssue = (fields) => {
    const number = nextNumber++;
    const issue = {
      id: 1000 + number,
      node_id: `I_${number}`,
      number,
      title: fields.title ?? `Issue ${number}`,
      body: fields.body ?? '',
      state: fields.state ?? 'open',
      state_reason: null,
      user: { login: fields.user ?? actor },
      labels: (fields.labels ?? []).map((name) => ({ name })),
      assignees: [],
      parent: fields.parent,
      blockedBy: [],
    };
    issues.set(number, issue);
    return issue;
  };

  /** @param {number} number */
  const getIssue = (number) => {
    const issue = issues.get(number);
    if (issue === undefined) {
      throw Object.assign(new Error(`Issue #${number} がありません`), { status: 404 });
    }
    return issue;
  };

  /** @param {string} nodeId */
  const getIssueByNodeId = (nodeId) => {
    const issue = [...issues.values()].find((candidate) => candidate.node_id === nodeId);
    if (issue === undefined) {
      throw new Error(`Node ${nodeId} がありません`);
    }
    return issue;
  };

  const github = {
    rest: {
      repos: {
        /** @param {{ username: string }} params */
        getCollaboratorPermissionLevel: async ({ username }) => {
          const permission = permissions[username];
          if (permission === undefined) {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          }
          return { data: { permission } };
        },
      },
      issues: {
        /** @param {{ title: string, body: string, labels: string[] }} params */
        create: async ({ title, body, labels }) => ({ data: structuredClone(addIssue({ title, body, labels })) }),
        /** @param {{ issue_number: number }} params */
        get: async ({ issue_number }) => ({ data: structuredClone(getIssue(issue_number)) }),
        /** @param {{ issue_number: number, assignees: string[] }} params */
        addAssignees: async ({ issue_number, assignees }) => {
          const issue = getIssue(issue_number);
          for (const login of assignees) {
            // コラボレーターでないアカウントは、エラーにならずに無視される
            if (permissions[login] !== undefined && !issue.assignees.some((user) => user.login === login)) {
              issue.assignees.push({ login });
            }
          }
          return { data: structuredClone(issue) };
        },
        /** @param {{ issue_number: number, body: string }} params */
        createComment: async ({ issue_number, body }) => {
          comments.push({ issue_number, body });
          return { data: {} };
        },
        /** @param {{ issue_number: number, state: 'open' | 'closed', state_reason: string }} params */
        update: async ({ issue_number, state, state_reason }) => {
          const issue = getIssue(issue_number);
          issue.state = state;
          issue.state_reason = state_reason;
          return { data: structuredClone(issue) };
        },
      },
    },

    /**
     * @param {string} route
     * @param {{ issue_number: number }} params
     */
    paginate: async (route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues') {
        return [...issues.values()].filter((issue) => issue.parent === params.issue_number).map((issue) => structuredClone(issue));
      }
      throw new Error(`想定していない API です: ${route}`);
    },

    /**
     * @param {string} route
     * @param {{ issue_number: number, sub_issue_id: number }} params
     */
    request: async (route, params) => {
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues') {
        const issue = [...issues.values()].find((candidate) => candidate.id === params.sub_issue_id);
        if (issue === undefined) {
          throw new Error(`ID ${params.sub_issue_id} の Issue がありません`);
        }
        issue.parent = params.issue_number;
        return { data: {} };
      }
      throw new Error(`想定していない API です: ${route}`);
    },

    /**
     * @param {string} query
     * @param {Record<string, any>} variables
     */
    graphql: async (query, variables) => {
      if (query.includes('addBlockedBy')) {
        const issue = getIssueByNodeId(variables.issueId);
        const blocking = getIssueByNodeId(variables.blockingIssueId);
        if (issue.blockedBy.includes(blocking.number)) {
          throw new Error('既に Blocked by の関係があります');
        }
        issue.blockedBy.push(blocking.number);
        return { addBlockedBy: { issue: { id: issue.node_id } } };
      }
      const issue = issues.get(variables.number) ?? null;
      if (query.includes('blockedBy(first')) {
        return { repository: { issue: issue && { blockedBy: { nodes: issue.blockedBy.map((number) => ({ number })) } } } };
      }
      if (query.includes('parent {')) {
        return { repository: { issue: issue && { parent: issue.parent === undefined ? null : { number: issue.parent } } } };
      }
      throw new Error(`想定していないクエリです: ${query}`);
    },
  };

  return { github, issues, comments, addIssue };
}

/**
 * actions/github-script の core のうち、ハンドラーが使うものを記録する。
 */
export function createFakeCore() {
  /** @type {Record<string, string>} */
  const outputs = {};
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const warnings = [];
  return {
    outputs,
    failures,
    warnings,
    /** @param {string} name @param {string} value */
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    /** @param {string} message */
    setFailed: (message) => {
      failures.push(message);
    },
    /** @param {string} message */
    warning: (message) => {
      warnings.push(message);
    },
    info: () => {},
    notice: () => {},
  };
}
