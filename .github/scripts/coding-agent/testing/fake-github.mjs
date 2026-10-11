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
 * @property {{ number: number, state: 'OPEN' | 'CLOSED' | 'MERGED' }[]} closingPulls この Issue を Close する (した) PR
 */

/**
 * @typedef {object} FakePullRequest
 * @property {number[]} closing PR が Close する Issue の番号
 * @property {{ filename: string, previous_filename?: string, patch?: string }[]} files 変更されたファイル
 * @property {{ id: number, state: string, commit_id: string, submitted_at: string, body: string, user: { login: string } }[]} reviews
 * @property {{ pull_request_review_id: number, path: string, line: number | null, body: string }[]} reviewComments
 */

/**
 * @param {object} options
 * @param {string} options.actor API を呼び出すアカウント (作成した Issue の作成者になる)
 * @param {Record<string, string>} [options.permissions] アカウントごとのリポジトリの権限 (無ければコラボレーターでない)
 */
export function createFakeGitHub({ actor, permissions = {} }) {
  /** @type {Map<number, FakeIssue>} */
  const issues = new Map();
  /** @type {{ issue_number: number, body: string, user: { login: string } }[]} */
  const comments = [];
  /** @type {Record<string, string>} */
  const branches = {};
  /** @type {Map<number, FakePullRequest>} */
  const pulls = new Map();
  let nextNumber = 1;

  /**
   * PR の情報を登録する (Issue と番号が重ならないように指定する)。
   *
   * @param {number} number
   * @param {Partial<FakePullRequest>} [fields]
   */
  const addPull = (number, fields = {}) => {
    pulls.set(number, { closing: [], files: [], reviews: [], reviewComments: [], ...fields });
  };

  /** @param {number} number */
  const getPull = (number) => {
    const pull = pulls.get(number);
    if (pull === undefined) {
      throw Object.assign(new Error(), { status: 404 });
    }
    return pull;
  };

  const pullsApi = {
    /** @param {{ pull_number: number }} params */
    listFiles: async ({ pull_number }) => ({ data: structuredClone(getPull(pull_number).files) }),
    /** @param {{ pull_number: number }} params */
    listReviews: async ({ pull_number }) => ({ data: structuredClone(getPull(pull_number).reviews) }),
    /** @param {{ pull_number: number }} params */
    listReviewComments: async ({ pull_number }) => ({ data: structuredClone(getPull(pull_number).reviewComments) }),
  };

  /**
   * @param {{ title?: string, body?: string, labels?: string[], user?: string, state?: 'open' | 'closed', parent?: number, assignees?: string[] }} fields
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
      assignees: (fields.assignees ?? []).map((login) => ({ login })),
      parent: fields.parent,
      blockedBy: [],
      closingPulls: [],
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
      pulls: pullsApi,
      repos: {
        /** @param {{ branch: string }} params */
        getBranch: async ({ branch }) => {
          const sha = branches[branch];
          if (sha === undefined) {
            throw Object.assign(new Error(`ブランチ ${branch} がありません`), { status: 404 });
          }
          return { data: { name: branch, commit: { sha } } };
        },
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
          comments.push({ issue_number, body, user: { login: actor } });
          return { data: {} };
        },
        /** @param {{ issue_number: number }} params */
        listComments: async ({ issue_number }) => ({
          data: structuredClone(comments.filter((comment) => comment.issue_number === issue_number)),
        }),
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
      if (route === github.rest.issues.listComments) {
        return (await github.rest.issues.listComments(/** @type {any} */ (params))).data;
      }
      for (const [name, method] of Object.entries(pullsApi)) {
        if (route === method) {
          return (await pullsApi[/** @type {keyof typeof pullsApi} */ (name)](/** @type {any} */ (params))).data;
        }
      }
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
      if (query.includes('closingIssuesReferences')) {
        const pull = pulls.get(variables.number);
        return { repository: { pullRequest: pull && { closingIssuesReferences: { nodes: pull.closing.map((number) => ({ number })) } } } };
      }
      const issue = issues.get(variables.number) ?? null;
      if (query.includes('fragment Dependency')) {
        /** @param {number[]} numbers */
        const connection = (numbers) => ({
          totalCount: numbers.length,
          nodes: numbers.map((number) => {
            const dependency = getIssue(number);
            return {
              number,
              state: dependency.state === 'open' ? 'OPEN' : 'CLOSED',
              closedByPullRequestsReferences: { nodes: dependency.closingPulls },
            };
          }),
        });
        const subIssues = [...issues.values()].filter((candidate) => candidate.parent === variables.number).map((candidate) => candidate.number);
        return { repository: { issue: issue && { subIssues: connection(subIssues), blockedBy: connection(issue.blockedBy) } } };
      }
      if (query.includes('blocking(first')) {
        const blocking = [...issues.values()].filter((candidate) => candidate.blockedBy.includes(variables.number)).map((number) => ({ number: number.number }));
        return { repository: { issue: issue && { parent: issue.parent === undefined ? null : { number: issue.parent }, blocking: { nodes: blocking } } } };
      }
      if (query.includes('blockedBy(first')) {
        return { repository: { issue: issue && { blockedBy: { nodes: issue.blockedBy.map((number) => ({ number })) } } } };
      }
      if (query.includes('parent {')) {
        return { repository: { issue: issue && { parent: issue.parent === undefined ? null : { number: issue.parent } } } };
      }
      throw new Error(`想定していないクエリです: ${query}`);
    },
  };

  return { github, issues, comments, pulls, branches, addIssue, addPull };
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
