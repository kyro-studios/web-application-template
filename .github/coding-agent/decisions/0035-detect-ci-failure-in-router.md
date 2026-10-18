# 0035. CI の失敗は振り分け用のワークフローで検知し、Merge Queue の失敗は再実行せずに修正する

- 日付: 2026-10-18
- 状態: 採用

## 背景

アプリケーションの CI (`coding-agent-test.yml`) が失敗したら、PR を作ったエージェントに修正させる (仕様の 9.1)。仕様には、専用のワークフローで `workflow_run` を受けること、失敗した CI は一度だけ再実行すること、Merge Queue で外された PR の特定のしかたは確かめてから決めることを書いていた。

確かめた結果、次のことが分かった。

- `merge_group` の `workflow_run` では、`pull_requests` が空で、PR の番号は `head_branch` (`gh-readonly-queue/<既定ブランチ>/pr-<番号>-<SHA>`) にしか出てこない。`pull_request` の `workflow_run` でも、確認用のリポジトリでは `pull_requests` が空だった
- `pull_request_target` の `dequeued` は、マージされたときにも起きる。外された理由 (`RemovedFromMergeQueueEvent.reason`) の値の一覧は公開されておらず、確認用のリポジトリでは `merged` しか見つからなかった
- `RemovedFromMergeQueueEvent.beforeCommit` は、Merge Queue の CI の実行の `head_sha` と一致していた
- 再実行の完了で `workflow_run` が起きるかは、GITHUB_TOKEN で再実行した場合について、公式のドキュメントで確認できない
- Merge Queue に入れ直す `enqueuePullRequest` には、Contents の書き込み権限が要る。進行役の App は、Contents の読み取りの権限しか持たない
- PR の CI は `develop` とマージした状態を、Merge Queue の CI はほかの PR とあわせた状態をテストする。機械的な実行 (仕様の 6.4) は PR の head だけを試すため、エージェントの手元では失敗を再現できないことがある

## 決めたこと

- 専用のワークフローは作らず、振り分け用のワークフローを `workflow_run` でも起動する。CI の失敗の検知は、PR の番号を指定して振り分けをやり直し、修正の依頼が、差し戻しとコンフリクトとあわせて、今の head に対する理由を集める
- 対象にする CI は `Test` だけにする。commitlint の失敗は、エージェントのファイルの変更では直せないため
- Merge Queue で外された PR は、`head_branch` から番号を読み、レビュー担当の Approve、Merge Queue のイベント、`beforeCommit` の実行と突き合わせて確かめる
- PR の CI は、進行役の App のトークンで一度だけ再実行する。そのため、進行役の App に Actions の書き込み権限を足し、再実行するときだけ、その権限を含むトークンを発行する
- Merge Queue の CI の失敗では、再実行もキューへの入れ直しもせず、すぐに修正を依頼する
- CI の失敗の修正では、コンフリクトの修正と同じく、`develop` を取り込んでからエージェントに直させ、マージのコミットとして push する
- CI の失敗で修正を依頼するのは、コードを変える段階 (プロジェクトの作成と実装タスク) の PR だけにする。文書の段階の PR は、テストの対象のコードを変えないため、CI が失敗しても原因は PR の外にあり、エージェントには直せない

## 検討した案

| 案 | 採らなかった理由 |
| --- | --- |
| 専用のワークフロー (`coding-agent-ci-failure.yml`) で受ける | 仕組みの停止、設定の読み込み、PR ごとの `concurrency` を作り直すことになる |
| `pull_request_target` の `dequeued` で Merge Queue から外されたことを知る | 外された理由の値が公開されておらず、CI の失敗かどうかを判定できない。ログを渡すにも、Merge Queue の CI の実行を探す必要がある |
| PR の CI を GITHUB_TOKEN で再実行する | 再実行が終わったときに `workflow_run` が起き、修正を依頼できるかを、公式のドキュメントで確認できない |
| Merge Queue で外された PR を、一度だけキューに入れ直す (進行役の App で) | 進行役の App に Contents の書き込み権限が要り、振り分けのたびに発行するトークンでできることが大きく広がる |
| Merge Queue で外された PR を、一度だけキューに入れ直す (レビュー担当の App で) | 振り分け用のワークフローから、レビュー担当のワークフローを呼び出す流れを新しく作る必要がある |
| `develop` を取り込まずに、ログだけを渡して直させる | エージェントの手元では、`develop` やほかの PR と組み合わさった失敗を再現できないことがある |

## 影響

- 進行役の App の権限に Actions の書き込みが加わる。利用するリポジトリでは、取り込む前に権限を足して承認する (仕様の 15.1)
- Merge Queue での失敗が不安定なテストによるものでも、修正のエージェントと再レビューが 1 回ずつ動き、修正の回数 (仕様の 9.4) に数える
- `develop` に新しいコミットが無く、エージェントも直すところを見つけられなかったときの扱いは、作りながら決める
