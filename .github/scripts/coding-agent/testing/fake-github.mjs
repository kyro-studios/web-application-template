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
 * @property {Record<string, any>} [detail] pulls.get が返す PR の内容 (state、head、base など)
 */

/**
 * @param {object} options
 * @param {string} options.actor API を呼び出すアカウント (作成した Issue の作成者になる)
 * @param {Record<string, string>} [options.permissions] アカウントごとのリポジトリの権限 (無ければコラボレーターでない)
 */
export function createFakeGitHub({ actor, permissions = {} }) {
  /** @type {Map<number, FakeIssue>} */
  const issues = new Map();
  /** @type {{ issue_number: number, body: string, user: { login: string }, created_at?: string }[]} */
  const comments = [];
  /** @type {Record<string, string>} */
  const branches = {};
  /** リポジトリのファイル (パスをキーにする。どのコミットを指定しても同じ内容を返す) */
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {{ issue_number: number, event: string, label?: { name: string }, created_at: string }[]} */
  const events = [];
  /** コメントやイベントの日時 (追加した順に進める) */
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const now = () => new Date((clock += 1000)).toISOString();
  /** @type {Map<number, FakePullRequest>} */
  const pulls = new Map();
  /**
   * 既定ブランチのコミット (push の前後の比較で返す順)。pulls は、コミットにひも付く PR
   * @type {{ sha: string, message: string, files: { filename: string, status: string, previous_filename?: string }[], pulls: { number: number, merged_at: string | null }[] }[]}
   */
  const commits = [];
  /** リポジトリのラベル (名前の小文字をキーにする) */
  /** @type {Map<string, { name: string, color: string, description: string }>} */
  const labels = new Map();
  let nextNumber = 1;

  /**
   * PR の情報を登録する (Issue と番号が重ならないように指定する)。
   *
   * @param {number} number
   * @param {Partial<FakePullRequest>} [fields]
   */
  const addPull = (number, fields = {}) => {
    pulls.set(number, { closing: [], files: [], reviews: [], reviewComments: [], ...fields });
    // Issue の API でも PR を取得できるようにする
    const detail = fields.detail ?? {};
    issues.set(number, {
      id: 1000 + number,
      node_id: `PR_${number}`,
      number,
      title: detail.title ?? `PR ${number}`,
      body: detail.body ?? '',
      state: detail.state ?? 'open',
      state_reason: null,
      user: detail.user ?? { login: actor },
      labels: detail.labels ?? [],
      assignees: [],
      parent: undefined,
      blockedBy: [],
      closingPulls: [],
      pull_request: {},
    });
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
    /** @param {{ state?: string }} params */
    list: async ({ state = 'open' }) => ({
      data: structuredClone(
        [...pulls.entries()]
          .filter(([, pull]) => state === 'all' || (pull.detail?.state ?? 'open') === state)
          .map(([number, pull]) => ({ ...pull.detail, labels: issues.get(number)?.labels ?? [], number })),
      ),
    }),
    /** @param {{ pull_number: number }} params */
    get: async ({ pull_number }) => {
      const issue = issues.get(pull_number);
      return { data: structuredClone({ ...getPull(pull_number).detail, labels: issue?.labels ?? [], number: pull_number }) };
    },
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
        /** @param {{ per_page: number }} params */
        compareCommitsWithBasehead: async ({ per_page }) => ({
          data: {
            total_commits: commits.length,
            commits: commits.slice(0, per_page).map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })),
          },
        }),
        /** @param {{ ref: string, per_page: number, page: number }} params */
        getCommit: async ({ ref, per_page, page }) => {
          const commit = commits.find((candidate) => candidate.sha === ref);
          if (commit === undefined) {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          }
          return { data: { sha: ref, files: structuredClone(commit.files.slice((page - 1) * per_page, page * per_page)) } };
        },
        /** @param {{ commit_sha: string }} params */
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data: structuredClone(commits.find((candidate) => candidate.sha === commit_sha)?.pulls ?? []),
        }),
        /** @param {{ path: string, ref?: string }} params */
        getContent: async ({ path }) => {
          const content = files.get(path);
          if (content === undefined) {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          }
          return { data: { type: 'file', path, encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') } };
        },
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
        /** @param {{ labels?: string, state?: 'open' | 'closed' }} params */
        listForRepo: async ({ labels: label, state = 'open' }) => ({
          data: structuredClone(
            [...issues.values()].filter(
              (issue) => issue.state === state && (label === undefined || issue.labels.some((candidate) => candidate.name === label)),
            ),
          ),
        }),
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
          comments.push({ issue_number, body, user: { login: actor }, created_at: now() });
          return { data: {} };
        },
        /** @param {{ name: string }} params */
        getLabel: async ({ name }) => {
          const label = labels.get(name.toLowerCase());
          if (label === undefined) {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          }
          return { data: structuredClone(label) };
        },
        /** @param {{ name: string, color: string, description: string }} params */
        createLabel: async ({ name, color, description }) => {
          if (labels.has(name.toLowerCase())) {
            throw Object.assign(new Error('Validation Failed'), { status: 422 });
          }
          labels.set(name.toLowerCase(), { name, color, description });
          return { data: { name, color, description } };
        },
        /** @param {{ issue_number: number, labels: string[] }} params */
        addLabels: async ({ issue_number, labels: names }) => {
          const issue = getIssue(issue_number);
          for (const name of names) {
            if (!issue.labels.some((label) => label.name === name)) {
              issue.labels.push({ name });
              events.push({ issue_number, event: 'labeled', label: { name }, created_at: now() });
            }
          }
          return { data: structuredClone(issue.labels) };
        },
        /** @param {{ issue_number: number, name: string }} params */
        removeLabel: async ({ issue_number, name }) => {
          const issue = getIssue(issue_number);
          issue.labels = issue.labels.filter((label) => label.name !== name);
          events.push({ issue_number, event: 'unlabeled', label: { name }, created_at: now() });
          return { data: structuredClone(issue.labels) };
        },
        /** @param {{ issue_number: number }} params */
        listEvents: async ({ issue_number }) => ({ data: structuredClone(events.filter((event) => event.issue_number === issue_number)) }),
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
      if (route === github.rest.issues.listEvents) {
        return (await github.rest.issues.listEvents(/** @type {any} */ (params))).data;
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

  /**
   * 別のアカウントのコメントを追加する。
   *
   * @param {number} issueNumber
   * @param {string} login
   * @param {string} body
   */
  const addComment = (issueNumber, login, body) => {
    comments.push({ issue_number: issueNumber, body, user: { login }, created_at: now() });
  };

  return { github, issues, comments, pulls, branches, events, labels, commits, files, addIssue, addPull, addComment };
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
