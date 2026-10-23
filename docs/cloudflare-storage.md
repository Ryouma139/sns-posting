# Cloudflare の保存先と予約投稿のコード

Worker が使う Cloudflare の機能(Assets・KV・D1・R2・Cron Trigger)と、それを使うコードのまとめ。予約投稿の仕様は [app-features.md](app-features.md) の3章、デプロイの手順は [cloudflare-deploy.md](cloudflare-deploy.md) を参照。

Cloudflare に関係するコードは [wrangler.jsonc](../wrangler.jsonc)(設定)と [worker/index.js](../worker/index.js)(処理)の2つだけ。画面([src/App.jsx](../src/App.jsx))は `/api/*` を呼ぶだけで、KV・D1・R2 を直接触らない。

## 1. 全体の構成

```text
ブラウザ ──→ Cloudflare Access(ログイン)──→ Worker(sns-posting)
                                              ├ fetch()      … 画面と /api/* のリクエスト
                                              └ scheduled()  … Cron Trigger(毎分)
                                                   │
                     ┌──────────────┬───────────────┼──────────────┐
                 env.ASSETS     env.SESSIONS      env.DB        env.MEDIA
                 画面(dist/)     KV              D1            R2
                                セッションなど      予約・トークン    画像
```

### 設定(wrangler.jsonc)とコードの対応

[wrangler.jsonc](../wrangler.jsonc) に書いた「バインディング」が、Worker の中で `env.〇〇` として使える。

| wrangler.jsonc | コード | 種類 | 作られ方 |
|---|---|---|---|
| `assets`(`binding: "ASSETS"`) | `env.ASSETS` | 静的ファイル | `npm run build` の `dist/` がデプロイのたびにアップロードされる |
| `kv_namespaces`(`SESSIONS`) | `env.SESSIONS` | KV | id を書いていないため、初回のデプロイで自動作成 |
| `d1_databases`(`DB`、`sns-posting`) | `env.DB` | D1(SQLite) | id を書いていないため、デプロイで自動作成 |
| `r2_buckets`(`MEDIA`、`sns-posting-media`) | `env.MEDIA` | R2 | R2 を有効にしたあと `npx wrangler r2 bucket create sns-posting-media` で作成 |
| `triggers.crons`(`* * * * *`) | `scheduled()` | Cron Trigger | デプロイで登録 |

### 入り口は2つ

```js
export default {
  async fetch(request, env) { ... },         // ブラウザ・Meta からのリクエスト
  async scheduled(controller, env) { ... },  // Cron が毎分呼ぶ
}
```

- **`fetch`**:
  - `/api/` 以外は `env.ASSETS.fetch(request)` で画面のファイルを返す。
  - `/api/media/*` は、セッションを作らずに R2 の画像を返す(`serveMedia`)。
  - それ以外の `/api/*` は、セッションを読み込んで(`loadSession`)、`route()` で振り分ける。最後に変更があれば保存する(`finish`)。
- **`scheduled`**: `runDueSchedules(env)` を呼び、予定時刻を過ぎた予約を投稿する。

## 2. KV(`env.SESSIONS`):ブラウザごとの情報

「キー → 値」で保存し、期限が来ると自動で消える。**書き込みの反映に最大60秒かかる**ため、すぐ読み返す必要のないデータに使う。

| キー | 中身 | 期限 | 読み書きする関数 |
|---|---|---|---|
| `session:{ランダムな48文字}` | X / Threads の連携情報(トークン、プロフィール) | 24時間 | `loadSession` / `finish` |
| `threads-calls:{ユーザーID}` | Threads API の呼び出し回数(1時間ごと) | 3日 | `readThreadsCalls` / `saveThreadsCalls` |

- ブラウザの Cookie `sns_session` に入っているのは ID だけ。トークンは KV にしかない。
- 書き込むのは、内容が変わったとき(`session.dirty`)だけ。無料枠の書き込みは1日1,000回のため。
- 以前は Threads 用の画像も `media:{ID}` として KV に1時間置いていた。予約投稿の画像を予定時刻まで置いておくため、R2 に移した。

## 3. D1(`env.DB`):予約投稿とトークン

SQL で読み書きするデータベース。**書き込んだ内容をすぐ読める**ため、二重投稿の防止に使える。

### テーブル

| テーブル | 中身 |
|---|---|
| `accounts` | 投稿に使うトークン。アカウントごとに1行(`platform` + `user_id`) |
| `scheduled_posts` | 予約。予約ごとに1行 |

`accounts` の列:

| 列 | 内容 |
|---|---|
| `platform`, `user_id` | `x` か `threads` と、SNS のユーザー ID(この2つで1行が決まる) |
| `username` | ユーザー名 |
| `access_token`, `refresh_token` | 投稿に使うトークン |
| `expires_at` | トークンの期限(ミリ秒) |
| `updated_at` | 更新日時 |

`scheduled_posts` の列:

| 列 | 内容 |
|---|---|
| `id` | 予約の ID(ランダムな32文字) |
| `platform`, `account_id`, `account_username` | どのアカウントで投稿するか |
| `text`, `topic_tag` | 本文と Threads のトピックタグ |
| `images` | 画像の `{ origin, ids }`(JSON)。画像がなければ空 |
| `scheduled_at` | 予定時刻 |
| `status` | `pending`(予約済み)→ `posting`(投稿中)→ `posted`(投稿済み)/ `failed`(失敗) |
| `posted_id`, `error` | 投稿の ID、または失敗の理由 |
| `created_at`, `updated_at` | 作成日時・更新日時 |

### テーブルの作り方(`ensureSchema`)

- Worker が最初に D1 を使うときに `CREATE TABLE IF NOT EXISTS` でテーブルを作る(`schema`)。マイグレーションのコマンドは不要。
- あとから足した列(`images`)は `addedColumns` に書く。`PRAGMA table_info` で列があるか調べ、なければ `ALTER TABLE` で追加する。
- 一度作ったら、その Worker が動いている間は確認しない(`schemaReady`)。

### 関数

| 関数 | 呼ばれるとき | SQL |
|---|---|---|
| `saveAccount` | 連携したとき(上書き)・予約したとき(なければ追加) | `INSERT OR REPLACE` / `INSERT OR IGNORE INTO accounts` |
| `listSchedules` | `GET /api/schedules` | `SELECT * FROM scheduled_posts` |
| `createSchedule` | `POST /api/schedules` | `INSERT INTO scheduled_posts` |
| `deleteSchedule` | `DELETE /api/schedules/{ID}` | `DELETE ... RETURNING images`(消した予約の画像も消す)。投稿中は消さない |
| `xAccessToken` | X に投稿する前 | 期限切れなら `refresh_token` で更新し、`UPDATE accounts` |
| `threadsAccessToken` | Threads に投稿する前 | 残りが7日を切ったら更新し、`UPDATE accounts` |
| `publishSchedule` | 予約を投稿するとき | `SELECT * FROM accounts`(予約したアカウントのトークン) |
| `runSchedule` | 予約を1件投稿するとき | `UPDATE ... SET status = 'posting' ... RETURNING *` → 投稿 → `UPDATE status` |
| `postScheduleNow` | `POST /api/schedules/{ID}/post`(今すぐ投稿) | `runSchedule` と同じ |
| `runDueSchedules` | Cron(毎分) | 3つの SQL を `batch` でまとめて実行 |

### 二重投稿を防ぐ仕組み(`runSchedule`)

```sql
UPDATE scheduled_posts SET status = 'posting' WHERE id = ? AND status = 'pending' RETURNING *
```

`pending` のものだけを `posting` に変える。変えられたとき(1行返ってきたとき)だけ投稿する。Cron と「今すぐ投稿」が同時に動いても、投稿するのはどちらか一方だけになる。KV では書き込みの反映が遅いため、この方法が使えない。

## 4. R2(`env.MEDIA`):画像

ファイルの置き場所。キーは `media/{ランダムな32文字}`。画像の種類(`image/png` など)は `httpMetadata` の `contentType` に入れる。

| 関数 | 役割 |
|---|---|
| `storeMedia` | 画像を保存して ID を返す |
| `loadMedia` | 画像を読む(予約投稿で X へアップロードするため) |
| `deleteMedia` | 画像を消す |
| `serveMedia` | `/api/media/{ID}` で画像を返す(Meta が取りに来る) |

R2 には自動で消える期限がないため、コードで消す。

```text
今すぐ投稿(Threads): 保存 → Threads に URL を渡す → 公開 → 消す(成功しても失敗しても)
予約投稿:            予約したときに保存 → 予定時刻に投稿 → 投稿できたら消す
                     予約を削除したら消す / 失敗したら「もう一度投稿」のために残す
```

- X は画像を直接アップロードするため、今すぐ投稿では R2 を使わない。予約投稿のときだけ、R2 から読んでアップロードする。
- Threads は画像を URL で受け取る。予約には、予約したときの URL の先頭(`origin`)を保存しておき、Cron が `{origin}/api/media/{ID}` を組み立てる(Cron にはリクエストの URL がないため)。
- `/api/media/*` は Cloudflare Access の Bypass で外から開ける。ID はランダムで、投稿し終わると消える。
- バケットは公開しない(パブリックアクセスや r2.dev の URL は使わない)。画像は Worker から返す。

## 5. 予約投稿の流れ

```text
① 予約する(画面 → POST /api/schedules。画像があれば multipart/form-data)
   createSchedule
     ├ saveAccount ………… D1 accounts にトークンがなければ追加
     ├ storeMedia ………… 画像を R2 に保存
     └ INSERT ……………… D1 scheduled_posts(status: pending, images: {origin, ids})

② 毎分(Cron → scheduled → runDueSchedules)
     ├ 10分以上 posting のまま → failed にする
     ├ 投稿済みで7日たったもの → 削除
     └ 予定時刻を過ぎた pending を最大10件(画像付きは1件だけ)
          ↓
     runSchedule
       ├ status を posting に(二重投稿の防止)
       ├ publishSchedule
       │    ├ D1 accounts からトークンを読む(期限が近ければ更新)
       │    ├ X:       loadMedia(R2) → アップロード → 投稿
       │    └ Threads: threadsPublish(/api/media/{ID} の URL を渡す)
       ├ status を posted / failed に
       └ posted なら deleteMedia(R2)

③ 一覧(画面 → GET /api/schedules)… 概要画面を開いたとき・「更新」を押したとき
```

- 画像付きの予約を1回の実行で1件にしているのは、Threads が画像の処理を待つ間に何度も API を呼ぶため。Workers の無料プランでは、1回の実行で外部を呼べるのは50回まで。
- Threads の投稿(コンテナ作成 → 公開)は、今すぐ投稿と予約投稿で同じ関数(`threadsPublish`)を使う。

### API

| API | 関数 | 内容 |
|---|---|---|
| `GET /api/schedules` | `listSchedules` | 予約の一覧(すべてのアカウント) |
| `POST /api/schedules` | `createSchedule` | 予約する。連携中のアカウントで予約する |
| `DELETE /api/schedules/{ID}` | `deleteSchedule` | 削除する(投稿中は 409) |
| `POST /api/schedules/{ID}/post` | `postScheduleNow` | 今すぐ投稿する(予約したアカウントのトークンを使う) |

予約の API でエラーが起きたときは、`handleSchedule` がまとめて JSON のエラーにして返す。

## 6. KV・D1・R2 の使い分け

| | KV | D1 | R2 |
|---|---|---|---|
| 得意なこと | 小さいデータを期限付きで置く | 表で検索・更新。書き込みがすぐ反映される | 大きいファイルを置く |
| このアプリでの用途 | セッション、API の呼び出し回数 | 予約、トークン | 画像 |
| 自動で消えるか | 期限で消える | 消えない(投稿済みの予約はコードで7日後に消す) | 消えない(コードで消す) |
| 無料枠 | 書き込み 1日1,000回、保存 1GB | 読み込み 1日500万行、書き込み 1日10万行 | 保存 10GB、書き込み 月100万回、読み込み 月1,000万回 |
| 有効にする手続き | 不要 | 不要 | 必要(支払い方法の登録) |

- ブラウザのセッション(KV)は24時間で切れるが、予約は何日も先のことがある。そのため、ブラウザと関係なく長く残すデータ(予約・トークン・予約の画像)は D1 と R2 に置く。
- トークンは KV と D1 の両方に入る。KV はブラウザからの操作用、D1 は予約投稿用。D1 のトークンは暗号化していない(Cloudflare Access でサイトを守っている前提)。

## 7. 開発環境(ローカル)

`npm run dev`(`wrangler dev`)では、KV・D1・R2 はすべて PC の `.wrangler/` フォルダの中の仮のものを使う。本番のデータには触れない。

| 確認したいこと | コマンド |
|---|---|
| Cron を1回動かす | `curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`(`--test-scheduled` を付けてある) |
| D1 の中身 | `npx wrangler d1 execute sns-posting --local --command "SELECT * FROM scheduled_posts"` |
| R2 に画像を置く | `npx wrangler r2 object put sns-posting-media/media/{ID} --local --file 画像のパス --content-type image/png` |

- `wrangler dev` は Cron を自動では動かさない。
- `/__scheduled` は画面のファイルの配信(SPA)に吸い込まれるため使えない。
- Threads の画像付き投稿は、Meta が localhost の画像を取りに来られないため、開発環境ではできない(予約も同じ)。
