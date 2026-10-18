// Cloudflare Workers 用 API。画面(dist)は静的アセットとして配信し、/api/* だけをこの Worker で処理する
// セッションは KV(SESSIONS) に保存し、OAuth の state などは短命の Cookie に保存する
// 予約投稿は D1(DB) に保存し、Cron Trigger(scheduled)で投稿する。画像は R2(MEDIA) に保存する

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
  const params = new URLSearchParams({ response_type: 'code', client_id: env.X_CLIENT_ID, redirect_uri: redirectUri(env, request, 'X_REDIRECT_URI', 'x'), scope: 'tweet.read tweet.write users.read media.write offline.access', state, code_challenge: codeChallenge, code_challenge_method: 'S256' })
  return startOAuth(`https://x.com/i/oauth2/authorize?${params}`, { provider: 'x', state, codeVerifier })
}

function xTokenHeaders(env) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  // Confidential client(Web App)ではClient Secretを使ったBasic認証が必要
  if (env.X_CLIENT_SECRET) headers.Authorization = `Basic ${btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`
  return headers
}

async function xCallback(request, env, session, url) {
  const code = url.searchParams.get('code')
  const oauth = readOAuth(request, url.searchParams.get('state'), 'x')
  if (url.searchParams.get('error') || !code || !oauth) return clearOAuth(redirect('/?x_error=oauth'))
  try {
    const tokenResponse = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers: xTokenHeaders(env), body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: env.X_CLIENT_ID, redirect_uri: redirectUri(env, request, 'X_REDIRECT_URI', 'x'), code_verifier: oauth.codeVerifier }) })
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
    // 予約投稿はセッションが切れても投稿できるよう、トークンをアカウントごとに DB にも保存する
    if (session.data.userId) await saveAccount(env, 'x', { ...session.data, expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null }, true).catch((saveError) => console.error(saveError))
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

// ---- 添付画像 ----
// 画像付きの投稿・予約は multipart/form-data(text, accountId, topicTag, images。予約は platform, scheduledAt も)、
// テキストだけなら JSON で受け取る
const maxImages = 4
const maxImageBytes = 5 * 1024 * 1024
const imageTypes = ['image/jpeg', 'image/png']
const postFields = ['text', 'accountId', 'topicTag', 'platform', 'scheduledAt', 'migrated']

async function readPostBody(request) {
  if (!(request.headers.get('content-type') || '').includes('multipart/form-data')) {
    const body = await request.json().catch(() => null)
    return { ...Object.fromEntries(postFields.map((field) => [field, body?.[field]])), images: [] }
  }
  const form = await request.formData().catch(() => null)
  if (!form) return null
  return { ...Object.fromEntries(postFields.map((field) => [field, form.get(field) ?? undefined])), images: form.getAll('images').filter((item) => typeof item !== 'string') }
}

// Threads のトピックタグ(1投稿に1つ)。本文に「#」で書くと本文にも残るため、topic_tag で別に送る
// 1〜50文字、ピリオドとアンパサンドは使えない。先頭の # は付けても外す
function validateTopicTag(value) {
  const tag = typeof value === 'string' ? value.trim().replace(/^#+/, '') : ''
  if (!tag) return { tag: '' }
  if (tag.length > 50 || /[.&]/.test(tag)) return { error: json({ error: 'タグは50文字以内で、「.」と「&」は使えません。' }, 400) }
  return { tag }
}

// 本文と画像を確認し、問題があればエラーの Response を返す
function validatePost(body, maxLength) {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (text.length > maxLength) return { error: json({ error: `投稿本文は${maxLength}文字以内で入力してください。` }, 400) }
  if (!text && body.images.length === 0) return { error: json({ error: '投稿本文か画像を入力してください。' }, 400) }
  if (body.images.length > maxImages) return { error: json({ error: `画像は${maxImages}枚までです。` }, 400) }
  if (body.images.some((image) => !imageTypes.includes(image.type))) return { error: json({ error: '画像は JPEG か PNG にしてください。' }, 400) }
  if (body.images.some((image) => image.size > maxImageBytes)) return { error: json({ error: '画像は1枚5MBまでです。' }, 400) }
  return { text }
}

async function xUploadImage(image, accessToken) {
  const form = new FormData()
  form.append('media', image, image.name || 'image')
  form.append('media_category', 'tweet_image')
  const uploadResponse = await fetch('https://api.x.com/2/media/upload', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: form })
  const result = await uploadResponse.json().catch(() => ({}))
  if (!uploadResponse.ok || !result.data?.id) {
    // media.write を追加する前に連携したトークンでは 403 になる
    const hint = uploadResponse.status === 403 ? '(画像の投稿には連携し直しが必要です)' : ''
    const error = new Error(`${result.detail || result.title || '画像のアップロードに失敗しました。'}${hint}`)
    error.status = uploadResponse.status
    throw error
  }
  return result.data.id
}

async function xCreatePost(request, session) {
  if (!session.data.accessToken) return json({ error: 'Xアカウントが連携されていません。' }, 401)
  const body = await readPostBody(request)
  if (!body) return json({ error: '投稿内容を読み取れませんでした。' }, 400)
  const mismatch = accountMismatch(body, session.data)
  if (mismatch) return mismatch
  const { text, error } = validatePost(body, 280)
  if (error) return error
  const tweet = text ? { text } : {}
  try {
    // 画像は先にアップロードし、返ってきた media_id を投稿に付ける(アップロードもクレジットを消費する)
    if (body.images.length) tweet.media = { media_ids: await Promise.all(body.images.map((image) => xUploadImage(image, session.data.accessToken))) }
    const posted = await xTweet(session.data.accessToken, tweet)
    return json({ id: posted.id, text: posted.text || text })
  } catch (postError) {
    console.error(postError)
    return json({ error: postError.message }, postError.status || 500)
  }
}

async function xTweet(accessToken, tweet) {
  const xResponse = await fetch('https://api.x.com/2/tweets', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tweet) })
  const result = await xResponse.json().catch(() => ({}))
  if (!xResponse.ok || !result.data?.id) {
    const error = new Error(result.detail || result.title || 'Xへの投稿に失敗しました。')
    error.status = xResponse.ok ? 502 : xResponse.status
    throw error
  }
  return result.data
}

// ---- Threads ----
// X とは別に session.threads へ保存し、両方を同時に連携できるようにする

// ---- Threads API の呼び出し回数 ----
// このアプリから呼んだ回数を種類ごとに数え、リクエストの最後に KV へまとめて保存する(書き込みは1リクエスト1回)
// KV のキー: threads-calls:{ユーザーID} = { hours: { 'YYYY-MM-DDTHH': { 種類: 回数 } }, appUsage }
const callKeepHours = 48

function callCategory(path, method = 'GET') {
  if (path.includes('access_token')) return 'auth'
  if (path.includes('/insights')) return 'insights'
  if (path.includes('fields=status')) return 'publish'
  if (path.includes('threads_insights') || path.includes('threads_publishing_limit')) return 'usage'
  if (path.includes('keyword_search')) return 'search'
  if (path.includes('threads_publish') || (method === 'POST' && path.includes('/threads'))) return 'publish'
  if (path.includes('/threads')) return 'posts'
  return 'profile'
}

function countThreadsCall(session, category, response) {
  const calls = session.threadsCalls ||= { counts: {}, appUsage: null }
  calls.counts[category] = (calls.counts[category] || 0) + 1
  // 呼び出しが多くなると Meta が上限に対する使用率(%)を返す
  const header = response?.headers.get('x-app-usage')
  if (header) {
    try {
      calls.appUsage = { ...JSON.parse(header), at: new Date().toISOString() }
    } catch {
      // 形式が違えば無視する
    }
  }
}

const hourKey = (date) => date.toISOString().slice(0, 13)

async function readThreadsCalls(env, userId) {
  if (!userId) return { hours: {}, appUsage: null }
  const stored = await env.SESSIONS.get(`threads-calls:${userId}`, 'json').catch(() => null)
  return stored || { hours: {}, appUsage: null }
}

// 保存済みの回数に、このリクエストで呼んだ回数を足す(古い時間帯は捨てる)
function mergeThreadsCalls(record, session) {
  const calls = session.threadsCalls
  if (!calls) return record
  const hours = { ...record.hours }
  const now = hourKey(new Date())
  hours[now] = { ...hours[now] }
  for (const [category, count] of Object.entries(calls.counts)) hours[now][category] = (hours[now][category] || 0) + count
  const oldest = hourKey(new Date(Date.now() - callKeepHours * 3600 * 1000))
  for (const key of Object.keys(hours)) if (key < oldest) delete hours[key]
  return { hours, appUsage: calls.appUsage || record.appUsage }
}

async function saveThreadsCalls(session, env) {
  const userId = session.data.threads?.userId
  if (!session.threadsCalls || !userId) return
  const record = mergeThreadsCalls(await readThreadsCalls(env, userId), session)
  await env.SESSIONS.put(`threads-calls:${userId}`, JSON.stringify(record), { expirationTtl: 3 * 86400 })
}

// 直近24時間の合計と種類ごとの内訳
function summarizeThreadsCalls(record) {
  const since = hourKey(new Date(Date.now() - 23 * 3600 * 1000))
  const byCategory = {}
  for (const [key, counts] of Object.entries(record.hours)) {
    if (key < since) continue
    for (const [category, count] of Object.entries(counts)) byCategory[category] = (byCategory[category] || 0) + count
  }
  return { total: Object.values(byCategory).reduce((sum, count) => sum + count, 0), byCategory }
}

async function threadsFetch(session, path, accessToken, options = {}) {
  const url = new URL(path, threadsGraph)
  url.searchParams.set('access_token', accessToken)
  const threadsResponse = await fetch(url, options)
  countThreadsCall(session, callCategory(path, options.method), threadsResponse)
  const result = await threadsResponse.json()
  if (!threadsResponse.ok) {
    const error = new Error(result.error?.message || 'Threads APIの呼び出しに失敗しました。')
    error.status = threadsResponse.status
    // 原因の調査用に、Meta が返したエラーの種類とコードを残す(トークンは含まない)
    error.detail = { path: url.pathname, status: threadsResponse.status, type: result.error?.type, code: result.error?.code, subcode: result.error?.error_subcode, fbtrace_id: result.error?.fbtrace_id }
    console.error('Threads API error', JSON.stringify(error.detail))
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
  const params = new URLSearchParams({ client_id: env.THREADS_APP_ID, redirect_uri: redirectUri(env, request, 'THREADS_REDIRECT_URI', 'threads'), scope: 'threads_basic,threads_content_publish,threads_manage_insights,threads_keyword_search', response_type: 'code', state })
  return startOAuth(`https://threads.net/oauth/authorize?${params}`, { provider: 'threads', state })
}

async function threadsCallback(request, env, session, url) {
  const code = url.searchParams.get('code')
  const oauth = readOAuth(request, url.searchParams.get('state'), 'threads')
  if (url.searchParams.get('error') || !code || !oauth) return clearOAuth(redirect('/?threads_error=oauth'))
  try {
    const tokenResponse = await fetch(`${threadsGraph}/oauth/access_token`, { method: 'POST', body: new URLSearchParams({ client_id: env.THREADS_APP_ID, client_secret: env.THREADS_APP_SECRET, grant_type: 'authorization_code', redirect_uri: redirectUri(env, request, 'THREADS_REDIRECT_URI', 'threads'), code }) })
    countThreadsCall(session, 'auth', tokenResponse)
    const token = await tokenResponse.json()
    if (!tokenResponse.ok) throw new Error(token.error?.message || 'Threads token exchange failed')
    // 短期トークン(約1時間)を長期トークン(約60日)に交換する
    const longLived = await threadsFetch(session, `/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(env.THREADS_APP_SECRET)}`, token.access_token)
    const accessToken = longLived.access_token || token.access_token
    const user = await threadsFetch(session, '/v1.0/me?fields=id,username,name,threads_profile_picture_url,threads_biography', accessToken)
    session.data.threads = {
      accessToken,
      userId: user.id,
      username: user.username || '',
      name: user.name || '',
      profile: { imageUrl: user.threads_profile_picture_url || '', description: user.threads_biography || '', location: '', createdAt: '', verified: false, metrics: null },
    }
    session.dirty = true
    // 予約投稿用(X と同じ)。長期トークンは約60日で切れる
    await saveAccount(env, 'threads', { ...session.data.threads, expiresAt: longLived.expires_in ? Date.now() + longLived.expires_in * 1000 : null }, true).catch((saveError) => console.error(saveError))
    return clearOAuth(redirect('/?threads_connected=1'))
  } catch (callbackError) {
    console.error(callbackError)
    return clearOAuth(redirect('/?threads_error=callback'))
  }
}

// 投稿ごとの反応(いいね等)。insightsの権限がない場合は null を返して一覧だけ表示する
async function loadThreadsMetrics(session, postId, accessToken) {
  try {
    const insights = await threadsFetch(session, `/v1.0/${postId}/insights?metric=likes,replies,reposts,quotes,views`, accessToken)
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
    const result = await threadsFetch(session, '/v1.0/me/threads?fields=id,media_type,text,timestamp,permalink&limit=20', threads.accessToken)
    const posts = await Promise.all((result.data || []).map(async (item) => ({
      id: item.id,
      text: item.text || '',
      created_at: item.timestamp,
      permalink: item.permalink,
      public_metrics: await loadThreadsMetrics(session, item.id, threads.accessToken),
    })))
    return json({ posts })
  } catch (postsError) {
    return threadsError(postsError, '投稿の取得に失敗しました。')
  }
}

// Threads は画像を URL で受け取り、Meta のサーバーが取りに来る。
// そのため画像を R2(MEDIA)に保存し、/api/media/{ID} で公開する(Cloudflare Access の Bypass が必要)
// 予約投稿の画像も R2 に置き、X へは予定時刻に R2 から読んでアップロードする
// R2 には期限がないため、投稿し終わったら(予約なら投稿済み・削除のときに)消す
async function storeMedia(env, image) {
  if (!env.MEDIA) {
    const error = new Error('画像の保存先(R2)が設定されていません。')
    error.status = 503
    throw error
  }
  const id = randomHex(16)
  await env.MEDIA.put(`media/${id}`, image, { httpMetadata: { contentType: image.type } })
  return id
}

async function loadMedia(env, id) {
  const object = await env.MEDIA?.get(`media/${id}`)
  if (!object) throw new Error('予約した画像が見つかりませんでした。')
  return new File([await object.arrayBuffer()], id, { type: object.httpMetadata?.contentType || 'image/jpeg' })
}

async function deleteMedia(env, ids) {
  if (ids.length) await env.MEDIA?.delete(ids.map((id) => `media/${id}`)).catch((deleteError) => console.error(deleteError))
}

const mediaUrl = (origin, id) => `${origin}/api/media/${id}`

// localhost の画像は Meta から取りに来られない
const isLocalOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)
const localImageError = 'Threadsへの画像付き投稿は本番環境でのみ使えます(Metaがlocalhostの画像を取得できないため)。'

async function serveMedia(env, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response('Not Found', { status: 404 })
  const object = await env.MEDIA?.get(`media/${id}`)
  if (!object) return new Response('Not Found', { status: 404 })
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' } })
}

// 画像のコンテナは Meta が画像を取り込むまで公開できないため、FINISHED になるまで待つ
async function waitForThreadsContainer(session, id, accessToken) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const container = await threadsFetch(session, `/v1.0/${id}?fields=status,error_message`, accessToken)
    if (container.status === 'FINISHED' || container.status === 'PUBLISHED') return
    if (container.status === 'ERROR' || container.status === 'EXPIRED') throw new Error(`Threadsが画像を処理できませんでした。${container.error_message || ''}`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error('Threadsの画像の処理が時間内に終わりませんでした。')
}

// Threadsは「コンテナ作成」→「公開」の2段階で投稿する。画像が2枚以上ならカルーセルにする(今すぐ投稿と予約投稿で共通)
// 本文とタグ(caption)は、カルーセルなら全体のコンテナにだけ付ける
async function threadsPublish(session, accessToken, caption, imageUrls) {
  const create = (params) => threadsFetch(session, `/v1.0/me/threads?${new URLSearchParams(params)}`, accessToken, { method: 'POST' })
  let container
  if (imageUrls.length === 0) {
    container = await create({ media_type: 'TEXT', ...caption })
  } else if (imageUrls.length === 1) {
    container = await create({ media_type: 'IMAGE', image_url: imageUrls[0], ...caption })
    await waitForThreadsContainer(session, container.id, accessToken)
  } else {
    const items = []
    for (const imageUrl of imageUrls) items.push(await create({ media_type: 'IMAGE', image_url: imageUrl, is_carousel_item: 'true' }))
    for (const item of items) await waitForThreadsContainer(session, item.id, accessToken)
    container = await create({ media_type: 'CAROUSEL', children: items.map((item) => item.id).join(','), ...caption })
    await waitForThreadsContainer(session, container.id, accessToken)
  }
  return (await threadsFetch(session, `/v1.0/me/threads_publish?creation_id=${container.id}`, accessToken, { method: 'POST' })).id
}

async function threadsCreatePost(request, env, session) {
  const threads = session.data.threads
  if (!threads?.accessToken) return json({ error: 'Threadsアカウントが連携されていません。' }, 401)
  const body = await readPostBody(request)
  if (!body) return json({ error: '投稿内容を読み取れませんでした。' }, 400)
  const mismatch = accountMismatch(body, threads)
  if (mismatch) return mismatch
  const { text, error } = validatePost(body, 500)
  if (error) return error
  const topic = validateTopicTag(body.topicTag)
  if (topic.error) return topic.error
  // 本文とタグは、カルーセルなら全体のコンテナにだけ付ける
  const caption = { ...(text ? { text } : {}), ...(topic.tag ? { topic_tag: topic.tag } : {}) }
  const origin = new URL(request.url).origin
  if (body.images.length && isLocalOrigin(origin)) return json({ error: localImageError }, 400)
  const mediaIds = []
  try {
    for (const image of body.images) mediaIds.push(await storeMedia(env, image))
    return json({ id: await threadsPublish(session, threads.accessToken, caption, mediaIds.map((id) => mediaUrl(origin, id))), text })
  } catch (publishError) {
    return threadsError(publishError, 'Threadsへの投稿に失敗しました。')
  } finally {
    // 公開まで終われば Meta は画像を取り込み済み
    await deleteMedia(env, mediaIds)
  }
}

// ---- ルーティング ----

// キーワード検索(threads_keyword_search)。審査前は自分の投稿しか返らない
const searchPeriods = { '1d': 86400, '7d': 7 * 86400, '30d': 30 * 86400 }

async function threadsSearch(session, url) {
  const threads = session.data.threads
  if (!threads?.accessToken) return json({ error: 'Threadsアカウントが連携されていません。' }, 401)
  const q = (url.searchParams.get('q') || '').trim()
  if (!q || q.length > 100) return json({ error: 'キーワードは1文字以上100文字以内で入力してください。' }, 400)
  // TOP = Threads が人気と判断した順、RECENT = 新着順
  const searchType = url.searchParams.get('type') === 'RECENT' ? 'RECENT' : 'TOP'
  const params = new URLSearchParams({ q, search_type: searchType, fields: 'id,text,username,permalink,timestamp,media_type', limit: '25' })
  const period = searchPeriods[url.searchParams.get('period')]
  if (period) params.set('since', String(Math.floor(Date.now() / 1000) - period))
  try {
    const result = await threadsFetch(session, `/v1.0/keyword_search?${params}`, threads.accessToken)
    const posts = (result.data || []).map((item) => ({ id: item.id, text: item.text || '', username: item.username || '', permalink: item.permalink || '', created_at: item.timestamp, mediaType: item.media_type || '' }))
    return json({ posts })
  } catch (searchError) {
    return threadsError(searchError, '検索に失敗しました。')
  }
}

// 投稿・返信の上限と、直近24時間の消費数(Threads の threads_publishing_limit)
async function threadsGetUsage(session, env) {
  const threads = session.data.threads
  if (!threads?.accessToken) return json({ error: 'Threadsアカウントが連携されていません。' }, 401)
  const path = (fields) => `/v1.0/${threads.userId || 'me'}/threads_publishing_limit?fields=${fields}`
  try {
    let result
    try {
      result = await threadsFetch(session, path('quota_usage,config,reply_quota_usage,reply_config'), threads.accessToken)
    } catch {
      // 返信の項目が取れない場合は、投稿の項目だけで取り直す
      result = await threadsFetch(session, path('quota_usage,config'), threads.accessToken)
    }
    const limit = result.data?.[0] || {}
    const quota = (usage, config) => (config ? { used: usage ?? 0, total: config.quota_total ?? null, durationSeconds: config.quota_duration ?? null } : null)
    // API呼び出しの上限 = 4,800 × 直近24時間の表示回数(10未満は10として計算)
    let callLimit = null
    try {
      const now = Math.floor(Date.now() / 1000)
      const views = await threadsFetch(session, `/v1.0/${threads.userId || 'me'}/threads_insights?metric=views&since=${now - 86400}&until=${now}`, threads.accessToken)
      const metric = views.data?.[0]
      const impressions = metric?.total_value?.value ?? (metric?.values || []).reduce((sum, item) => sum + (item.value || 0), 0)
      callLimit = { impressions, total: 4800 * Math.max(impressions, 10) }
    } catch {
      // 表示回数が取れなければ上限は出さない
    }
    const record = mergeThreadsCalls(await readThreadsCalls(env, threads.userId), session)
    return json({
      posts: quota(limit.quota_usage, limit.config),
      replies: quota(limit.reply_quota_usage, limit.reply_config),
      calls: summarizeThreadsCalls(record),
      callLimit,
      appUsage: record.appUsage,
      checkedAt: new Date().toISOString(),
    })
  } catch (usageError) {
    return threadsError(usageError, 'API利用状況の取得に失敗しました。')
  }
}

// ---- 予約投稿(自動) ----
// 予約は D1(DB)に保存し、Cron Trigger(毎分)で予定時刻を過ぎたものを投稿する
// KV ではなく D1 にしたのは、書き込みがすぐ読める(二重投稿を防げる)ため。KV は反映に最大60秒かかる
// ブラウザのセッション(24時間)が切れても投稿できるよう、投稿に使うトークンをアカウントごとに accounts に保存する
const schema = [
  'CREATE TABLE IF NOT EXISTS accounts (platform TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, access_token TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (platform, user_id))',
  "CREATE TABLE IF NOT EXISTS scheduled_posts (id TEXT PRIMARY KEY, platform TEXT NOT NULL, account_id TEXT NOT NULL, account_username TEXT, text TEXT NOT NULL, topic_tag TEXT, scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', posted_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  'CREATE INDEX IF NOT EXISTS scheduled_posts_due ON scheduled_posts (status, scheduled_at)',
]
// あとから足した列(すでにあるテーブルには ALTER TABLE で追加する)
// images: 予約の画像 { origin, ids }(JSON)。画像は R2 の media/{ID}。origin は Threads に渡す URL を作るため
const addedColumns = { scheduled_posts: { images: 'TEXT' } }
// マイグレーションのコマンドを使わずに済むよう、Worker が起動して最初に使うときにテーブルを作る
let schemaReady = false
const scheduleMaxPerRun = 10
const stuckMs = 10 * 60 * 1000
const postedKeepMs = 7 * 86400 * 1000

async function ensureSchema(env) {
  if (!env.DB) {
    const error = new Error('予約投稿のデータベース(DB)が設定されていません。')
    error.status = 503
    throw error
  }
  if (schemaReady) return
  await env.DB.batch(schema.map((sql) => env.DB.prepare(sql)))
  for (const [table, columns] of Object.entries(addedColumns)) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all()
    for (const [column, type] of Object.entries(columns)) {
      if (!results.some((item) => item.name === column)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run()
    }
  }
  schemaReady = true
}

// 連携したときは上書きし、予約したときは(DB に保存する前に連携したセッション向けに)なければ追加する
async function saveAccount(env, platform, account, overwrite) {
  await ensureSchema(env)
  await env.DB.prepare(`INSERT OR ${overwrite ? 'REPLACE' : 'IGNORE'} INTO accounts (platform, user_id, username, access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(platform, account.userId, account.username || '', account.accessToken, account.refreshToken || null, account.expiresAt || null, new Date().toISOString()).run()
}

function scheduleImages(row) {
  try {
    return row.images ? JSON.parse(row.images) : null
  } catch {
    return null
  }
}

function scheduleItem(row) {
  return { id: row.id, platform: row.platform, accountId: row.account_id, accountUsername: row.account_username || '', text: row.text, topicTag: row.topic_tag || '', imageCount: scheduleImages(row)?.ids.length || 0, scheduledAt: row.scheduled_at, status: row.status, postedId: row.posted_id || '', error: row.error || '', createdAt: row.created_at, updatedAt: row.updated_at }
}

async function listSchedules(env) {
  await ensureSchema(env)
  const { results } = await env.DB.prepare('SELECT * FROM scheduled_posts ORDER BY scheduled_at').all()
  return json({ schedules: results.map(scheduleItem) })
}

async function createSchedule(request, env, session) {
  const body = await readPostBody(request)
  const platform = body?.platform
  const account = platform === 'x' ? session.data : platform === 'threads' ? session.data.threads : null
  if (!account?.accessToken) return json({ error: '予約するにはアカウントを連携してください。' }, 401)
  if (!account.userId) return json({ error: 'アカウント情報が足りません。連携し直してください。' }, 400)
  const { text, error } = validatePost(body, platform === 'x' ? 280 : 500)
  if (error) return error
  const origin = new URL(request.url).origin
  if (platform === 'threads' && body.images.length && isLocalOrigin(origin)) return json({ error: localImageError }, 400)
  const topic = platform === 'threads' ? validateTopicTag(body.topicTag) : { tag: '' }
  if (topic.error) return topic.error
  const scheduledAt = new Date(body.scheduledAt)
  if (Number.isNaN(scheduledAt.getTime())) return json({ error: '予約日時を読み取れませんでした。' }, 400)
  // ブラウザに保存していた予約を移すとき、予定時刻を過ぎていたものは自動では投稿せず「失敗」として残す
  const overdue = scheduledAt <= new Date()
  if (overdue && !body.migrated) return json({ error: '予約日時は現在より後の日時を指定してください。' }, 400)
  await saveAccount(env, platform, account, false)
  const mediaIds = []
  try {
    for (const image of body.images) mediaIds.push(await storeMedia(env, image))
    const now = new Date().toISOString()
    const row = { id: randomHex(16), platform, account_id: account.userId, account_username: account.username || '', text, topic_tag: topic.tag, images: mediaIds.length ? JSON.stringify({ origin, ids: mediaIds }) : null, scheduled_at: scheduledAt.toISOString(), status: overdue ? 'failed' : 'pending', posted_id: null, error: overdue ? '自動投稿を始める前に予定時刻を過ぎていました。' : null, created_at: now, updated_at: now }
    await env.DB.prepare('INSERT INTO scheduled_posts (id, platform, account_id, account_username, text, topic_tag, images, scheduled_at, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.platform, row.account_id, row.account_username, row.text, row.topic_tag, row.images, row.scheduled_at, row.status, row.error, row.created_at, row.updated_at).run()
    return json({ schedule: scheduleItem(row) })
  } catch (scheduleError) {
    // 予約を保存できなければ、先に保存した画像を消す
    await deleteMedia(env, mediaIds)
    throw scheduleError
  }
}

async function deleteSchedule(env, id) {
  await ensureSchema(env)
  const deleted = await env.DB.prepare("DELETE FROM scheduled_posts WHERE id = ? AND status != 'posting' RETURNING images").bind(id).first()
  if (!deleted && await env.DB.prepare('SELECT id FROM scheduled_posts WHERE id = ?').bind(id).first()) return json({ error: '投稿中のため削除できません。少し待ってから更新してください。' }, 409)
  if (deleted) await deleteMedia(env, scheduleImages(deleted)?.ids || [])
  return json({ deleted: true })
}

// X のアクセストークンは約2時間で切れる。切れていれば refresh_token で更新する(refresh_token も新しくなる)
async function xAccessToken(env, account) {
  if (account.expires_at && account.expires_at > Date.now() + 60 * 1000) return account.access_token
  if (!account.refresh_token) throw new Error('Xのトークンを更新できません。Xアカウントを連携し直してください。')
  const tokenResponse = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers: xTokenHeaders(env), body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refresh_token, client_id: env.X_CLIENT_ID }) })
  const token = await tokenResponse.json().catch(() => ({}))
  if (!tokenResponse.ok || !token.access_token) throw new Error(`Xのトークンを更新できませんでした(${token.error_description || tokenResponse.status})。Xアカウントを連携し直してください。`)
  await env.DB.prepare("UPDATE accounts SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE platform = 'x' AND user_id = ?")
    .bind(token.access_token, token.refresh_token || account.refresh_token, Date.now() + (token.expires_in || 7200) * 1000, new Date().toISOString(), account.user_id).run()
  return token.access_token
}

// Threads の長期トークンは約60日。残りが7日を切ったら更新する(更新できなければ今のトークンで投稿する)
async function threadsAccessToken(env, session, account) {
  if (!account.expires_at || account.expires_at > Date.now() + 7 * 86400 * 1000) return account.access_token
  if (account.expires_at <= Date.now()) throw new Error('Threadsのトークンの期限(約60日)が切れています。Threadsアカウントを連携し直してください。')
  try {
    const refreshed = await threadsFetch(session, '/refresh_access_token?grant_type=th_refresh_token', account.access_token)
    await env.DB.prepare("UPDATE accounts SET access_token = ?, expires_at = ?, updated_at = ? WHERE platform = 'threads' AND user_id = ?")
      .bind(refreshed.access_token, Date.now() + (refreshed.expires_in || 5184000) * 1000, new Date().toISOString(), account.user_id).run()
    return refreshed.access_token
  } catch (refreshError) {
    console.error(refreshError)
    return account.access_token
  }
}

// 画像は R2 にあり、X へは R2 から読んでアップロードし、Threads へは /api/media/{ID} の URL を渡す
async function publishSchedule(env, row) {
  const account = await env.DB.prepare('SELECT * FROM accounts WHERE platform = ? AND user_id = ?').bind(row.platform, row.account_id).first()
  if (!account) throw new Error(`@${row.account_username} の連携情報がありません。このアカウントを連携し直してから「今すぐ投稿」を押してください。`)
  const media = scheduleImages(row)
  if (row.platform === 'x') {
    const accessToken = await xAccessToken(env, account)
    const tweet = row.text ? { text: row.text } : {}
    if (media) tweet.media = { media_ids: await Promise.all(media.ids.map(async (id) => xUploadImage(await loadMedia(env, id), accessToken))) }
    return (await xTweet(accessToken, tweet)).id
  }
  // API利用状況の画面の呼び出し回数にも数える
  const session = { data: { threads: { userId: account.user_id } } }
  try {
    const accessToken = await threadsAccessToken(env, session, account)
    const caption = { ...(row.text ? { text: row.text } : {}), ...(row.topic_tag ? { topic_tag: row.topic_tag } : {}) }
    return await threadsPublish(session, accessToken, caption, media ? media.ids.map((id) => mediaUrl(media.origin, id)) : [])
  } finally {
    await saveThreadsCalls(session, env).catch((saveError) => console.error(saveError))
  }
}

// 二重投稿を防ぐため、先に status を posting にできたときだけ投稿する(D1 は書き込みがすぐ反映される)
async function runSchedule(env, id, fromStatuses) {
  const claimed = await env.DB.prepare(`UPDATE scheduled_posts SET status = 'posting', error = NULL, updated_at = ? WHERE id = ? AND status IN (${fromStatuses.map(() => '?').join(', ')}) RETURNING *`)
    .bind(new Date().toISOString(), id, ...fromStatuses).first()
  if (!claimed) return null
  let result
  try {
    result = { status: 'posted', posted_id: String(await publishSchedule(env, claimed)), error: null }
  } catch (postError) {
    console.error(postError)
    result = { status: 'failed', posted_id: null, error: postError.message || '投稿に失敗しました。' }
  }
  const updatedAt = new Date().toISOString()
  await env.DB.prepare('UPDATE scheduled_posts SET status = ?, posted_id = ?, error = ?, updated_at = ? WHERE id = ?').bind(result.status, result.posted_id, result.error, updatedAt, id).run()
  // 投稿できた画像は消す(失敗したものは「もう一度投稿」のために残す)
  if (result.status === 'posted') await deleteMedia(env, scheduleImages(claimed)?.ids || [])
  return { ...claimed, ...result, updated_at: updatedAt }
}

// 一覧の「今すぐ投稿」。予約していたアカウントのトークンで投稿する(連携中のアカウントは関係ない)
async function postScheduleNow(env, id) {
  await ensureSchema(env)
  const row = await runSchedule(env, id, ['pending', 'failed'])
  if (!row) return json({ error: 'この予約は投稿中か、すでに投稿済みです。一覧を更新してください。' }, 409)
  const schedule = scheduleItem(row)
  return row.status === 'posted' ? json({ schedule }) : json({ error: row.error, schedule }, 502)
}

// Cron Trigger から毎分呼ばれる
async function runDueSchedules(env) {
  await ensureSchema(env)
  const now = Date.now()
  const [, , due] = await env.DB.batch([
    // 投稿の途中で止まったもの(10分以上 posting のまま)は失敗にする
    env.DB.prepare("UPDATE scheduled_posts SET status = 'failed', error = ?, updated_at = ? WHERE status = 'posting' AND updated_at < ?").bind('投稿の途中で止まりました。投稿されたかどうかをSNSで確認してください。', new Date(now).toISOString(), new Date(now - stuckMs).toISOString()),
    // 投稿済みは7日で一覧から消す
    env.DB.prepare("DELETE FROM scheduled_posts WHERE status = 'posted' AND updated_at < ?").bind(new Date(now - postedKeepMs).toISOString()),
    env.DB.prepare("SELECT id, images FROM scheduled_posts WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?").bind(new Date(now).toISOString(), scheduleMaxPerRun),
  ])
  // 画像付きは Threads の処理待ちで呼び出しが多い(1回の実行で外部の呼び出しは50回まで)ため、1回に1件だけ。残りは次の分に投稿する
  let hasPostedImages = false
  for (const row of due.results) {
    if (row.images) {
      if (hasPostedImages) continue
      hasPostedImages = true
    }
    await runSchedule(env, row.id, ['pending'])
  }
}

async function handleSchedule(handler) {
  try {
    return await handler()
  } catch (scheduleError) {
    console.error(scheduleError)
    return json({ error: scheduleError.message || '予約の処理に失敗しました。' }, scheduleError.status || 500)
  }
}

function status(data) {
  return json({ connected: Boolean(data?.accessToken), userId: data?.userId || null, username: data?.username || null, name: data?.name || null, profile: data?.profile || null })
}

async function route(request, env, session, url) {
  const key = `${request.method} ${url.pathname}`
  // /api/schedules/{ID}(削除)と /api/schedules/{ID}/post(今すぐ投稿)
  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([0-9a-f]{32})(\/post)?$/)
  if (scheduleMatch && request.method === 'DELETE' && !scheduleMatch[2]) return handleSchedule(() => deleteSchedule(env, scheduleMatch[1]))
  if (scheduleMatch && request.method === 'POST' && scheduleMatch[2]) return handleSchedule(() => postScheduleNow(env, scheduleMatch[1]))
  switch (key) {
    case 'GET /api/schedules': return handleSchedule(() => listSchedules(env))
    case 'POST /api/schedules': return handleSchedule(() => createSchedule(request, env, session))
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
    case 'GET /api/threads/usage': return threadsGetUsage(session, env)
    case 'GET /api/threads/search': return threadsSearch(session, url)
    case 'POST /api/threads/posts': return threadsCreatePost(request, env, session)
    default: return json({ error: 'Not Found' }, 404)
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    // 画像は Meta のサーバーが取りに来るため、セッションを作らずに返す(KV への書き込みを増やさない)
    if (request.method === 'GET' && url.pathname.startsWith('/api/media/')) return serveMedia(env, url.pathname.slice('/api/media/'.length))
    const session = await loadSession(request, env)
    const response = await route(request, env, session, url)
    await saveThreadsCalls(session, env).catch((saveError) => console.error(saveError))
    return finish(session, env, response)
  },
  // Cron Trigger(wrangler.jsonc の triggers.crons)。予定時刻を過ぎた予約を投稿する
  async scheduled(controller, env) {
    await runDueSchedules(env)
  },
}
