# Coding Agent のセットアップ手順

このテンプレートから作ったリポジトリで、Coding Agent による開発フロー (README の「開発フロー」) を動かすための手順です。仕組みの詳しい仕様は [specification.md](specification.md) にあります。

テンプレート自体では仕組みは動きません。Variables の `CODING_AGENT_ENABLED` を `true` にしたリポジトリだけで動きます。

## 0. 前提

- GitHub の Organization を使う。リポジトリは、Organization が所有する **public** リポジトリにする (Merge Queue を使うため)
- 作業する人は、Organization のオーナーか、リポジトリの管理者であること (ルールセットや Secrets を設定するため)
- 手元に、次のものを用意する
  - [GitHub CLI](https://cli.github.com/) (`gh`)。`gh auth login` でログインしておく
  - Node.js 22 以降
- 使うエージェントの API キー (Claude は Anthropic、Codex は OpenAI)

## 1. リポジトリを作る

1. テンプレートのリポジトリで「Use this template」を選び、Organization の下に **public** で作る
2. 作ったリポジトリを手元に clone する

```bash
gh repo clone <owner>/<name>
```

## 2. GitHub App を作る

GitHub App を 3 つ作ります。進行役 (coordinator) と、エージェントごとに 1 つずつ (Claude 用、Codex 用) です。エージェントの App を分けるのは、PR を作った App は自分の PR を Approve できないためです。

Organization の「Settings」→「Developer settings」→「GitHub Apps」→「New GitHub App」で、App ごとに次のように作ります。

- 「Webhook」の「Active」は外す (使わないため)
- 「Where can this GitHub App be installed?」は「Only on this account」にする
- 「Repository permissions」は、次の表のとおりにする。ほかの権限は付けない

| App | Contents | Issues | Pull requests |
| --- | --- | --- | --- |
| 進行役 | Read-only | Read and write | Read and write |
| Claude 用 | Read and write | Read and write | Read and write |
| Codex 用 | Read and write | Read and write | Read and write |

- **Workflows の権限は、どの App にも付けない**。エージェントが `.github/workflows/` を書き換えられないようにするため
- 作ったら、App の設定の画面で、次の 2 つを控える
  - **Client ID** (`Iv23li...` の形)
  - **Bot 名**。App の名前 (slug) に `[bot]` を付けたもの (例: App の名前が `my-claude` なら `my-claude[bot]`)
- 「Private keys」→「Generate a private key」で秘密鍵 (`.pem`) を作り、ダウンロードしておく
- 「Install App」で、Organization にインストールする。「Only select repositories」で、1 で作ったリポジトリを選ぶ

権限を後から変えた場合は、Organization にインストールした App の画面で、新しい権限を承認する必要があります。

## 3. Secrets を登録する

Organization の「Settings」→「Secrets and variables」→「Actions」で、次の Secrets を登録します。「Repository access」で、1 で作ったリポジトリを選びます。名前はワークフローに書いてあるため、このとおりにしてください。

| 名前 | 値 |
| --- | --- |
| `CODING_AGENT_COORDINATOR_PRIVATE_KEY` | 進行役の App の秘密鍵 (`.pem` の中身をそのまま) |
| `CODING_AGENT_CLAUDE_PRIVATE_KEY` | Claude 用の App の秘密鍵 |
| `CODING_AGENT_CODEX_PRIVATE_KEY` | Codex 用の App の秘密鍵 |
| `ANTHROPIC_API_KEY` | Anthropic の API キー (Claude をサブスクで動かす場合は不要) |
| `OPENAI_API_KEY` | OpenAI の API キー |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude のサブスクの OAuth のトークン (Claude をサブスクで動かす場合だけ。次を参照) |

### Claude をサブスクで動かす場合

Claude は、API キーの代わりに、Claude の Pro や Max などのサブスクで動かせます。`CLAUDE_CODE_OAUTH_TOKEN` を登録すると、`ANTHROPIC_API_KEY` があってもサブスクが使われます。どちらで動いたかは、Claude のジョブのログの「認証の方式を確かめる」に出ます。

1. 手元の端末で `claude setup-token` を実行し、ブラウザーで承認する。表示されたトークン (有効期限は 1 年) を `CLAUDE_CODE_OAUTH_TOKEN` として登録する
2. claude.ai の設定で、使用量の枠を超えた分を支払う「追加の使用量 (extra usage)」が無効になっていることを確かめる。トークンが漏れたときに、金額の被害が出ないようにするため
3. 有効期限が切れる前に、同じ手順で作り直して登録し直す

次の点に気を付けてください。

- 使用量の枠は、対話で使う Claude Code や claude.ai と共有します。エージェントが動いている間は、対話で使える量が減ります。枠の上限に達すると、Claude のジョブが失敗します。枠が回復してから、失敗したジョブを再実行してください
- トークンは、作った人のサブスクにひも付きます。Organization の Secrets で複数のリポジトリと共有すると、すべてのリポジトリがその人の枠を使います
- トークンも API キーと同じく、エージェントが実行するコマンドから読める状態です (仕様の 6.3)。トークンでできるのはモデルへのリクエストだけですが、漏れた疑いがあれば、トークンを失効させて作り直してください

### API キーについての注意

- 実装タスクでは、エージェントがビルドやテストのコマンドを実行します。**API キーは、エージェントが実行するコマンドから読める**状態です (仕様の 6.3)
- そのため、この仕組みには**専用の API キー**を作り、**使える金額に上限を設けて**ください。漏れたときの被害を、上限の金額までに抑えるためです
- 上限や自動のチャージ (Auto Renewal など) の設定が、意図せず外れていることがあります。上限が外れていないか、クレジットが残っているかを、ときどき確かめてください。クレジットが無くなると、エージェントのワークフローが `Quota exceeded` などで失敗します

## 4. `agents.json` とプロジェクトの背景を書く

[agents.json](agents.json) に、2 で作った GitHub App の情報を書きます。

| 項目 | 書くもの |
| --- | --- |
| `coordinator.bot`、`coordinator.appClientId` | 進行役の App の Bot 名と Client ID |
| `agents.<識別子>.bot`、`agents.<識別子>.appClientId` | エージェントの App の Bot 名と Client ID |

エージェントが担当する Issue には、担当のエージェントを表すラベル `agent:<識別子>` (例: `agent:claude`) が付きます。ラベルは、初めて付けるときに自動で作られるため、用意は要りません。識別子は 44 文字以内にしてください。

`roles` には、段階ごとに、担当のエージェントと、使うモデルと effort が書いてあります。テンプレートの値のままでも動きます。変えるときは、次の点に気を付けてください。

- 段階ごとに、作成担当とレビュー担当は**別のエージェント**にする (PR を作った App は、自分の PR を Approve できないため)
- `model` と `effort` を省略するか `null` にすると、エージェントのツールの既定を使う。指定できる値は、エージェントのツールとモデルによる
- エージェントごとの `fix` は、そのエージェントが作った PR を修正するときのモデルと effort
- Codex によるコードを変える段階 (プロジェクトの作成と実装タスク) には、まだ対応していない。`roles.project.author` と `roles.implementation.implementers` には Claude を指定する

書き終えたら、設定の形式と関係を確かめます。

```bash
npm ci --ignore-scripts
```

```bash
npm test
```

### プロジェクトの背景を書く

[`docs/project.md`](../../docs/project.md) に、プロジェクトの背景を書きます。エージェントは、これを材料に「どこまで作り込むか」(受け入れ基準の量、設計の作り込みなど) を判断します (仕様の 6.6)。

- 見出し (目的と背景、規模、方針、そのほかの制約) ごとに、書き方の説明がコメントで入っています。コメントはエージェントに渡されないため、残したままでかまいません
- 特に「方針」には、C (費用)、Q (品質)、D (納期) の優先順位と、品質の水準 (試作、MVP、本番の運用など) を書いてください。規模の数字だけでは、エージェントの判断が揺らぎやすくなります
- 書かずに進めることもできます。その場合、エージェントは機能の親 Issue と要件定義書の記述だけで判断します

確かめたら、`agents.json` と `docs/project.md` を `main` にコミットして push します。次の 5 でルールセットを設定すると、`develop` には PR を通さないと変更を入れられなくなるため、この時点で入れておきます。

## 5. セットアップのスクリプトを実行する

手元で、セットアップのスクリプトを実行します。次のことを行います。何度実行しても同じ状態になります。

- `main` から `develop` を作り、既定のブランチにする
- リポジトリの設定 (自動マージ、squash のコミットメッセージを PR のタイトルだけにする、マージしたブランチの削除)
- ラベルの作成 (`feature`、`stage:*`、`needs-human`)
- `develop` と `main` のルールセット (PR と承認の必須、Merge Queue、`main` を更新できる人の制限)

まず `--dry-run` で、変更の内容を確かめます。

```bash
node .github/scripts/coding-agent/setup-repository.mjs --repo <owner>/<name> --dry-run
```

問題が無ければ、`--dry-run` を外して実行します。

```bash
node .github/scripts/coding-agent/setup-repository.mjs --repo <owner>/<name>
```

| オプション | 内容 |
| --- | --- |
| `--required-check <名前>` | `develop` で必須にするステータスチェック。複数指定できる。省略すると `commitlint` と、アプリケーションの CI の `test` を必須にする |
| `--main-bypass-team <slug>` | `main` を更新できる Team。複数指定できる。Organization のオーナーは、指定しなくても PR を通して更新できる |

## 6. Variables を設定する

リポジトリの「Settings」→「Secrets and variables」→「Actions」→「Variables」で、次の値を設定します。`CODING_AGENT_ENABLED` を設定した時点で、仕組みが動き始めます。

| 名前 | 値 | 既定値 |
| --- | --- | --- |
| `CODING_AGENT_ENABLED` | `true` (必須) | (未設定のあいだは、どのワークフローも何もしない) |
| `REVIEW_MAX_FIX_ROUNDS` | エージェントが 1 つの PR を修正する回数の上限 | 3 |
| `PLANNER_MAX_TASKS` | 1 回の実装計画で作成できる実装タスクの上限 | 30 |
| `TEST_MAX_FIX_ATTEMPTS` | テストの機械的な実行で失敗したときに、エージェントに直させる回数の上限 (最大 3) | 2 |

## 7. 動作を確かめる

1. Issue の「New issue」で「新規機能」のフォームを選び、機能の親 Issue を作る。機能名は、英小文字・数字とハイフンにする
2. 数十秒で、要件定義・仕様書・概念モデル・アーキテクチャ設計・プロジェクトの作成・実装計画の段階の Issue が、Sub Issue として作られることを確かめる。要件定義の Issue にはあなたが Assign され、ほかの段階の Issue には担当のエージェントのラベル (`agent:claude` など) が付く
3. 要件定義の Issue に従って、要件定義書 (`docs/features/<番号>-<機能名>/requirements.md`) を書き、その Issue を Close する PR (本文に `Closes #<番号>`) を作る。Ready for review にすると、レビュー担当のレビューが始まる

最初は、範囲の小さい機能で試すことをおすすめします。要件定義書の PR を Ready for review にした後は、実装まで自動で進み、API の料金がかかります。

## 運用

### 人が対応すること

- 要件定義書を書き、レビューの指摘を直す
- 修正の回数が上限に達して、`needs-human` ラベルが付いた PR に対応する。対応したら `needs-human` ラベルを外すと、改めてレビューされる
- テストの機械的な実行で、決めた回数まで直させてもテストが通らず、`needs-human` ラベルが付いた Issue や PR に対応する。原因を直したら、PR はラベルを外す (改めてレビューされる)。Issue はラベルを外し、「振り分けをやり直す」の手順で `force` を付けて手動実行する
- 実装計画で、担当が人になった実装タスクに対応して、Issue を Close する
- `develop` から `main` へマージする

### 振り分けをやり直す

段階や実装タスクを起動し直すときや、PR の修正を依頼し直すときは、振り分け用のワークフローを、Issue か PR の番号を指定して手動実行します。起動済みや依頼済みのものをやり直すときは、`force` を付けます。

```bash
gh workflow run coding-agent-router.yml -R <owner>/<name> -f issue-number=<番号> -f force=true
```

レビューをやり直すときは、PR を一度 Close して Reopen します。

### `develop` の設定ファイルを変えるとき

`agents.json` や `docs/project.md` などを変えるときは、`develop` に向けた PR を作ります。`develop` のルールセットは承認を必須にしていて、段階の Issue に紐づかない PR はエージェントがレビューしないため、**ほかの人の承認**が要ります。1 人で運用している場合は、リポジトリの管理者が、ルールセットを一時的に無効にしてマージし、必ず有効に戻してください。

### エージェントを止める

すべてを止めるときは、Variables の `CODING_AGENT_ENABLED` を `true` 以外にします。段階や実装タスクの一部だけを止めるときは、まだ起動していない Issue から、担当のエージェントのラベル (`agent:<識別子>`) を外します。ラベルを付け直すと、依存先が解決していれば起動します。

### 仕組みが止まったとき

`develop` が PR を通さずに変更されると (ルールセットを外して直接 push したなど)、仕組みが自動で止まります。成果物やアプリケーションのコードが消えたり書き換わったりしていると、エージェントがそれに気づかずに作業を続けてしまうためです。仕組みのファイル (`.github/coding-agent/` や `.github/scripts/coding-agent/` など) だけの変更では止まりません。

止まると、`halted` ラベルの付いた Issue (停止中の Issue) が作られます。この Issue が Open の間は、段階の起動、レビュー、修正の依頼などが行われません。処理されなかったイベントは、この Issue にコメントで残ります。

1. 停止中の Issue に書かれたコミットと変わったファイルを確かめ、必要なら `develop` を直す (消えたファイルを PR で戻すなど)
2. 停止中の Issue を Close する
3. コメントに残ったイベントの Issue や PR について、「振り分けをやり直す」の手順で振り分けを手動実行する
