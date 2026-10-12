/**
 * PR の情報 (Close する Issue、変更されたファイル、レビュー) を取得する GitHub API の呼び出し。
 */

/**
 * @typedef {import('./github-issues.mjs').GitHub} GitHub
 * @typedef {import('./github-issues.mjs').Repository} Repository
 * @typedef {import('./changed-files.mjs').ChangedFile} ChangedFile
 */

/**
 * これまでのレビュー
 * @typedef {object} PastReview
 * @property {number} id
 * @property {string} state APPROVED、CHANGES_REQUESTED、COMMENTED など
 * @property {string} commitId レビューしたコミット
 * @property {string} submittedAt
 * @property {string} body レビューの本文
 * @property {{ path: string, line: number | null, body: string }[]} comments 行へのコメント
 */

/**
 * PR が Close する Issue (本文の Closes #N など) の番号を取得する。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} pullRequestNumber
 * @returns {Promise<number[]>}
 */
export async function getClosingIssueNumbers(github, repository, pullRequestNumber) {
  /** @type {{ repository: { pullRequest: { closingIssuesReferences: { nodes: { number: number }[] } } | null } }} */
  const result = await github.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 10) { nodes { number } }
        }
      }
    }`,
    { ...repository, number: pullRequestNumber },
  );
  return result.repository.pullRequest?.closingIssuesReferences.nodes.map((node) => node.number) ?? [];
}

/**
 * PR で変更されたファイルをすべて取得する。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} pullRequestNumber
 * @returns {Promise<(ChangedFile & { patch?: string })[]>}
 */
export async function listChangedFiles(github, repository, pullRequestNumber) {
  return github.paginate(github.rest.pulls.listFiles, { ...repository, pull_number: pullRequestNumber, per_page: 100 });
}

/**
 * 指定したアカウントが PR に投稿したレビューを、行へのコメントとあわせて取得する。古いものから順に並べる。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} pullRequestNumber
 * @param {string} login レビューを投稿したアカウント
 * @returns {Promise<PastReview[]>}
 */
export async function listReviewsBy(github, repository, pullRequestNumber, login) {
  const target = login.toLowerCase();
  /** @type {{ id: number, state: string, commit_id: string | null, submitted_at?: string | null, body: string | null, user: { login: string } | null }[]} */
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repository, pull_number: pullRequestNumber, per_page: 100 });
  const own = reviews.filter((review) => review.user?.login.toLowerCase() === target);
  if (own.length === 0) {
    return [];
  }

  /** @type {{ pull_request_review_id: number | null, path: string, line?: number | null, body: string }[]} */
  const comments = await github.paginate(github.rest.pulls.listReviewComments, {
    ...repository,
    pull_number: pullRequestNumber,
    per_page: 100,
  });
  return own.map((review) => ({
    id: review.id,
    state: review.state,
    commitId: review.commit_id ?? '',
    submittedAt: review.submitted_at ?? '',
    body: review.body ?? '',
    comments: comments
      .filter((comment) => comment.pull_request_review_id === review.id)
      .map((comment) => ({ path: comment.path, line: comment.line ?? null, body: comment.body })),
  }));
}

/**
 * PR をマージできるかどうか (mergeable_state) を取得する。GitHub は、マージできるかどうかを裏で計算するため、
 * 計算が終わっていなければ (mergeable が null なら)、間を空けて取得し直す。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {number} pullRequestNumber
 * @param {object} [options]
 * @param {number} [options.attempts] 取得する回数の上限
 * @param {number} [options.intervalMs] 取得し直すまでの間隔
 * @returns {Promise<string>} mergeable_state (コンフリクトしていれば 'dirty')。計算が終わらなければ 'unknown'
 */
export async function getMergeableState(github, repository, pullRequestNumber, { attempts = 6, intervalMs = 10_000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    /** @type {{ data: { mergeable?: boolean | null, mergeable_state?: string } }} */
    const { data } = await github.rest.pulls.get({ ...repository, pull_number: pullRequestNumber });
    if (data.mergeable !== null && data.mergeable !== undefined) {
      return data.mergeable_state ?? 'unknown';
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return 'unknown';
}
