# 今後の展望:データベース導入と本番環境

SNS投稿ツールにDBを導入し、本番環境で常時稼働させるまでの方針をまとめる。

## 1. 現状の課題

| データ | 現在の保存先 | 課題 |
|---|---|---|
| 連携トークン(X / Threads)・プロフィール | `server.js` のメモリ上の `sessions` Map | サーバーを再起動すると消え、再連携が必要になる |
| 予約投稿 | ブラウザの localStorage | ブラウザを閉じていると投稿されない。他の端末から見えない |
| 下書き | ブラウザの localStorage | 他の端末と共有できない |
| 通知 | ブラウザの localStorage | 問題なし(このまま) |
| 投稿アーカイブ | 毎回APIから取得 | 分析機能のために履歴を貯めたい |

## 2. DBに移す対象(優先順)

1. **連携トークン・セッション**:再起動で連携が切れる問題を解消する
2. **予約投稿**:DBに保存し、サーバー側の定期実行(`setInterval` や node-cron)で投稿する。ブラウザが閉じていても投稿されるようにする
3. **下書き**:複数の端末で使えるようにする
4. **投稿履歴**:分析ページで使う

通知と、最後に選んだプラットフォームの設定は localStorage のままにする。

### テーブル案

```sql
accounts        (id, platform, user_id, username, access_token, refresh_token, expires_at)
scheduled_posts (id, account_id, text, scheduled_at, status, posted_id, error, created_at)
drafts          (id, platform, text, updated_at)
posts           (id, account_id, platform_post_id, text, created_at)
```

- アクセストークンは暗号化して保存する(`crypto` の AES-GCM など)
- DBファイルは `.gitignore` に追加する

## 3. DBの選定:SQLite

**SQLite を採用する**(ライブラリは `better-sqlite3`、または Node 22.5以降なら標準の `node:sqlite`)。

- 個人向けのツールで、サーバーも Express 1つなので、ファイル1つで動く SQLite が最も手軽
- DBサーバーを別に立てる必要がない
- 次のような状況になったら PostgreSQL への移行を考える
  - 複数のユーザーで使うようになった
  - サーバーレス環境で動かしたくなった

### SQLite と PostgreSQL の違い

| | SQLite | PostgreSQL |
|---|---|---|
| 動き方 | アプリのプロセスの中で動く | 別のサーバーとして動き、ネットワーク経由で接続する |
| データの場所 | アプリと同じマシンのファイル | DBサーバー側 |
| サーバーレス(Cloud Run など)との相性 | ✕ コンテナ内のファイルが消える。コンテナが増えるとDBがばらばらになる | ◎ アプリにデータを持たせないので、コンテナを使い捨てにできる |

PostgreSQL そのものがサーバーレスなのではない。DBがアプリの外にあるので、アプリ側をサーバーレスにできる、という違いである。

## 4. Docker での構成

SQLite はファイルなので、DB用のコンテナは作らない。アプリのコンテナが DBファイルを開き、そのファイルを named volume に置いて残す。

```
[app コンテナ] node server.js ──→ /app/data/app.db
                                     ↑
                           named volume (sns-data)
```

**Dockerfile(案)**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV DB_PATH=/app/data/app.db
EXPOSE 3001
CMD ["node", "server.js"]
```

**compose.yaml(案)**

```yaml
services:
  app:
    build: .
    ports:
      - "3001:3001"
    env_file: .env
    volumes:
      - sns-data:/app/data
volumes:
  sns-data:
```

### 注意点

- volume をマウントしないと、コンテナを作り直したときに DB が消える
- Windows ではフォルダを直接マウントせず、named volume を使う(SQLite のファイルロックが不安定になるため)
- イメージは Debian 系(`node:22-slim`)を使う。Alpine では `better-sqlite3` のビルドに失敗しやすい
- `.dockerignore` に `node_modules` と `.env` を書く
- `server.js` が読み込む HTTPS 証明書と、OAuth のリダイレクトURIを、コンテナの構成に合わせる
- SQLite は同時書き込みが得意ではないので、コンテナは1つだけにする
- 開発は Docker を使わずローカルで動かし、DBの場所は環境変数 `DB_PATH` で切り替える

## 5. 本番環境:VM + ディスク + Litestream

### SQLite はオブジェクトストレージに置けない

S3 や Cloud Storage は、ファイルを丸ごと保存・取得することしかできない。SQLite に必要なファイルロックや部分的な書き込みができないので、DBファイルを直接置くと壊れる。gcsfuse や s3fs でのマウント、EFS や Filestore(NFS)も避ける。

### 保存場所の違い

| 保存場所 | たとえ | SQLite |
|---|---|---|
| VM のディスク(AWS: EBS / Google Cloud: Persistent Disk) | パソコンの C ドライブ | ◎ ここに置く |
| オブジェクトストレージ(S3 / Cloud Storage) | Google ドライブのようなファイル置き場 | ✕ バックアップ用 |
| サーバーレスのコンテナ内(Cloud Run など) | ネットカフェの PC | ✕ 消える |

Docker の named volume の実体は、VM のディスク上のフォルダである。

### 採用する構成

```
VM (Docker) ── app コンテナ ── /data/app.db  ← VM のディスク
                                   │
                              Litestream で常時レプリケーション
                                   ↓
                          S3 / Cloud Storage(バックアップ)
```

- **VM の候補**:Compute Engine の e2-micro(米国リージョンなら無料枠あり)、または AWS Lightsail(月 $5 程度)
- **Litestream**:SQLite の変更をほぼリアルタイムで S3 や Cloud Storage に送る。VM が壊れても、そこから DB を復元できる
- 予約投稿を実行するにはサーバーが常に動いている必要があるので、VM で常時起動する構成が合っている
- **シークレット**:Secret Manager(Google Cloud)または Parameter Store(AWS)で管理する
- **HTTPS**:自己署名証明書をやめ、Caddy や nginx と Let's Encrypt に任せる

### 比較:サーバーレスにする場合

| | VM + SQLite + Litestream(採用) | サーバーレス + PostgreSQL |
|---|---|---|
| 費用 | 無料〜月 $5 程度 | 無料枠〜月 $10以上 |
| 構成の簡単さ | ◎ 今の構成がほぼそのまま使える | △ DBの変更と予約処理の作り直しが必要 |
| 運用の手間 | OS の更新などが少し必要 | ほぼ不要 |
| 予約投稿 | サーバー内の定期実行で動く | Cloud Scheduler や EventBridge から起動する必要がある |

## 6. ロードマップ

### フェーズ1:SQLite 導入(ローカル)
- [ ] `node:sqlite` または `better-sqlite3` を導入し、`DB_PATH` で DB の場所を指定できるようにする
- [ ] セッションと連携トークンを DB に移す(トークンは暗号化する)
- [ ] 予約投稿を DB に移し、サーバー側の定期実行で投稿する
- [ ] 下書きを DB に移す
- [ ] DBファイルを `.gitignore` に追加する

### フェーズ2:Docker 化
- [ ] Dockerfile、compose.yaml、`.dockerignore` を作る
- [ ] named volume で DB を残せることを確認する
- [ ] 証明書と OAuth のリダイレクトURIをコンテナの構成に合わせる

### フェーズ3:本番デプロイ
- [ ] Compute Engine(e2-micro)または Lightsail に VM を作る
- [ ] Caddy + Let's Encrypt で HTTPS にする
- [ ] Litestream で Cloud Storage または S3 にバックアップする
- [ ] シークレットを Secret Manager または Parameter Store に移す
- [ ] バックアップから復元できることを確認する

### フェーズ4:機能拡張(必要に応じて)
- [ ] 投稿履歴を DB に貯めて、分析ページで使う
- [ ] 複数ユーザーで使うことになったら、PostgreSQL(Cloud SQL、RDS、Neon、Supabase)への移行を検討する
