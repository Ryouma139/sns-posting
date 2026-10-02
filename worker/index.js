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
  const params = new URLSearchParams({ response_type: 'code', client_id: env.X_CLIENT_ID, redirect_uri: redirectUri(env, request, 'X_REDIRECT_URI', 'x'), scope: 'tweet.read tweet.write users.read media.write offline.access', state, code_challenge: codeChallenge, code_challenge_method: 'S256' })
  return startOAuth(`https://x.com/i/oauth2/authorize?${params}`, { provider: 'x', state, codeVerifier })
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

// ---- 添付画像 ----
// 画像付きの投稿は multipart/form-data(text, accountId, images)、テキストだけなら JSON で受け取る
const maxImages = 4
const maxImageBytes = 5 * 1024 * 1024
const imageTypes = ['image/jpeg', 'image/png']

async function readPostBody(request) {
  if (!(request.headers.get('content-type') || '').includes('multipart/form-data')) {
    const body = await request.json().catch(() => null)
    return { text: body?.text, accountId: body?.accountId, topicTag: body?.topicTag, images: [] }
  }
  const form = await request.formData().catch(() => null)
  if (!form) return null
  return { text: form.get('text'), accountId: form.get('accountId') || '', topicTag: form.get('topicTag'), images: form.getAll('images').filter((item) => typeof item !== 'string') }
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
  } catch (uploadError) {
    console.error(uploadError)
    return json({ error: uploadError.message }, uploadError.status || 500)
  }
  const xResponse = await fetch('https://api.x.com/2/tweets', { method: 'POST', headers: { Authorization: `Bearer ${session.data.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tweet) })
  const result = await xResponse.json()
  if (!xResponse.ok) return json({ error: result.detail || result.title || 'Xへの投稿に失敗しました。' }, xResponse.status)
  return json({ id: result.data.id, text: result.data.text || text })
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
// そのため画像を KV に一時保存し、/api/media/{ID} で公開する(Cloudflare Access の Bypass が必要)
const mediaTtl = 3600

async function storeMedia(env, image) {
  const id = randomHex(16)
  await env.SESSIONS.put(`media:${id}`, await image.arrayBuffer(), { expirationTtl: mediaTtl, metadata: { type: image.type } })
  return id
}

async function serveMedia(env, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response('Not Found', { status: 404 })
  const { value, metadata } = await env.SESSIONS.getWithMetadata(`media:${id}`, 'arrayBuffer')
  if (!value) return new Response('Not Found', { status: 404 })
  return new Response(value, { headers: { 'Content-Type': metadata?.type || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' } })
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
  // localhost の画像は Meta から取りに来られない
  if (body.images.length && /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) return json({ error: 'Threadsへの画像付き投稿は本番環境でのみ使えます(Metaがlocalhostの画像を取得できないため)。' }, 400)
  try {
    // Threadsは「コンテナ作成」→「公開」の2段階で投稿する。画像が2枚以上ならカルーセルにする
    const create = (params) => threadsFetch(session, `/v1.0/me/threads?${new URLSearchParams(params)}`, threads.accessToken, { method: 'POST' })
    const imageUrls = await Promise.all(body.images.map(async (image) => `${origin}/api/media/${await storeMedia(env, image)}`))
    let container
    if (imageUrls.length === 0) {
      container = await create({ media_type: 'TEXT', ...caption })
    } else if (imageUrls.length === 1) {
      container = await create({ media_type: 'IMAGE', image_url: imageUrls[0], ...caption })
      await waitForThreadsContainer(session, container.id, threads.accessToken)
    } else {
      const items = []
      for (const imageUrl of imageUrls) items.push(await create({ media_type: 'IMAGE', image_url: imageUrl, is_carousel_item: 'true' }))
      for (const item of items) await waitForThreadsContainer(session, item.id, threads.accessToken)
      container = await create({ media_type: 'CAROUSEL', children: items.map((item) => item.id).join(','), ...caption })
      await waitForThreadsContainer(session, container.id, threads.accessToken)
    }
    const published = await threadsFetch(session, `/v1.0/me/threads_publish?creation_id=${container.id}`, threads.accessToken, { method: 'POST' })
    return json({ id: published.id, text })
  } catch (publishError) {
    return threadsError(publishError, 'Threadsへの投稿に失敗しました。')
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
}
