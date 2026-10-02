# Cloudflare Access によるログイン認証

本番 URL: **https://sns-posting.tryoma0227.workers.dev**
Access のログイン画面: `https://autumn-shape-c7ac.cloudflareaccess.com`(チームドメイン)

デプロイ全体の流れは [cloudflare-deploy.md](cloudflare-deploy.md) を参照。

## 1. なぜログイン認証が必要か

アプリ自体には、ログインの仕組みがない。URL を知っていれば誰でも画面と `/api/*` を使える。

| 心配なこと | 実際 |
|---|---|
| 他人が自分の X / Threads アカウントで投稿できるか | **できない**。連携情報(トークン)はブラウザごとのセッション(Cookie `sns_session`)に分かれて KV に保存される。他人が開いても「未連携」になる |
| 他人が自分のアカウントで連携して使えるか | **できる**。その場合、X API の利用枠やクレジットは**自分の開発者アカウントから消費される** |
| ボットのアクセス | 連携していないアクセスでも KV に1回書き込む。KV の書き込みの無料枠(1日1,000回)を使い切るおそれがある([cloudflare-deploy.md](cloudflare-deploy.md) 5章) |

そこで **Cloudflare Access** で、自分のメールアドレス以外はサイトを開けないようにした。

- Worker の手前で Cloudflare が認証するので、**コードの変更は不要**。
- 認証を通らないリクエストは Worker に届かない。そのため、X API も KV も使われない。
- 無料(Zero Trust の Free プラン、50 ユーザーまで)。

## 2. 仕組み

```text
ブラウザ
  ↓ https://sns-posting.tryoma0227.workers.dev を開く
Cloudflare Access(Worker の手前)
  ├ ログインしていない → 302 で autumn-shape-c7ac.cloudflareaccess.com のログイン画面へ
  │     ↓ メールアドレスを入力 → Gmail に届いた6桁のコード(One-time PIN)を入力
  │     ↓ ポリシーに合うか判定
  │     ├ 合わない → 「That account does not have access.」
  │     └ 合う     → Cookie(CF_Authorization)を受け取り、元の URL に戻る
  └ ログイン済み(Cookie が有効) → そのまま通す
       ↓
Worker(画面の dist/ と /api/*)
```

- 保護されるのは `workers.dev` の URL 全体(画面、`/favicon.svg`、`/api/*` のすべて)。
- 一度ログインすると、**セッション期間(24時間)はログイン画面が出ない**。ログイン画面を確認したいときはシークレットウィンドウで開く。

## 3. 設定手順

### (1) Worker で Access を有効にする

**Workers & Pages → sns-posting → Settings → Domains & Routes** の `workers.dev` の行で、Cloudflare Access を有効にする(行の右端の「…」の中にある場合もある)。

有効にすると、Zero Trust に `sns-posting - Cloudflare Workers` というアプリケーションが自動で作られる。「Worker アクセスを編集」画面では次のように設定する。

| 項目 | 設定値 |
|---|---|
| スコープ | **すべてのトラフィック**(「プレビューのみ」にすると本番 URL が保護されない) |
| 認証ポリシー | (3) で作るポリシーだけを選ぶ |
| セッション期間 | 24 時間 |

### (2) ログイン方法に One-time PIN を追加する

**https://one.dash.cloudflare.com/ → Settings → Authentication → Login methods**
(版によっては **Integrations → Identity providers**)

- One-time PIN がなければ **Add new → One-time PIN** で追加する(入力する項目はない)。
- アプリケーション側(Access → Applications → `sns-posting - Cloudflare Workers` → Authentication)で、One-time PIN が使えるようになっているか確認する。「Accept all available identity providers」がオンならそのままでよい。
- ログイン画面の **Google のボタンは使わない**。Google ログインは別の設定が必要で、していないとエラーになる。

### (3) 自分だけを許可するポリシーを作る

「Worker アクセスを編集」画面の「+ ポリシーを追加」では、新しく作れる条件が**メールドメインだけ**だった。そのため、Zero Trust の画面でポリシーを作ってから、Worker の画面で選ぶ。

**https://one.dash.cloudflare.com/ → Access(または Access controls)→ Policies → Add a policy**

| 項目 | 設定値 |
|---|---|
| ポリシー名 | `tryoma0227のみ` |
| アクション | **Allow(許可)** |
| Include のセレクター | **Emails(メール)** |
| Include の値 | 自分の Gmail アドレス(アドレス全体) |
| Require / Exclude | 空のまま |

作ったあと、「Worker アクセスを編集」画面の「+ ポリシーを追加」の ▼ から選び、**変更を保存**する。

## 4. ポリシーの注意点

### 「Email domain」では自分だけを許可できない

メールアドレスは `@` の前(個人)と後ろ(ドメイン)に分かれる。**Email domain は `@` の後ろしか見ない**。

```text
tryoma0227 @ gmail.com
└ 個人の部分 ┘   └ ドメイン ┘
```

| セレクター | 値 | 結果 |
|---|---|---|
| Email domain | `tryoma0227@gmail.com` | ドメインが `gmail.com` と一致しないので、**自分も拒否される**(最初にこの設定になっていた) |
| Email domain | `gmail.com` | **Gmail の人なら誰でも通れる**(危険) |
| **Emails** | `tryoma0227@gmail.com` | **自分だけ通れる**(正しい設定) |

### 許可のポリシーは「どれか1つに合えば通れる」

アプリケーションに許可のポリシーが複数付いていると、**どれか1つに合えば通れる**。条件が絞り込まれるわけではない。`Email domain: gmail.com` が残っていると、`Emails` のポリシーを足しても Gmail の人全員が通れてしまう。**認証ポリシーの欄には `tryoma0227のみ` だけを置く**。

### グローバルポリシーと Worker ポリシー

| | グローバルポリシー | Worker ポリシー |
|---|---|---|
| 作る場所 | Zero Trust の **Policies** 画面 | Worker の「**Worker アクセスを編集**」画面 |
| 使える範囲 | いくつものアプリで使い回せる | その Worker だけ |
| 変更の影響 | 使っているすべてのアプリに反映される | その Worker にだけ反映される |
| 条件の種類 | Emails、Email domain、Everyone など多数 | メールドメインのみ(今の画面では) |

Worker が1つだけなら、どちらでも保護の強さは同じ。今回は条件を Emails にするため、グローバルポリシーを使った。

### ポリシーが1つもないと誰も入れない

ポリシーのないアプリケーションは、誰も許可されていない状態になる。ログインは成功しても「That account does not have access.」になる。

## 5. テスト方法

**シークレットウィンドウ**(スマホならプライベートモード)で本番 URL を開く。

| 操作 | 期待される結果 |
|---|---|
| URL を開く | Cloudflare Access のログイン画面が出る |
| 自分の Gmail アドレス → Send me a code → 届いたコードを入力 | アプリが開く |
| **別の Gmail アドレス**でログインする | 「That account does not have access.」(これが正常) |

- コードの差出人は `noreply@notify.cloudflare.com`。届かなければ迷惑メールフォルダを確認する。
- 別のアドレスで弾かれることも必ず確認する。これで Email domain のポリシーが残っていないことを確かめられる。

ログインしていない状態の応答は、コマンドでも確認できる。

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://sns-posting.tryoma0227.workers.dev/
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://sns-posting.tryoma0227.workers.dev/api/x/status
# 302 https://autumn-shape-c7ac.cloudflareaccess.com/cdn-cgi/access/login/... なら保護されている
# 200 なら Access が効いていない(誰でも使える状態)
```

## 6. 起きたこととその原因

| 症状 | 原因 | 対処 |
|---|---|---|
| Access を設定したのに、外から開くと 200 が返りアプリが使えた | Access のアプリケーションが本番 URL に適用されていなかった | Worker の Domains & Routes から Access を有効にする |
| 「That account does not have access.」(自分のアドレスで) | ポリシーが1つもなかった / 条件が Email domain で値がアドレス全体だった | Emails のポリシーを作って付ける(4章) |
| 「Worker アクセスを編集」でメールドメインしか選べない | Worker の画面の簡易作成では、メールドメインしか作れない | Zero Trust の Policies 画面で作ってから選ぶ(3章 (3)) |
| ポリシーを直したら、ログイン画面が出ずにアプリが開いた | 前のログインの Cookie(24時間有効)が残っていた | 正常。確認はシークレットウィンドウで行う |
| スマホで Google のボタンからログインするとエラー | Google ログイン(ID プロバイダー)を設定していない | メールアドレスを入力する One-time PIN でログインする |
| ログイン後に `Internal server error: could not load static asset` | Cloudflare 側で画面のファイルを返す段階のエラー。原因は未確定 | シークレットウィンドウでログインし直す。直らなければ Deployments で再デプロイする |
| 設定の途中で Cloudflare の「Select account(s)」画面が一瞬出た | 外部のアプリやツールが Cloudflare アカウントの操作権限を求める画面(OAuth) | 自分で始めた覚えがなければ許可しない |

## 7. そのほかの守り方

Access だけで他人は使えなくなる。念のため、次の方法も組み合わせられる。

| 方法 | 内容 | 状態 |
|---|---|---|
| 連携できるアカウントをコードで制限する | `xCallback` / `threadsCallback` で、ユーザー ID が Secret の許可リストになければトークンを保存しない | 未実装 |
| X の利用上限 | X Developer Portal で支払い上限を設定できるか確認する | 未確認 |
| Threads の開発モード | Meta のアプリを審査に出さなければ、テスターに登録した人しか連携できない | 開発モードのまま |
| 使わない期間は workers.dev を無効にする | 誰もアクセスできなくなる。`wrangler.jsonc` に `"workers_dev": false` と `"preview_urls": false` を書かないと、次の `git push` の自動デプロイで有効に戻る | 必要なときに行う |
