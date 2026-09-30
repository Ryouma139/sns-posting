# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:


## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

# X投稿ダッシュボード

React + Viteの画面とExpressのAPIサーバーで構成されたX自動投稿ダッシュボードです。

## X APIの設定

1. X Developer PortalでOAuth 2.0のアプリを作成します。
2. `.env.example`を`.env`へコピーします。
3. `X_CLIENT_ID`にXアプリのClient IDを設定します。
4. XアプリのCallback URI / Redirect URLに次を登録します。

```text
http://localhost:3000/api/x/callback
```

`.env`の例:

```env
X_CLIENT_ID=your-client-id
X_REDIRECT_URI=http://localhost:3000/api/x/callback
PORT=3000
```

アクセストークンはブラウザへ返さず、サーバー側のHttpOnly Cookieに紐づくセッションで管理します。

## 起動

```powershell
npm install
npm run dev
```

画面は `http://localhost:5173/`、APIサーバーは `http://localhost:3000/` で起動します。

## 検証

```powershell
npm run build
npm run lint
```

## ファイル構成

```text
SNS_posting/
├─ index.html
├─ package.json
├─ package-lock.json
├─ vite.config.js
├─ server.js
├─ .env.example
├─ .gitignore
├─ .oxlintrc.json
├─ README.md
├─ public/
├─ src/
│  ├─ main.jsx
│  ├─ App.jsx
│  ├─ App.css
│  ├─ index.css
│  └─ assets/
├─ dist/
└─ node_modules/
```

## 各ファイルの役割

### `index.html`

ReactアプリのHTML入口です。`src/main.jsx`を読み込み、React画面を表示します。

### `src/main.jsx`

Reactアプリを起動し、`src/App.jsx`を`index.html`の`root`要素へ表示します。また、`src/index.css`も読み込みます。

### `src/App.jsx`

X投稿ダッシュボード本体です。アカウント連携、投稿入力、プレビュー、投稿ボタン、接続状態の表示を担当します。

画面から次のAPIを呼び出します。

```text
/api/x/status
/api/x/connect
/api/x/disconnect
/api/x/posts
```

### `src/App.css`

サイドバー、投稿カード、ボタン、配色、レスポンシブ表示など、ダッシュボードの見た目を定義します。

### `src/index.css`

ページ全体の基本スタイルを定義します。

### `server.js`

Expressによるバックエンドです。X OAuth 2.0 PKCE認証、Callback URLの処理、アクセストークン管理、X APIへの投稿を担当します。

アクセストークンをブラウザ側のReactコードに置かず、サーバー側で扱うために必要なファイルです。

### `package.json`

依存パッケージと実行コマンドを管理します。`npm run dev`では、`server.js`とViteを同時に起動します。

```text
npm run dev
├─ node server.js  → localhost:3000
└─ vite            → localhost:5173
```

### `package-lock.json`

インストールしたnpmパッケージの正確なバージョンを記録します。通常は手動編集しません。

### `vite.config.js`

Viteの設定ファイルです。`/api`から始まるリクエストを、`server.js`が動作する`http://localhost:3000`へ転送します。

```text
React
	↓ /api/x/posts
Viteのプロキシ
	↓ http://localhost:3000/api/x/posts
server.js
	↓
X API
```

### `.env.example`

X API接続に必要な環境変数の見本です。コピーして`.env`を作成します。

### `.gitignore`

`.env`、`node_modules`、`dist`など、Gitへ登録しないファイルを指定します。

### `.oxlintrc.json`

`npm run lint`で使用するOxlintの設定ファイルです。

### `README.md`

X APIの設定、起動方法、検証方法、プロジェクト構成を説明するドキュメントです。

### `public/`

そのまま公開する静的ファイルを置くディレクトリです。

### `node_modules/`

`npm install`で生成される依存パッケージのディレクトリです。通常はGitへ登録しません。

### `dist/`

`npm run build`で生成される本番用ファイルです。開発時は`src`を編集し、`dist`は直接編集しません。

## ファイルの関連図

```text
index.html
	↓
src/main.jsx
	↓
src/App.jsx
	├─ src/App.css
	├─ src/index.css
	└─ /apiへfetch
			 ↓
		vite.config.jsのproxy
			 ↓
		server.js
			 ↓
		X API
```

`src`が画面、`server.js`がX APIとの接続、`dist`が本番用の生成物という役割分担です。
