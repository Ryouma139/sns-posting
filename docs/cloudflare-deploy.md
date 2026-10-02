# Cloudflare Workers へのデプロイまとめ

本番 URL: **https://sns-posting.tryoma0227.workers.dev**
GitHub: https://github.com/Ryouma139/sns-posting (非公開)

## 1. デプロイ先に Cloudflare を選んだ理由

Express 版(`server.js`)の頃は、本番環境に出すために次の課題があった([作業まとめ.md](../作業まとめ.md) の「今の作りの弱点」、[roadmap-database.md](roadmap-database.md) のフェーズ3)。

| 課題(Express 版) | Cloudflare Workers での解決 |
|---|---|
| HTTPS の証明書を用意する必要がある(VM + Caddy + Let's Encrypt の予定だった) | `*.workers.dev` は最初から HTTPS。証明書の発行・更新は不要 |
| `server.js` は証明書がないと起動しない。本番用の切り替えが必要 | Worker は HTTP/HTTPS を意識しない。コードの切り替えは不要 |
| アクセストークンをサーバーのメモリに保存しており、再起動やデプロイで連携が切れる | セッションを **KV(`SESSIONS`)** に保存する。デプロイしても連携が切れない |
| 画面(`dist/`)と API を別々に配信するか、Express から配信する作りに変える必要がある | `assets` で `dist/` を配信し、`/api/*` だけを Worker で処理する。**1つの URL** にまとまる |
| VM の作成、OS の更新、バックアップなどの運用が必要 | サーバーの管理が不要。無料枠で個人利用には十分 |
| デプロイ作業を手でやる必要がある | GitHub に push するだけで自動デプロイされる(4章) |

OAuth のコールバックは HTTPS が前提のため、「HTTPS を自分で用意しなくてよい」ことが特に大きい。

## 2. ポート番号の変更と、競合によるエラー

### ポートの変更

| | Express 版(以前) | Workers 版(今) |
|---|---|---|
| 画面(Vite) | `https://localhost:5173` | `https://localhost:5173`(変更なし) |
| API | `server.js`(Express)`https://localhost:3000` | `wrangler dev`(Worker)`http://127.0.0.1:8787` |
| `/api` の転送先 | `https://localhost:3000`(`secure: false` が必要だった) | `http://localhost:8787`([vite.config.js](../vite.config.js)) |
| 起動コマンド | `node server.js` と `vite` | `wrangler dev --port 8787` と `vite`(`npm run dev` で同時に起動) |
| 本番 | ― | ポート指定なし(`https://sns-posting.tryoma0227.workers.dev` の 443) |

- ブラウザで開くのは今も **`https://localhost:5173/`** だけ。8787 を直接開く必要はない。
- `.env` に `PORT=3000` が残っているが、Worker では使っていない。

### 起きたエラーと原因

#### (1) `Missing entry-point to Worker script or to assets directory`

- **原因**: GitHub から取り込んだコードに `wrangler.jsonc` と `worker/index.js` がなかった。`Product` リポジトリのルートの `.gitignore` に `SNS_posting/` が書かれていたため、後から作ったファイルが一度も push されていなかった。
- 同時に出た `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` は、wrangler が異常終了したときに Windows で出るもので、原因ではない。
- **対処**: 元のフォルダ(`C:\Users\tryom\Code_dev\Product\SNS_posting`)から `worker/` と `wrangler.jsonc` をコピーした。

#### (2) `Cannot read file ... The process cannot access the file because it is being used by another process`

- **原因**: wrangler がファイルを読む瞬間に、ウイルス対策(Windows Defender)や VS Code のファイル監視が同じファイルを開いていた。
- 直後に `Local server updated and ready` と出て自動で回復したため、対処は不要。何度も出る場合は、プロジェクトのフォルダを Defender の除外に追加するか、`.wrangler` フォルダを消して起動し直す。

#### (3) 連携ボタンを押すと読み込みが終わらない(ポートの競合)

- **原因**: `Product\SNS_posting` で以前に起動した `wrangler dev` が止まらずに残っており、**2つの wrangler が同じ 8787 で待ち受けていた**。Windows では両方の待ち受けが成功してしまい、リクエストが古いほうに届いて応答が返らなくなっていた。

  ```text
  127.0.0.1:8787  LISTENING  21140  ← Product\SNS_posting の古い workerd(13:16 起動)
  127.0.0.1:8787  LISTENING  15872  ← SNS_Posting の workerd(13:43 起動)
  ```

- **調べ方**(PowerShell):

  ```powershell
  netstat -ano | findstr ":8787"                                   # 8787 を使っているプロセス ID
  Get-CimInstance Win32_Process -Filter "ProcessId=21140" | Select-Object CommandLine   # どのフォルダのものか
  ```

- **対処**: 古い wrangler(親の node と子の workerd)を止め、`npm run dev` を起動し直した。

  ```powershell
  Stop-Process -Id 28020,21140
  ```

- **再発防止**: `npm run dev` は1つのフォルダ(`SNS_Posting`)だけで起動する。ターミナルを閉じる前に Ctrl+C で止める。

## 3. デプロイにあたり設定・修正した箇所

### コード

- **コードの修正は不要だった。** [worker/index.js](../worker/index.js) の `redirectUri()` は、`X_REDIRECT_URI` がなければ、アクセスされた URL から `/api/x/callback` を自動で組み立てる。そのため、本番でもローカルでも同じコードで動く。
- **`.gitignore` に追加した**(GitHub に上げないため): `ca.key`、`ca.crt`、`*.pem`、`*.pem.bak`。`.env` はもともと除外されている。

### シークレットキー(Cloudflare の環境変数)

`.env` は本番にアップロードされないため、同じ値を Cloudflare に登録する。

登録する場所: **Workers & Pages → sns-posting → Settings → Runtime → Variables and Secrets**

| 名前 | 種類 |
|---|---|
| `X_CLIENT_ID` | **Secret** |
| `X_CLIENT_SECRET` | **Secret** |
| `THREADS_APP_ID` | **Secret** |
| `THREADS_APP_SECRET` | **Secret** |

- **本番では登録しないもの**: `X_REDIRECT_URI`、`THREADS_REDIRECT_URI`(自動で組み立てられる)、`NODE_ENV`、`PORT`(使っていない)。
- **Build の Variables and secrets との違い**: Build の欄はビルド(`npm run build` / `wrangler deploy`)のときだけ使われ、動いている Worker からは見えない。最初は Build の欄に登録したため、`/api/x/connect` が **503(`X_CLIENT_IDが設定されていません`)** になった。
- **Text と Secret の違い**: Text の変数は、`wrangler.jsonc` に書かれていないと、次の自動デプロイで**消える**。Secret はデプロイしても残る。ID とシークレットはすべて Secret にする。

### リダイレクト URL(コールバック URL)

各サービスの管理画面に、本番用の URL を**追加**する。ローカル用の URL も残しておけば、開発でも使い続けられる。

| サービス | 登録する URL |
|---|---|
| X Developer Portal(Callback URI / Redirect URL) | `https://sns-posting.tryoma0227.workers.dev/api/x/callback` |
| Meta for Developers(Threads のリダイレクト URI) | `https://sns-posting.tryoma0227.workers.dev/api/threads/callback` |
| (ローカル用・そのまま) | `https://localhost:5173/api/x/callback`、`https://localhost:5173/api/threads/callback` |

### KV(セッションの保存先)

[wrangler.jsonc](../wrangler.jsonc) の `kv_namespaces` は id を書いていないため、初回のデプロイで自動作成された。管理画面での作業は不要だった。使われ方は5章。

### 確認方法

```text
/api/x/status        → 200 で {"connected":false,...} が返れば API と KV は動いている
/api/x/connect       → 302 で twitter.com へリダイレクトされれば X の設定は OK(503 なら X_CLIENT_ID がない)
/api/threads/connect → threads.net へリダイレクトされれば OK(/?threads_error=config なら THREADS_APP_ID / SECRET がない)
```

## 4. なぜ自動デプロイされるのか

Cloudflare の **Workers Builds** で、GitHub のリポジトリと Worker を連携しているため。

```text
git push(main ブランチ)
   ↓  GitHub が Cloudflare に通知する(Cloudflare の GitHub アプリ)
Cloudflare がリポジトリを取得
   ↓
npm ci                 依存パッケージをインストール
npm run build          Vite が dist/ を作る
npx wrangler deploy    wrangler.jsonc を読み、worker/index.js と dist/ をアップロード
   ↓
https://sns-posting.tryoma0227.workers.dev が新しい版に切り替わる
```

- 連携は、ダッシュボードの **Workers & Pages → Create → Import a repository** で `Ryouma139/sns-posting` を選んだときに設定された。リポジトリが非公開なので、Cloudflare の GitHub アプリにこのリポジトリへのアクセスを許可している。
- ビルドの結果やログは、Worker の **Deployments** タブで見られる。問題があれば、以前の版に戻せる(ロールバック)。
- 自分で `npm run deploy` を実行しても同じ処理ができるが、普段は push するだけでよい。
- **注意**: デプロイのたびに `wrangler.jsonc` の内容で設定が上書きされる。管理画面で Text として登録した変数が消えるのはこのため(3章)。

## 5. KV(SESSIONS)の作られ方と使われ方

KV は、**X / Threads の連携情報(アクセストークンなど)を、ブラウザごとのセッションとしてサーバー側に保存する場所**。

### どこで作成されるか

コードに KV を作る処理はない。[wrangler.jsonc](../wrangler.jsonc) の設定から Cloudflare が作る。

```jsonc
// セッション保存用。id を省略すると初回デプロイ時に自動作成される
"kv_namespaces": [{ "binding": "SESSIONS" }],
```

| 環境 | 作られ方 |
|---|---|
| 本番 | 初回の `wrangler deploy` で自動作成され、Worker に `SESSIONS` として結び付けられた |
| 開発(`wrangler dev`) | PC 上の `.wrangler/` に仮の KV が作られる。本番の KV には触れない |

コードからは `env.SESSIONS` として使う。

### どのように使われるか

[worker/index.js](../worker/index.js) の `loadSession()` と `finish()` だけが KV を読み書きする。すべての `/api/*` リクエストで次の順に処理される。

```text
リクエスト
  ↓ loadSession()  Cookie「sns_session」の ID で KV から読み込む
route()            各 API がセッションの中身を読む・書き換える
  ↓ finish()       中身が変わっていれば(dirty)KV に書き戻す
レスポンス
```

- **読み込み**(`loadSession`): Cookie の `sns_session`(ランダムな48文字)をキーに、`session:<ID>` を KV から取り出す。なければ新しい ID で空のセッションを作る。
- **書き込み**(`finish`): `session.dirty` が true のときだけ保存する。保存期間は **24時間**(`expirationTtl: 86400`)。新しいセッションなら、`sns_session` の Cookie(HttpOnly、Secure)をブラウザに渡す。

### 保存されるデータ

キー `session:<ID>` に JSON が1つ入る。

```text
{
  accessToken, refreshToken, username, name, userId, profile   ← X(xCallback で保存)
  threads: { accessToken, username, ... }                      ← Threads(threadsCallback で保存)
}
```

| 操作 | KV への影響 |
|---|---|
| 連携(`/api/x/callback`、`/api/threads/callback`) | トークンとプロフィールを保存 |
| 状態確認・投稿・投稿の取得 | 読むだけ(X の `userId` を補うときだけ書く) |
| 連携解除(`/api/x/disconnect`、`/api/threads/disconnect`) | X / Threads の項目を消して保存 |

### 設計の意図

1. **トークンをブラウザに渡さない**: ブラウザが持つのはセッション ID だけ。トークンは KV にしかないので、画面の JavaScript からは取り出せない(Express 版からの方針)。
2. **デプロイや再起動で連携が切れない**: Express 版はメモリに保存していたため再起動で消えていた。KV なら残る。
3. **OAuth の途中の情報は KV に入れない**: 連携中だけ使う `state` / `codeVerifier` は、10分で消える Cookie `sns_oauth` に入れる。KV への書き込みを減らすためと考えられる。

### 今の作りの注意点

| 項目 | 内容 | 影響 |
|---|---|---|
| Cookie がないリクエストでも書き込む | 新しいセッションは必ず保存される(`dirty: isNew`)。連携していない人が `/api/x/status` を開くだけで1回書き込む | KV の無料枠は書き込み1日1,000回。ボットなどのアクセスが多いと上限に達する |
| 24時間で連携が切れる | 保存期間は書き込んだときしか延びない | 毎日使っていても、最後の書き込みから24時間で再連携が必要 |
| X のトークンを更新しない | `refreshToken` は保存しているが、使う処理がない | X のアクセストークンは約2時間で切れるため、時間が経つと投稿や取得が失敗する |

## 6. Express 版(server.js)との違い

API のプログラムは、Express 版の `server.js`(GitHub の `SNS_posting` ブランチに残っている)から Cloudflare Workers 用の [worker/index.js](../worker/index.js) に書き直した。API の URL(`/api/x/status` など)と画面(`src/`)は変わっていない。

### 全体の比較

| 項目 | Express 版(`server.js`) | Workers 版(`worker/index.js`) |
|---|---|---|
| 動く場所 | 自分で用意するサーバー(開発は PC の 3000) | Cloudflare(開発は `wrangler dev` の 8787) |
| 起動の仕方 | `app.listen(3000)` で常に起動しておく | リクエストが来たときだけ `fetch()` が呼ばれる |
| 入り口 | `app.get('/api/x/status', ...)` を並べる | `export default { fetch(request, env) }` の1つだけ |
| ルーティング | Express が振り分ける | `route()` の `switch` で自分で振り分ける |
| 環境変数 | `process.env.X_CLIENT_ID`(`.env` を dotenv で読む) | `env.X_CLIENT_ID`(`fetch` の引数。開発は `.env`、本番は Runtime の Secret) |
| セッションの保存先 | サーバーのメモリ(`const sessions = new Map()`)。再起動やデプロイで消える | KV(`env.SESSIONS`)。デプロイしても残る |
| OAuth の途中の情報 | メモリ(`const pendingAuth = new Map()`) | 10分で消える Cookie `sns_oauth` |
| 画面の配信 | 開発は Vite。本番は Express から `dist/` を配信する作りに変える必要があった | `env.ASSETS` が `dist/` を配信。画面と API が1つの URL にまとまる |
| HTTPS | `server.js` 自身が証明書(`localhost.pem`)を読み込んで HTTPS で起動 | Worker は HTTPS を扱わない。本番は Cloudflare(Let's Encrypt)、開発は Vite だけが HTTPS |
| Vite のプロキシ | `https://localhost:3000`。自己署名証明書のため `secure: false` が必要 | `http://localhost:8787`。`secure: false` は不要 |
| 使えるライブラリ | Node.js の機能と npm パッケージ(express、dotenv など) | Web 標準の API(`fetch`、`crypto.subtle`、`Response` など)が中心。ライブラリは使っていない |
| デプロイ | サーバーの用意、証明書、プロセスの管理が必要(VM + Caddy の予定だった) | `git push` で自動(4章) |

### コードの書き方の違い

```js
// Express 版: ルートごとに関数を登録し、response に書き込む
app.get('/api/x/status', (request, response) => {
  const session = getSession(request, response)   // メモリの Map から取り出す
  response.json({ connected: Boolean(session.accessToken), username: session.username || null })
})
https.createServer({ key, cert }, app).listen(port)   // 証明書を読み込んで HTTPS で起動
```

```js
// Workers 版: 入り口は fetch だけ。Response を作って return する
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    const session = await loadSession(request, env)
    return finish(session, env, await route(request, env, session, url))
  },
}
```

- Worker には `process.env` がないため、`env` を引数で受け取り、`loadSession(request, env)`、`xConnect(request, env)` のように関数へ渡し続ける。
- レスポンスは `res.json()` で書き込むのではなく、`Response.json()` や `new Response()` で作って返す(`json()`、`redirect()` の小さな関数を用意している)。
- Cookie の読み書き(`parseCookies()`、`cookie()`)は Express 版でも自作していたものを引き継いだ。セッションは `Map` の読み書き(`getSession()`)から、KV を非同期で読み書きする `loadSession()` / `finish()` に変わった。

### 変わらなかったもの

- API の URL とレスポンスの形(`src/App.jsx` は修正していない)
- OAuth の流れ(X は OAuth 2.0 の PKCE、Threads は長期トークンへの交換)
- 「アクセストークンをブラウザに渡さず、サーバー側だけで扱う」という方針
- ローカルで開く URL(`https://localhost:5173/`)
