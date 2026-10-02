// Cloudflare Workers 用 API。画面(dist)は静的アセットとして配信し、/api/* だけをこの Worker で処理する
// セッションは KV(SESSIONS) に保存し、OAuth の state などは短命の Cookie に保存する

const threadsGraph = 'https://graph.threads.net'
const sessionTtl = 86400
const oauthTtl = 600

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.get('cookie') || '').split(';').filter(Boolean).map((cookie) => {
    const [key, ...value] = cookie.trim().split('=')
    return [key, decodeURIComponent(value.join('='))]
  }))
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax; Secure`
}

function json(data, status = 200) {
  return Response.json(data, { status })
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } })
}

// リクエストごとにセッションを読み込み、変更があれば応答時に KV へ書き戻す
async function loadSession(request, env) {
  let id = parseCookies(request).sns_session
  let data = id ? await env.SESSIONS.get(`session:${id}`, 'json') : null
  const isNew = !data
  if (isNew) {
    id = randomHex(24)
    data = {}
  }
  return { id, data, isNew, dirty: isNew }
}

async function finish(session, env, response) {
  if (session.dirty) await env.SESSIONS.put(`session:${session.id}`, JSON.stringify(session.data), { expirationTtl: sessionTtl })
  if (session.isNew) {
    response = new Response(response.body, response)
    response.headers.append('Set-Cookie', cookie('sns_session', session.id, sessionTtl))
  }
  return response
}

function redirectUri(env, request, key, provider) {
  return env[key] || `${new URL(request.url).origin}/api/${provider}/callback`
}

// OAuth 開始時の state/verifier を Cookie に入れてリダイレクトする
function startOAuth(location, oauth) {
  const response = redirect(location)
  response.headers.append('Set-Cookie', cookie('sns_oauth', JSON.stringify({ ...oauth, createdAt: Date.now() }), oauthTtl))
  return response
}

function readOAuth(request, state, provider) {
  try {
    const oauth = JSON.parse(parseCookies(request).sns_oauth || 'null')
    if (!oauth || oauth.state !== state || oauth.provider !== provider || Date.now() - oauth.createdAt > oauthTtl * 1000) return null
    return oauth
  } catch {
    return null
  }
}

function clearOAuth(response) {
  response.headers.append('Set-Cookie', cookie('sns_oauth', '', 0))
  return response
}

// ---- X ----

async function xConnect(request, env) {
  if (!env.X_CLIENT_ID) return json({ error: 'X_CLIENT_IDが設定されていません。' }, 503)
  const state = randomHex(24)
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const codeChallenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))))
  const params = new URLSearchParams({ response_type: 'code', client_id: env.X_CLIENT_ID, redirect_uri: redirectUri(env, request, 'X_REDIRECT_URI', 'x'), scope: 'tweet.read tweet.write users.read offline.access', state, code_challenge: codeChallenge, code_challenge_method: 'S256' })
  return startOAuth(`https://twitter.com/i/oauth2/authorize?${params}`, { provider: 'x', state, codeVerifier })
}

async function xCallback(request, env, session, url) {
  const code = url.searchParams.get('code')
  const oauth = readOAuth(request, url.searchParams.get('state'), 'x')
  if (url.searchParams.get('error') || !code || !oauth) return clearOAuth(redirect('/?x_error=oauth'))
  try {
    const tokenHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' }
    // Confidential client(Web App)ではClient Secretを使ったBasic認証が必要
    if (env.X_CLIENT_SECRET) tokenHeaders.Authorization = `Basic ${btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`
    const tokenResponse = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers: tokenHeaders, body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: env.X_CLIENT_ID, redirect_uri: redirectUri(env, request, 'X_REDIRECT_URI', 'x'), code_verifier: oauth.codeVerifier }) })
    const token = await tokenResponse.json()
    if (!tokenResponse.ok) throw new Error(token.error_description || 'X token exchange failed')
    // 連携時の1回の呼び出しでプロフィールもまとめて取得する
    const userFields = 'profile_image_url,description,public_metrics,created_at,verified,url,location'
    const userResponse = await fetch(`https://api.x.com/2/users/me?user.fields=${userFields}`, { headers: { Authorization: `Bearer ${token.access_token}` } })
    const user = await userResponse.json()
    Object.assign(session.data, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      username: user.data?.username || '',
      name: user.data?.name || '',
      userId: user.data?.id || '',
      profile: user.data ? {
        imageUrl: user.data.profile_image_url || '',
        description: user.data.description || '',
        location: user.data.location || '',
        createdAt: user.data.created_at || '',
        verified: Boolean(user.data.verified),
        metrics: user.data.public_metrics || null,
      } : null,
    })
    session.dirty = true
    return clearOAuth(redirect('/?x_connected=1'))
  } catch (callbackError) {
    console.error(callbackError)
    return clearOAuth(redirect('/?x_error=callback'))
  }
}

async function xGetPosts(session) {
  const data = session.data
  if (!data.accessToken) return json({ error: 'Xアカウントが連携されていません。' }, 401)
  const headers = { Authorization: `Bearer ${data.accessToken}` }
  if (!data.userId) {
    // userIdを保存する前に連携したセッション向け
    const userResponse = await fetch('https://api.x.com/2/users/me', { headers })
    const user = await userResponse.json()
    if (!userResponse.ok) return json({ error: user.detail || user.title || 'アカウント情報の取得に失敗しました。' }, userResponse.status)
    data.userId = user.data.id
    session.dirty = true
  }
  // クレジット消費を抑えるため、最新20件のみ取得する(ページ送りなし)
  const params = new URLSearchParams({ max_results: '20', 'tweet.fields': 'created_at,public_metrics' })
  const xResponse = await fetch(`https://api.x.com/2/users/${data.userId}/tweets?${params}`, { headers })
  const result = await xResponse.json()
  if (!xResponse.ok) return json({ error: result.detail || result.title || '投稿の取得に失敗しました。' }, xResponse.status)
  return json({ posts: result.data || [] })
}

// 予約投稿は予約したアカウントのIDを送ってくる。連携中のアカウントと違えば投稿しない
function accountMismatch(body, data) {
  if (!body?.accountId || !data?.userId || body.accountId === data.userId) return null
  return json({ error: '予約したアカウントと、連携中のアカウントが違います。' }, 409)
}

async function xCreatePost(request, session) {
  if (!session.data.accessToken) return json({ error: 'Xアカウントが連携されていません。' }, 401)
  const body = await request.json().catch(() => null)
  const mismatch = accountMismatch(body, session.data)
  if (mismatch) return mismatch
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text || text.length > 280) return json({ error: '投稿本文は1文字以上280文字以内で入力してください。' }, 400)
  const xResponse = await fetch('https://api.x.com/2/tweets', { method: 'POST', headers: { Authorization: `Bearer ${session.data.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  const result = await xResponse.json()
  if (!xResponse.ok) return json({ error: result.detail || result.title || 'Xへの投稿に失敗しました。' }, xResponse.status)
  return json({ id: result.data.id, text: result.data.text })
}

// ---- Threads ----
// X とは別に session.threads へ保存し、両方を同時に連携できるようにする

async function threadsFetch(path, accessToken, options = {}) {
  const url = new URL(path, threadsGraph)
  url.searchParams.set('access_token', accessToken)
  const threadsResponse = await fetch(url, options)
  const result = await threadsResponse.json()
  if (!threadsResponse.ok) {
    const error = new Error(result.error?.message || 'Threads APIの呼び出しに失敗しました。')
    error.status = threadsResponse.status
    throw error
  }
  return result
}

function threadsError(error, fallback) {
  console.error(error)
  return json({ error: error.message || fallback }, error.status || 500)
}

function threadsConnect(request, env) {
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) return redirect('/?threads_error=config')
  const state = randomHex(24)
  const params = new URLSearchParams({ client_id: env.THREADS_APP_ID, redirect_uri: redirectUri(env, request, 'THREADS_REDIRECT_URI', 'threads'), scope: 'threads_basic,threads_content_publish,threads_manage_insights', response_type: 'code', state })
  return startOAuth(`https://threads.net/oauth/authorize?${params}`, { provider: 'threads', state })
}

async function threadsCallback(request, env, session, url) {
  const code = url.searchParams.get('code')
  const oauth = readOAuth(request, url.searchParams.get('state'), 'threads')
  if (url.searchParams.get('error') || !code || !oauth) return clearOAuth(redirect('/?threads_error=oauth'))
  try {
    const tokenResponse = await fetch(`${threadsGraph}/oauth/access_token`, { method: 'POST', body: new URLSearchParams({ client_id: env.THREADS_APP_ID, client_secret: env.THREADS_APP_SECRET, grant_type: 'authorization_code', redirect_uri: redirectUri(env, request, 'THREADS_REDIRECT_URI', 'threads'), code }) })
    const token = await tokenResponse.json()
    if (!tokenResponse.ok) throw new Error(token.error?.message || 'Threads token exchange failed')
    // 短期トークン(約1時間)を長期トークン(約60日)に交換する
    const longLived = await threadsFetch(`/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(env.THREADS_APP_SECRET)}`, token.access_token)
    const accessToken = longLived.access_token || token.access_token
    const user = await threadsFetch('/v1.0/me?fields=id,username,name,threads_profile_picture_url,threads_biography', accessToken)
    session.data.threads = {
      accessToken,
      userId: user.id,
      username: user.username || '',
      name: user.name || '',
      profile: { imageUrl: user.threads_profile_picture_url || '', description: user.threads_biography || '', location: '', createdAt: '', verified: false, metrics: null },
    }
    session.dirty = true
    return clearOAuth(redirect('/?threads_connected=1'))
  } catch (callbackError) {
    console.error(callbackError)
    return clearOAuth(redirect('/?threads_error=callback'))
  }
}

// 投稿ごとの反応(いいね等)。insightsの権限がない場合は null を返して一覧だけ表示する
async function loadThreadsMetrics(postId, accessToken) {
  try {
    const insights = await threadsFetch(`/v1.0/${postId}/insights?metric=likes,replies,reposts,quotes,views`, accessToken)
    const value = (name) => {
      const metric = insights.data?.find((item) => item.name === name)
      return metric?.values?.[0]?.value ?? metric?.total_value?.value ?? 0
    }
    // 画面側はXと同じ形(public_metrics)で扱う
    return { like_count: value('likes'), reply_count: value('replies'), retweet_count: value('reposts'), quote_count: value('quotes'), view_count: value('views') }
  } catch {
    return null
  }
}

async function threadsGetPosts(session) {
  const threads = session.data.threads
  if (!threads?.accessToken) return json({ error: 'Threadsアカウントが連携されていません。' }, 401)
  try {
    const result = await threadsFetch('/v1.0/me/threads?fields=id,media_type,text,timestamp,permalink&limit=20', threads.accessToken)
    const posts = await Promise.all((result.data || []).map(async (item) => ({
      id: item.id,
      text: item.text || '',
      created_at: item.timestamp,
      permalink: item.permalink,
      public_metrics: await loadThreadsMetrics(item.id, threads.accessToken),
    })))
    return json({ posts })
  } catch (postsError) {
    return threadsError(postsError, '投稿の取得に失敗しました。')
  }
}

async function threadsCreatePost(request, session) {
  const threads = session.data.threads
  if (!threads?.accessToken) return json({ error: 'Threadsアカウントが連携されていません。' }, 401)
  const body = await request.json().catch(() => null)
  const mismatch = accountMismatch(body, threads)
  if (mismatch) return mismatch
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text || text.length > 500) return json({ error: '投稿本文は1文字以上500文字以内で入力してください。' }, 400)
  try {
    // Threadsは「コンテナ作成」→「公開」の2段階で投稿する
    const container = await threadsFetch(`/v1.0/me/threads?${new URLSearchParams({ media_type: 'TEXT', text })}`, threads.accessToken, { method: 'POST' })
    const published = await threadsFetch(`/v1.0/me/threads_publish?creation_id=${container.id}`, threads.accessToken, { method: 'POST' })
    return json({ id: published.id, text })
  } catch (publishError) {
    return threadsError(publishError, 'Threadsへの投稿に失敗しました。')
  }
}

// ---- ルーティング ----

function status(data) {
  return json({ connected: Boolean(data?.accessToken), userId: data?.userId || null, username: data?.username || null, name: data?.name || null, profile: data?.profile || null })
}

async function route(request, env, session, url) {
  const key = `${request.method} ${url.pathname}`
  switch (key) {
    case 'GET /api/x/status': return status(session.data)
    case 'GET /api/x/connect': return xConnect(request, env)
    case 'GET /api/x/callback': return xCallback(request, env, session, url)
    case 'POST /api/x/disconnect':
      for (const field of ['accessToken', 'refreshToken', 'username', 'name', 'profile', 'userId']) delete session.data[field]
      session.dirty = true
      return json({ connected: false })
    case 'GET /api/x/posts': return xGetPosts(session)
    case 'POST /api/x/posts': return xCreatePost(request, session)
    case 'GET /api/threads/status': return status(session.data.threads)
    case 'GET /api/threads/connect': return threadsConnect(request, env)
    case 'GET /api/threads/callback': return threadsCallback(request, env, session, url)
    case 'POST /api/threads/disconnect':
      delete session.data.threads
      session.dirty = true
      return json({ connected: false })
    case 'GET /api/threads/posts': return threadsGetPosts(session)
    case 'POST /api/threads/posts': return threadsCreatePost(request, session)
    default: return json({ error: 'Not Found' }, 404)
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    const session = await loadSession(request, env)
    return finish(session, env, await route(request, env, session, url))
  },
}
