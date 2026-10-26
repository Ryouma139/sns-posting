# 脆弱性の対応まとめ(2026年10月)

2026年10月21日の Node.js のセキュリティリリースをきっかけに、`Code_dev` の中のプロジェクトの脆弱性を調べて直したときのまとめ。何が原因で、何がまずく、どうやって見つかり、どう防ぐかを書く。

関連: [cloudflare-storage.md](cloudflare-storage.md)(SNS_Posting の KV・D1・R2)

## 1. 対応の結果

### Node.js 本体

| | 前 | 後 |
|---|---|---|
| Node.js | v24.14.0 | **v24.22.1**(2026年10月のセキュリティ修正版) |
| npm | 11.9.0 | 11.19.1 |

24.x に影響した主な CVE(重要度 High): Brotli の展開処理の範囲外書き込み(リモートコード実行)、TLS のホスト名の確認のすり抜け(2件)、`dns.resolve` が NUL 文字で名前を切る。c-ares・CA 証明書の一覧・Undici・OpenSSL も更新された。

Node.js はパソコン全体で1つなので、更新すれば全部のアプリに反映される。npm パッケージはアプリごとに直す必要がある。

### npm パッケージ

| プロジェクト | 脆弱性(前 → 後) | 主な対応 | 公開 |
|---|---|---|---|
| SNS_Posting | 7 → 0 | `npm audit fix`(`concurrently`・`vite`・`wrangler`) | Cloudflare にデプロイ済み |
| Product/storlytell | Critical 1・High 8 → High 5 | **Next.js 14 → 16、React 18 → 19**、Dockerfile を Node.js 24 で作り直し | 公開先なし(手元の Docker) |
| 開発用Product/kimoti_sekkei | Critical 1 ほか5 → 0 | **Astro 5 → 7**、JS のファイル名の設定を移す、CI の Node.js を 24 に | GitHub Pages に公開済み |
| Product/blog | 12 → 3 | Astro 7.2 → 7.4、`@astrojs/vercel` を更新、`markdown.remarkPlugins` を `unified()` に、CI の Node.js を 24 に | Vercel にデプロイ済み |
| 開発用Product/blog | 8 → 0 | `npm audit fix` | push 済み |
| Progratur | Critical 17 ほか54 → High 28 | `npm audit fix` と `overrides`、CI の Node.js を 20 から 24 に | GitHub Pages に公開済み |
| claude | 13 → 0 | `npm audit fix`、Notion MCP を更新、npm から削除されたパッケージを外す | (Git の管理外) |
| Quiita | 6 → 0 | `qiita-cli` 1.8 → 1.12 | push 済み(公開のワークフローは別の理由で失敗。5章) |

残っているものは、どれも**修正版がまだ出ていない**もの。

| 残っているもの | 場所 | 危なさ |
|---|---|---|
| `braces` 3.0.3(High) | storlytell・Progratur(ESLint・Docusaurus の依存) | ファイルを探すときのパターンの処理の DoS。攻撃者がパターンを渡す経路がないので低い |
| `path-to-regexp` 6.1.0(High) | Product/blog(`@vercel/routing-utils` が固定) | ビルドのときに、自分で書いたルートの設定を変換するだけなので低い |

## 2. 脆弱性があった原因

一番の原因は **「入れたまま更新していなかった」** こと。自分のコードの書き方が悪かったのではなく、あとから脆弱性が見つかった古いバージョンを使い続けていて、それに気付く仕組みがなかった。

| # | 原因 | 内容 | 当てはまったもの |
|---|---|---|---|
| 1 | Node.js 本体が古い | セキュリティ修正の入った版に上げていなかった | パソコン全体 |
| 2 | 依存パッケージを更新していない | `package-lock.json` で固定した版を使い続けていた。脆弱性の多くは**依存の奥**にあり、`npm audit fix` を1回実行すれば直るものが大半だった | ほぼ全部 |
| 3 | フレームワークのサポート切れ | 古いメジャーバージョンには修正版が出ない。Critical を直すにはメジャーアップデートが必要だった | storlytell(Next.js 14)、kimoti_sekkei(Astro 5) |
| 4 | フレームワークが古い依存を指定している | フレームワークは最新でも、依存の指定が古く、普通には直せなかった | Progratur(Docusaurus → `tinypool` など)、Product/blog(Vercel → `path-to-regexp`) |
| 5 | 修正版がない | 作者が修正版を出していない | `braces` |

### 脆弱性以外に見つかった問題

| 問題 | 内容 |
|---|---|
| **第三者のパッケージにトークンを渡す設定** | `~/.claude/settings.json` に、個人が公開した `figma-mcp` を `npx -y`(確認なし・毎回最新版)で動かす設定と、Figma のトークンが平文で書かれていた。Claude Code はこの場所を読まないので動いてはいなかった。設定とトークンは削除した |
| **npm から削除されたパッケージ** | claude フォルダの `@rui.branco/figma-mcp` は npm から削除済みで、起動のたびに `npm install -g` で黙って最新版を入れる作りだった。使っていなかったので外した |
| **CI の Node.js のずれ** | `node-version: 22` はランナーにある 22.23.3 が使われ、Astro 7 が求める 22.23.4 以上に足りずに失敗した。Progratur は Node.js 20(2026年4月でサポート終了)だった。すべて 24 にそろえた |
| **失敗に気付いていない** | Quiita の公開が2026年3月から `Forbidden` で失敗し続けていた。開発用Product/blog の e2e テストのログインが、アカウント情報の不一致で失敗していた |
| **`.gitignore` の設定ミス** | Product の `.gitignore` に `storlytell/` があり、新しく作ったファイルが Git に入らない。README にある Dockerfile がリポジトリになかったのも、おそらくこのため |
| **lint が動いていない** | storlytell には ESLint の設定がなく、lint が一度も動いていなかった |

## 3. 脆弱性があると何がまずいか

脆弱性があると、攻撃者がアプリを、作った人が意図していない動きにさせられる。何が起きるかは、**脆弱性の種類**と**プログラムがどこで動いているか**で決まる。

### 種類ごとに起きること(被害が大きい順)

| 種類 | 何ができてしまうか | 今回の例 |
|---|---|---|
| リモートコード実行(RCE) | サーバーの上で好きなプログラムを動かせる。データの盗み出し・改ざん・踏み台など何でもできる | Next.js 14・Astro 5 の画像最適化、`tinypool`、`serialize-javascript` |
| SSRF | サーバーを使って、外から届かない内部のサービスや認証情報にアクセスされる | Next.js の rewrites・Server Actions、Astro のエラーページ |
| XSS | 見ている人のブラウザで攻撃者のスクリプトが動く。Cookie を盗まれる、勝手に操作される | Astro・Next.js の HTML のエスケープ漏れ |
| 認証のすり抜け | ログインやミドルウェアのチェックを通らずにページを見られる | Next.js のミドルウェア、Astro の `base` の判定 |
| 情報の漏えい | ほかの人のデータやサーバーのファイルを読まれる | `http-cache-semantics`、`vite`・`esbuild`(開発サーバー)、`follow-redirects` |
| なりすまし | IP アドレスを偽って、IP での制限を突破される | `proxy-addr` |
| DoS | 特別なデータで CPU やメモリを使い切らされ、止まる。従量課金なら料金や無料枠を使い切らされる | `braces`・`qs`・`js-yaml`・`path-to-regexp` など(数は一番多い) |

### 動いている場所で危なさが変わる

攻撃者がそのプログラムにデータを送れなければ、悪用できない。

| 動いている場所 | 危なさ | 該当するもの |
|---|---|---|
| インターネットに公開しているサーバー | **高い**。誰でも攻撃のデータを送れ、公表から数日でボットに狙われる | Product/blog(Vercel の SSR)、SNS_Posting(Cloudflare Worker) |
| 静的サイト | 低め。サーバーでプログラムが動かない。ただし XSS は HTML に残ると影響する | kimoti_sekkei、Progratur(GitHub Pages) |
| 手元の開発サーバー | 中くらい。同じ Wi-Fi の人や、開いた悪いサイトから攻撃されることがある | `npm run dev`、Docker の storlytell |
| ビルドのときだけ使うツール | 低い。攻撃には細工した設定や入力を自分で入れる必要がある | `braces`、`serialize-javascript` など |

### アプリごとのまずかった点

| アプリ | まずかった点 | 起きえたこと |
|---|---|---|
| storlytell | Next.js 14 の画像最適化の RCE | 公開していれば、サーバーを乗っ取られ、PostgreSQL のデータを盗まれたり消されたりした。手元だけだったが、同じ Wi-Fi からは届く状態だった |
| Product/blog | XSS、キャッシュからの情報漏えい、DoS | 管理画面を使う人のセッションを盗まれ、記事を書き換えられた。公開中のサーバーなので一番狙われやすい |
| SNS_Posting | 開発用のツールだけ(本番の Worker には入っていない) | 開発中に `.env`(X・Threads のシークレット)を読まれた |
| kimoti_sekkei・Progratur | ビルドの道具、Astro の XSS | 被害は小さめ。GitHub Actions の中で悪用されると、デプロイ用の権限を使われた |
| Claude Code の figma-mcp の設定 | 第三者のパッケージに `npx -y` でトークンを渡していた | 作者のアカウントが乗っ取られると、起動しただけでファイルやトークンを盗まれた |

## 4. 細工した画像(AVIF・SVG)でなぜ乗っ取られるのか

Next.js や Astro の「画像の最適化」は、サーバーで画像を開いて縮小・変換する。

```text
ブラウザ → /_next/image?url=写真.avif&w=640
サーバー: ① 読み込む → ② デコードする(圧縮データをピクセルに戻す) → ③ 縮小・変換 → ④ 返す
```

②は `sharp` を使い、中身は C・C++ で書かれた画像ライブラリ(libvips、AVIF なら libheif・dav1d など)。C・C++ はメモリを直接扱うので、ミスがあるとメモリを壊しやすい。

```text
細工した AVIF: ヘッダーには「幅 10」と書き、実際のデータは大量に入れる
  → 小さな入れ物からデータがあふれる(バッファオーバーフロー)
  → 隣のメモリ(プログラムの次の動きを決める場所)を上書き
  → 攻撃者の命令が実行される(RCE)
```

- 画像の最適化は誰でも画像を表示できるための機能なので、**ログインなしで誰でも呼べる**。
- AVIF は中身が動画の圧縮方式(AV1)で構造が複雑、デコーダーも新しくバグが残りやすい。SVG は「図を描く命令のテキスト」で機能が多い。
- 過去にも同じ種類の事件がある: ImageTragick(2016年、ImageMagick)、libwebp(2023年、CVE-2023-4863、Chrome や iPhone で実際に悪用された)。

| アプリ | 攻撃の経路 |
|---|---|
| storlytell | **あった**。管理画面に画像のアップロード(`/api/upload`、`/admin/img_add`)がある |
| Product/blog | サーバーで画像を変換する作りなら経路になる。Astro 7.4.2 で対策済み |
| kimoti_sekkei・Progratur | 変換はビルドのときだけ。リポジトリに細工した画像を入れる必要があり、危険は低い |
| SNS_Posting | 画像は R2 にそのまま置いて返すだけで、デコードしない。当てはまらない |

対策は、①ライブラリを修正版にする、②読み込める画像の場所やアップロードできる人を絞る、の2つ。

## 5. データベースのパスワードを盗まれると

アプリを通さず、データベースに直接つないで好きな操作ができる。アプリの画面の制限(「削除は管理画面だけ」など)は効かない。

| 起きること | 内容 |
|---|---|
| 全データを読まれる | 個人情報があれば情報漏えいの事故になる |
| 書き換えられる | 記事を改ざんされる。悪いリンクやスクリプトを埋め込まれる |
| 消される・人質に取られる | 「返してほしければ払え」と要求される。PostgreSQL や MongoDB は自動で狙われている |
| サーバーごと乗っ取られる | スーパーユーザーなら `COPY ... TO PROGRAM` でサーバーの上でコマンドを実行できる |
| ほかにも入られる | 同じパスワードをほかで使っていれば、そちらにも入られる |

### storlytell の `docker-compose.yml` の気を付ける点(未対応)

```yaml
postgres:
  environment:
    POSTGRES_USER: dev          # 公式イメージではスーパーユーザーになる
    POSTGRES_PASSWORD: devpass  # 推測しやすく、Git に入っている
  ports:
    - "5433:5432"               # 0.0.0.0 で待ち受ける = 同じ Wi-Fi から直接つなげる
```

- Product は非公開のリポジトリだが、公開や共有をした時点でパスワードが漏れる。
- 対策: `"127.0.0.1:5433:5432"` にして自分のパソコンからだけつなげる。パスワードは `.env` に移して Git に入れない。本番なら長いランダムなパスワードと、必要な表だけ触れるユーザーにする。

### ほかに盗まれると困るもの

| アプリ | もの | 盗まれたら |
|---|---|---|
| Product/blog | Supabase のキー(`.env`) | anon キーなら RLS が守る。**service_role キーなら RLS を無視して全データを読み書きできる** |
| SNS_Posting | D1 の X・Threads のトークン、Cloudflare の Secret | あなたのアカウントで勝手に投稿される。X はクレジットも消費される |
| Claude Code の設定 | Notion のキー(残っている) | ページを読まれる・書き換えられる |

盗まれたら: ①パスワード・キーを変えて古いものを無効にする、②ログを確認する、③データを確認し必要ならバックアップから戻す、④同じパスワードをほかで使っていれば変える。

## 6. 脆弱性はどうやって分かるのか

### 世の中で見つかり、公表されるまで

```text
① 発見     研究者・利用者・開発者がコードを調べて見つける
② 非公開で報告   作者やセキュリティ窓口へ(すぐ公開すると直す前に悪用されるため)
③ 修正     作者が修正版を作る。その間は公表しない
④ 公表     修正版と同時に公開する。CVE 番号(例: CVE-2026-111497)、GitHub Advisory(例: GHSA-...)
⑤ 気付く   ツールがデータベースと照らし合わせて知らせる(npm audit、Dependabot)
```

脆弱性は公表の日に作られたのではなく、**ずっと前からあったものが、その日に分かった**。Node.js は修正版を出す数日前に、セキュリティリリースの日を予告する。

### 今回分かった方法

| 分かったこと | 方法 |
|---|---|
| Node.js が古い | `node -v` と Node.js 公式ブログのセキュリティリリースを比べた |
| npm パッケージの脆弱性 | `npm audit`。`package-lock.json` の全パッケージを GitHub Advisory のデータベースと照らし合わせる |
| メジャーアップデートが必要 | 脆弱性ごとの「影響するバージョンの範囲」と、`npm view` で調べた公開中のバージョンを比べた |
| npm から削除されたパッケージ | `npm view` が 404。コードを読んで自動アップデートの処理を見つけた |
| 第三者の MCP とトークン | 設定ファイルを探した |
| CI の Node.js のずれ | push したあとの GitHub Actions の失敗 |
| Quiita の公開の失敗 | `gh run list` で過去の履歴を見た |

パッケージの脆弱性は、`npm audit` を実行すればすぐ分かる状態だった。それ以外の問題はデータベースに載らず、**実際に動かす**・**ログや設定を見る**ことで見つかった。

## 7. パッケージの仕組みを知らなくても気付けるのか

**気付く**だけなら、仕組みの理解はいらない。照らし合わせは機械がやる。理解が必要なのは、気付いたあとの**判断**と**修正**。

### 入っているパッケージの数

| プロジェクト | 自分で入れた | 実際に入っている |
|---|---|---|
| Progratur | 12 | **1,322** |
| storlytell | 11 | 414 |
| kimoti_sekkei | 4 | 335 |
| SNS_Posting | 10 | 175 |

```text
あなたが入れた: @docusaurus/core
                  ├─ @docusaurus/utils ─ micromatch ─ braces   ← 脆弱性
                  ├─ chokidar ─ braces
                  └─ tinypool                                ← 脆弱性(Critical)
```

アプリを作る人は、入っているパッケージの大半を名前すら知らないのが普通。パッケージを作る人も、自分のものは分かるが依存の奥までは把握しておらず、分かっているコードでも想定外の使われ方を見落とす。だから「全部を理解して安全を確かめる」のは誰にもできず、データベースと照らし合わせて**見つかったものを早く直す**のが現実的。

### 判断に必要だった知識

| 場面 | 必要な理解 | 今回の例 |
|---|---|---|
| どれくらい危ないか | どこで動くか | `braces` はビルドの DoS で低い、Next.js はサーバーの RCE で最優先 |
| なぜ直らないか | 直接の依存と依存の奥の違い | Docusaurus は最新なのに `tinypool` が古かった |
| 上げてよいか | メジャー・マイナー・パッチの違い | `npm audit fix --force` は Docusaurus を 3.7.0 に格下げしようとしていた |
| 壊れていないか | 変更履歴・移行ガイド | Astro 7 で JS のファイル名の設定が効かなくなっていた。ビルドは成功していたので、出力を比べないと気付けなかった |

### 最低限知っておくこと

1. `package.json` は「入れたいもの」、`package-lock.json` は「実際に入っている全部」。脆弱性は lock で照合される
2. 自分で入れたのは数個でも、その奥に数百個ある。脆弱性の多くは奥にある
3. バージョンの先頭の数字(メジャー)が上がると壊れることがある。`--force` はこれを無視する
4. そのプログラムがどこで動くか(公開サーバー・ビルドだけ・開発用)で危なさが決まる
5. 古いメジャーバージョンには修正版が出ない(Next.js 14、Astro 5)

## 8. パッケージを作る人に必要な知識

npm に**公開するだけなら誰でもできる**(`package.json` を書いて `npm publish`、審査なし)。そのため品質も安全性もまちまちなパッケージが数百万個ある。広く使われるパッケージを作るには、次の知識が必要になる。

| 分野 | 内容 | 今回の例 |
|---|---|---|
| 言語・実行環境 | CommonJS と ESM、Node.js のバージョンごとの違い、OS ごとの違い | `uuid` 14 が ESM だけになった。`vite` の脆弱性は Windows のパスの扱いが原因 |
| 互換性の管理 | セマンティック バージョニング、非推奨の警告を先に出す、古い版をどこまで保守するか | Astro 7.4 の `remarkPlugins` の非推奨。Next.js は 14 系に修正版を出さなかった |
| セキュリティ | エスケープ、ReDoS を起こさない正規表現、プロトタイプ汚染、外から来た URL を信用しない、入力の検証 | Astro の XSS、`path-to-regexp`、`tinypool`、Next.js の SSRF、`qs` |
| 分野の専門知識 | 画像形式、HTTP の仕様、YAML の仕様など | `sharp` の脆弱性は中の C の画像ライブラリにあった |
| テストと品質 | いろいろな OS・Node.js での自動テスト、型定義、ドキュメント | |
| 保守と運営 | 脆弱性の報告の受け付け、公開アカウントの二段階認証、依存を増やしすぎない | アカウントを乗っ取られると悪意のある版を公開される(figma-mcp で心配したこと) |

パッケージを選ぶときは、誰が作っているか(会社か個人か)、最近も更新されているか、利用者は多いかを見る。

## 9. 今後の対策

| 対策 | 効果 |
|---|---|
| **Dependabot を有効にする**(10章) | 依存の脆弱性を自動で知らせ、修正の PR を作ってくれる |
| CI で `npm audit --audit-level=high` を実行する | 危ない依存が入ったらビルドを失敗させて気付ける |
| Node.js のバージョンをファイルで決める(`.node-version` を置き、CI は `node-version-file` で読む) | 手元・CI・Docker のバージョンがずれない |
| フレームワークのサポート期限を意識する | 年に1回はメジャーアップデートを検討する |
| GitHub Actions の失敗を通知で受け取る | Quiita のように半年失敗に気付かないことを防ぐ |
| MCP は公式のリモートサーバーを使う。`npx -y` で第三者のパッケージを動かさない | 乗っ取られたパッケージにトークンを盗まれるのを防ぐ |
| トークンを設定ファイルに平文で書かない。使わなくなったら無効にする | 漏れたときの被害を小さくする |

## 10. Dependabot とは

GitHub に最初から入っている、依存パッケージを見張るボット。無料で、非公開のリポジトリでも使える。

| 機能 | 内容 | 有効にする方法 |
|---|---|---|
| Dependabot alerts | `package-lock.json` を GitHub Advisory と照らし合わせ、脆弱性があれば通知・メールで知らせる(`npm audit` の自動版) | Settings → Advanced Security で Enable |
| Dependabot security updates | 修正版に上げる PR を自動で作る(`npm audit fix` の自動版) | 同上 |
| Dependabot version updates | 脆弱性がなくても、新しい版が出たら定期的に PR を作る | `.github/dependabot.yml` を置く |

```yaml
# .github/dependabot.yml の例
version: 2
updates:
  - package-ecosystem: npm
    directory: /            # Product のように複数あるなら /blog、/storlytell のように分ける
    schedule:
      interval: weekly
    groups:
      minor-and-patch:      # 細かい更新は1つの PR にまとめる
        update-types: [minor, patch]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
```

- マージは自動ではない。PR の上で CI が通るか見て、人が判断する。
- PR が増えすぎないよう `groups` でまとめるか、`interval` を長くする。
- GitHub のリポジトリだけが対象。Node.js 本体や CI の `node-version` は見ない。修正版がないものは PR を作れない。

## 11. 残っている作業

| 作業 | 誰が |
|---|---|
| Quiita の `QIITA_TOKEN` を、`read_qiita`・`write_qiita` の権限で作り直して Secret を更新し、「Publish articles」を再実行する | 自分(Qiita と GitHub の画面) |
| 削除した Figma のトークンを、Figma の設定画面で無効にして作り直す | 自分 |
| `~/.claude/settings.json.bak-20261023112415`(Figma のトークン入り)を削除する | 自分 |
| `~/.claude/settings.json` に残っている `notion`(Notion のキー入り)と `mcp-mermaid` の設定を消すか決める(どちらも使われていない) | 相談 |
| storlytell の `docker-compose.yml` を `127.0.0.1` だけで待ち受けにし、パスワードを `.env` に移す | 未対応 |
| 開発用Product/blog の e2e テストのアカウント情報(`E2E_SUPABASE_TEST_*`)を直す | 自分 |
| Product の `.gitignore` の `storlytell/` を見直す | 未対応 |
| storlytell の lint の指摘(18件)を直す | 未対応 |
| 各リポジトリで Dependabot を有効にする | 未対応 |
| Product/blog の公開中のサイトを、ブラウザでログインして表示を確認する | 自分 |
