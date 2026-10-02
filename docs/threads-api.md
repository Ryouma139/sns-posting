# Threads API の連携

Meta for Developers で Threads API のアプリを作り、このダッシュボードから Threads に投稿できるようにした手順と仕組みのまとめ。

- 本番 URL: **https://sns-posting.tryoma0227.workers.dev**
- デプロイ全体の流れは [cloudflare-deploy.md](cloudflare-deploy.md)、ログイン認証は [cloudflare-access.md](cloudflare-access.md) を参照。

## 1. Meta for Developers でアプリを作る

### 1-1. 用語

| 用語 | 意味 |
|---|---|
| ユースケース | アプリで**何をしたいか**(目的)。選んだユースケースで、使える API・権限・設定項目が決まる。今回は「**Threads API にアクセス**」 |
| ビジネスポートフォリオ | Meta ビジネススイートの設定画面(ユーザー、ページ、Instagram アカウントなど)。**Threads API の設定はここではない** |
| Threads テスター | 開発モードのアプリを使えるアカウント。テスター以外は連携できない |

#### Meta for Developers とビジネスポートフォリオの違い

| | Meta for Developers | Meta ビジネスポートフォリオ |
|---|---|---|
| 目的 | **API を使うアプリを作って管理する**(開発者向け) | **ビジネスのアカウントや資産をまとめて管理する**(事業者向け) |
| URL | developers.facebook.com | business.facebook.com(Meta ビジネススイートの「設定」) |
| 管理するもの | アプリ、ユースケース、権限、アプリ ID・シークレット、コールバック URL、テスター、アプリレビュー | Facebook ページ、Instagram アカウント、広告アカウント、WhatsApp、メンバーと権限、ビジネス認証 |
| このプロジェクト | アプリ「thread_API」 | 「regenelation_ryoumen」 |

```text
Meta ビジネスポートフォリオ(会社・事業の入れ物)
 ├ Facebook ページ、Instagram アカウント、広告アカウントなど
 ├ メンバー(誰が何を操作できるか)
 └ (任意)Meta for Developers のアプリをひもづけられる
          └ アプリ「thread_API」
               ├ ユースケース(Threads API など)
               ├ 権限
               └ テスター
```

- アプリをポートフォリオにひもづけるかは**任意**。ひもづけなくてもアプリは作れて使える。
- **Threads の連携に必要な作業は、すべて Meta for Developers 側**(ユースケース、権限、コールバック URL、テスター)。Threads アカウントはポートフォリオの管理対象ではないため、ポートフォリオの設定は今回の連携に関係しない。
- ポートフォリオが必要になるのは、アプリ公開時に**ビジネス認証**を求められたとき、Instagram API や Facebook ページなどビジネスアカウント前提の API を使うとき、複数人でアカウントや権限を管理するとき。

### 1-2. 最初につまずいたこと: ユースケースがない

アプリ作成時に「その他」→ アプリタイプ(「ビジネス」など)を選ぶと、**旧形式のアプリ**になる。左メニューが「ユースケース」ではなく「製品」になり、**Threads API を後から追加できない**。

→ Threads 用のアプリを**新しく作り直した**(古いアプリは削除しなくてよい)。

### 1-3. 手順

1. https://developers.facebook.com/apps → 「**アプリを作成**」
2. アプリ名・連絡先メールを入力
3. ユースケースで「**Threads API にアクセス**」(Access the Threads API)を選ぶ。**「その他」は選ばない**
4. ビジネスは「まだ接続しない」で問題ない
5. 「アプリを作成」

### 1-4. 権限(アクセス許可)を追加する

ユースケース「Threads API にアクセス」→「カスタマイズ」→ 権限で「**追加**」を押す。

| 権限 | 用途 | 使う箇所 | 必要か |
|---|---|---|---|
| `threads_basic` | プロフィール・自分の投稿一覧の取得 | [worker/index.js](../worker/index.js) `threadsCallback` / `threadsGetPosts` | 必須(最初から入っている) |
| `threads_content_publish` | **投稿** | `threadsCreatePost` | 必須 |
| `threads_manage_insights` | いいね・返信・表示回数などの取得 | `loadThreadsMetrics` | 必須 |
| `threads_delete`、`threads_keyword_search`、`threads_location_tagging` など | 削除・検索・位置情報 | 使っていない | 不要 |

- ステータスの「**テスト準備完了**」= 開発モードで、**テスターなら使える**状態。自分で使う分には審査なしで投稿できる。
- 「API 呼び出し」の数は反映に数時間〜1日かかる。0 のままでも問題ない。

### 1-5. コールバック URL を登録する

ユースケース →「設定」の「**リダイレクトコールバック URL**」に、次の2つを登録して保存する。

```text
https://localhost:5173/api/threads/callback
https://sns-posting.tryoma0227.workers.dev/api/threads/callback
```

- 1行目はローカル開発用(`.env` の `THREADS_REDIRECT_URI` と同じ)、2行目は本番用。
- **完全一致**が必要。`https` やパスが1文字でも違うと `threads_error=oauth` になる。
- 「アンインストール」「削除」のコールバック URL も必須入力。このアプリには処理がないため、仮に `https://sns-posting.tryoma0227.workers.dev/` を入れた。

### 1-6. Threads アプリ ID とシークレット

同じ「設定」画面にある **Threads アプリ ID** と **Threads アプリシークレット** を使う。

| 名前 | 場所 | 使うか |
|---|---|---|
| アプリ ID / アプリシークレット | ダッシュボード上部、「アプリの設定」→「ベーシック」 | ❌ 使わない |
| **Threads アプリ ID** | ユースケース →「設定」 | ✅ `THREADS_APP_ID` |
| **Threads アプリシークレット** | ユースケース →「設定」 | ✅ `THREADS_APP_SECRET` |

`threads.net` / `graph.threads.net` は Threads 用の ID しか受け付けない。通常のアプリ ID を入れると連携に失敗する。

ローカルの `.env`(Git には上げない):

```text
THREADS_APP_ID=(Threads アプリ ID、16桁の数字)
THREADS_APP_SECRET=(Threads アプリシークレット、32文字の英数字)
THREADS_REDIRECT_URI=https://localhost:5173/api/threads/callback
```

`.env` を変えたら `npm run dev` を Ctrl+C で止めて起動し直す。

### 1-7. Threads テスターを追加して承認する

**これをしないと連携できない。**

1. Meta for Developers:「アプリの役割」→「役割」→「メンバーを追加」→「**Threads テスター**」→ Threads のユーザー名を入力
2. Threads 側: 追加したアカウントで threads.net にログイン →「設定 → アカウント → **ウェブサイトのアクセス許可 → 招待**」→「**承認**」(スマホアプリでも同じ場所)
3. 「役割」の一覧で「承認待ち」が消えていれば完了

#### 複数アカウントを使う場合

- 「メンバーを追加」で複数アカウントを**まとめて追加はできる**が、Meta 上は**アカウントごとに別のテスター**になる。
- **承認もアカウントごとに必要**。招待は追加されたアカウント本人にしか届かない。
- 承認していないアカウントで連携すると、次のエラーになる。

  ```json
  {"error_message":"Invalid Request: The user has not accepted the invite to test the app.","error_code":1349245}
  ```

- 複数追加できるのは、チーム開発・テスト用アカウント・審査前の確認などを想定しているため。使うアカウントが1つならテスターも1つでよい。

## 2. アプリ内での連携

### 2-1. 手順

1. threads.net で、テスター承認済みのアカウントにログインしておく
2. アプリで Threads を選び「**連携**」→ Threads の許可画面で「**許可する**」
3. 戻ってきた URL で結果を確認する

| 戻った URL | 意味 |
|---|---|
| `/?threads_connected=1` | ✅ 成功 |
| `/?threads_error=config` | `THREADS_APP_ID` / `THREADS_APP_SECRET` が読み込めていない(再起動したか、本番なら Secret があるか) |
| `/?threads_error=oauth` | Meta 側で拒否。コールバック URL・アプリ ID・テスター承認のどれか |
| `/?threads_error=callback` | 認可は通ったがトークン取得に失敗。シークレットの間違いが多い |

状態は `/api/threads/status` でも確認できる。`"connected": true` とユーザー名が返れば連携済み。

### 2-2. 注意

- **権限を Meta 側で追加したあとは、連携し直す**(連携解除 → 連携)。権限は連携したときのトークンに入るため、古いトークンには新しい権限がない。
- **同時に連携できる Threads アカウントは1つ**(`session.data.threads` に1件だけ保存)。切り替えは「連携解除」→ threads.net のログインアカウントを切り替え →「連携」。ブラウザやシークレットウィンドウを分ければ、それぞれ別のアカウントを連携できる。

## 3. Threads API の呼び出され方と渡され方

### 3-1. どこで呼んでいるか

画面([src/App.jsx](../src/App.jsx))は自分の Worker の `/api/threads/...` を呼ぶだけで、Meta とは直接やりとりしない。シークレットとトークンをブラウザに渡さないため。

```text
画面(App.jsx) → /api/threads/posts → Worker(worker/index.js) → graph.threads.net(Meta)
```

### 3-2. アプリとアカウントのひもづけ(OAuth)

```text
① 連携ボタン(/api/threads/connect)
   ↓ client_id=THREADS_APP_ID、scope=threads_basic,threads_content_publish,threads_manage_insights を付けて
     threads.net/oauth/authorize へリダイレクト
② Threads の許可画面で「許可する」
   ↓ /api/threads/callback に code が返る
③ code + THREADS_APP_ID + THREADS_APP_SECRET を送ってアクセストークンを受け取る
   ↓ 短期トークン(約1時間)を長期トークン(約60日)に交換
④ トークンを KV のセッションに保存
⑤ 以降の API 呼び出しは、すべてこのトークンを付けて送る
```

| 処理 | 関数([worker/index.js](../worker/index.js)) |
|---|---|
| ① 許可画面へ | `threadsConnect` |
| ③ トークン取得・長期トークンへの交換・プロフィール取得 | `threadsCallback` |
| API 呼び出し共通(`access_token` を付ける) | `threadsFetch` |
| 投稿一覧 | `threadsGetPosts` |
| いいね数など | `loadThreadsMetrics` |
| 投稿(コンテナ作成 → 公開の2段階) | `threadsCreatePost` |

### 3-3. Meta が投稿を受け付ける条件

アプリのコードは「投稿して」と送るだけで、**許可するかは Meta がリクエストごとにトークンを見て判断する**。

```text
POST https://graph.threads.net/v1.0/me/threads?media_type=TEXT&text=...&access_token=XXXX
POST https://graph.threads.net/v1.0/me/threads_publish?creation_id=...&access_token=XXXX
```

| チェック | 判断材料 |
|---|---|
| ① どのアプリからか | トークンを発行したアプリ(THREADS_APP_ID) |
| ② どのアカウント宛てか | 連携時に許可したアカウント。URL の `me` はこのアカウント |
| ③ トークンが有効か | 期限切れ・取り消しでないか(長期トークンは約60日) |
| ④ 必要な権限がトークンにあるか | 連携時に許可した scope |
| ⑤ アプリでその権限が使えるか | 開発モードなら「テスト準備完了」かつテスター承認済み。ライブなら審査済み |

必要な権限は **URL と HTTP メソッドの組み合わせ**で Meta の仕様として決まっている(コードには書いていない)。

| リクエスト | 必要な権限 |
|---|---|
| `GET /me`、`GET /me/threads` | `threads_basic` |
| `POST /me/threads`、`POST /me/threads_publish` | `threads_content_publish` |
| `GET /{投稿ID}/insights` | `threads_manage_insights` |

どれかで弾かれると Meta はエラーを返し、Worker が「Threads への投稿に失敗しました。」などを画面に返す。

## 4. 開発モードとライブモードの違い

| | 開発モード(今) | ライブモード |
|---|---|---|
| 連携できるアカウント | **テスター承認済みのみ** | 誰でも |
| 権限のステータス | テスト準備完了 | アドバンスアクセス(審査済み) |
| 必要な手続き | テスター追加と承認 | **App Review(審査)** |
| 費用 | 無料 | 無料 |

- アプリ管理画面の左メニュー「**公開: 未公開**」= 開発モード。このままで自分は投稿できる。
- **Cloudflare にデプロイしても開発モードのまま**。本番 URL からでもテスターしか連携できない。
- 本番サイトは Cloudflare Access で自分しか開けないため、**自分で使うだけならライブにする必要はない**。

### ライブにする場合(他の人にも使ってもらうとき)

1. 「アプリの設定」→「ベーシック」: アプリアイコン(1024×1024)、**プライバシーポリシー URL**、利用規約 URL、**ユーザーデータ削除**(手順ページかコールバック)、カテゴリ、連絡先
2. 「アプリレビュー」: `threads_basic`、`threads_content_publish`、`threads_manage_insights` のアドバンスアクセスを申請。権限ごとに用途の説明、**画面収録動画**(連携 → 許可 → 投稿 → Threads に表示)、テスト手順
3. 求められたらビジネスポートフォリオの**ビジネス認証**
4. 審査通過後、ダッシュボード上部の「公開」でライブに切り替え

未対応のこと: プライバシーポリシーとデータ削除のページがない。Cloudflare Access のままだと審査担当者がアプリを開けない。審査は数日〜数週間かかる。

## 5. 本番環境(Cloudflare)で必要な設定

| 場所 | 設定 | 備考 |
|---|---|---|
| Cloudflare: Workers & Pages → sns-posting → Settings → **Variables and Secrets** | `THREADS_APP_ID`、`THREADS_APP_SECRET` を **Secret** で登録 | アプリを作り直したら**新しい値に上書き**。Build の欄ではない。反映には再デプロイ(または次の push) |
| Cloudflare | `THREADS_REDIRECT_URI` は**登録しない** | アクセスされた URL から自動で組み立てる(`redirectUri()`) |
| Cloudflare | KV、Access | 設定済み。追加作業なし |
| Meta for Developers | 本番のコールバック URL を**新しいアプリ**に登録 | `https://sns-posting.tryoma0227.workers.dev/api/threads/callback` |
| Meta for Developers | テスター承認 | 本番でも必要(開発モードのため) |
| GitHub | 追加なし | `.env` は `.gitignore` で除外。push すると Workers Builds で自動デプロイ |

確認: `https://sns-posting.tryoma0227.workers.dev/api/threads/connect` を開いて threads.net の許可画面に移動すれば OK。`/?threads_error=config` なら Secret が反映されていない。

## 6. その他


無料プランは枠を超えても自動課金されず、エラーで止まる。

### API 利用状況の画面

サイドバーの「**API利用状況**」(`#usage`)で、Threads の投稿・返信の上限と直近24時間の消費数を表示する。

- Worker の `GET /api/threads/usage`(`threadsGetUsage`)が、Threads の `GET /{ユーザーID}/threads_publishing_limit?fields=quota_usage,config,reply_quota_usage,reply_config` を呼ぶ。返信の項目が取れなければ投稿の項目だけで取り直す。
- 画面を開いたとき、「最新に更新」を押したときに取得する(1回 = Threads API 1回)。
- API 呼び出し回数の上限(24時間で 4,800 × 表示回数)の残りは API から取得できないため、表示していない。
- X は Developer Portal の Usage で確認する。

### 取得件数(最新20件)

- 固定値。[src/App.jsx](../src/App.jsx) の `archiveLimit`、[worker/index.js](../worker/index.js) の Threads `limit=20` と X `max_results: '20'` の3か所。変えるときはそろえる。
- 分析画面の見出しは、実際に集計した件数を表示する(いいね数を取れなかった投稿は集計から外れるため、20件より少ないことがある)。
- Threads は投稿1件ごとに insights を1回呼ぶ。Workers 無料プランのサブリクエスト上限(1リクエスト50回)があるため、**40件程度まで**が安全。

### 予約投稿(現状)

- 予約は**ブラウザの localStorage に保存するだけ**。時刻になっても**自動では投稿しない**。「予定時刻を過ぎています」と表示され、「今すぐ投稿」を手で押す必要がある。
- 開発サーバーを止めても予約は消えないが、投稿もされない。
- localStorage は URL(オリジン)ごとに別なので、**開発(localhost:5173)で予約した内容は本番に表示されない**。別ブラウザ・スマホでも表示されない。下書きと通知も同じ。
- 予約には**予約したアカウント**(`accountId`、`accountUsername`)を保存する。予約するにはアカウントの連携が必要。
- 予約一覧は、連携中のアカウントの予約を上に、ほかのアカウントの予約を「ほかのアカウントの予約」として `@ユーザー名` 付きで下に表示する。
- 「今すぐ投稿」を押したとき、予約したアカウントと連携中のアカウントが違えば**投稿せずに警告**する。Worker 側でも `accountId` を照合し、違えば 409 を返す(`accountMismatch`)。アカウントが記録されていない古い予約は、確認ダイアログを出してから連携中のアカウントで投稿する。
- 自動投稿にするには、予約を KV に保存し、Cloudflare の **Cron Trigger**(無料プランで使える)で定期的に投稿する仕組みが必要(未実装)。
