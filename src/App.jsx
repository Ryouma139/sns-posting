import { useEffect, useRef, useState } from 'react'
import { Archive, BarChart3, Heart, LogOut, MapPin, MessageCircle, Repeat2, Search, TrendingUp, Bell, CalendarDays, AlertCircle, Check, ChevronDown, Info, Clock3, Command, ExternalLink, FileText, Gauge, Hash, Image, LayoutDashboard, Link2, MoreHorizontal, Paperclip, PenLine, Send, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import './App.css'

// サイドバーから切り替える画面(それ以外のハッシュは概要画面内の位置として扱う)
const pageTitles = { dashboard: '概要', compose: '作成', analytics: '分析', trends: 'トレンド検索', drafts: '下書き', usage: 'API利用状況' }

function getViewFromHash(hash) {
  return pageTitles[hash] ? hash : 'dashboard'
}

// ワークスペース = 連携するSNS。表示や投稿先はここで切り替える
const platforms = {
  x: {
    label: 'X',
    symbol: '𝕏',
    maxCharacters: 280,
    archiveNote: '取得のたびにAPIクレジットを消費します',
    profileUrl: (username) => `https://x.com/${username}`,
    postUrl: (username, item) => `https://x.com/${username}/status/${item.id}`,
  },
  threads: {
    label: 'Threads',
    symbol: '@',
    maxCharacters: 500,
    archiveNote: '取得のたびにThreads APIの利用回数を消費します',
    profileUrl: (username) => `https://www.threads.net/@${username}`,
    postUrl: (username, item) => item.permalink || `https://www.threads.net/@${username}`,
  },
}
const platformKeys = Object.keys(platforms)
const platformStorageKey = 'sns-posting-platform'
const emptyAccount = { connected: false, userId: '', username: '', name: '', profile: null }

// 予約・下書きが連携中のアカウントのものか。true/false、アカウントの記録がない古いデータは null
function isSameAccount(item, account) {
  if (!account.connected) return false
  if (item.accountId && account.userId) return item.accountId === account.userId
  if (item.accountUsername) return item.accountUsername === account.username
  return null
}
const emptyArchive = { posts: [], loadedAt: null, error: '', isLoading: false }

function loadStoredPlatform() {
  try {
    const saved = window.localStorage.getItem(platformStorageKey)
    return platforms[saved] ? saved : 'x'
  } catch {
    return 'x'
  }
}

const scheduledStorageKey = 'sns-posting-scheduled'
const draftStorageKey = 'sns-posting-drafts'

// localStorageから配列を読み出す(使えない環境や壊れたデータなら空にする)
function loadStoredList(key) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) || '[]')
    return Array.isArray(saved) ? saved : []
  } catch {
    return []
  }
}

function saveStoredList(key, list) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // 保存できない環境では画面内だけで保持する
  }
}

// <input type="datetime-local"> 用の値(ローカル時刻の YYYY-MM-DDTHH:MM)
function toLocalInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 上限の集計期間(秒)を「24時間」などにする
function formatDuration(seconds) {
  if (!seconds) return ''
  return seconds % 3600 === 0 ? `${seconds / 3600}時間` : `${Math.round(seconds / 60)}分`
}

// API利用状況の「API呼び出し」タブで表示する種類
// API利用状況の画面に出す参照URL(上限や計算式の出典)
const usageReferences = [
  { label: 'Threads API の概要(レート制限・投稿/返信/削除の上限)', url: 'https://developers.facebook.com/documentation/threads/overview' },
  { label: 'Threads の投稿(threads_publishing_limit)', url: 'https://developers.facebook.com/docs/threads/posts/' },
  { label: 'Graph API のレート制限(X-App-Usage ヘッダー)', url: 'https://developers.facebook.com/docs/graph-api/overview/rate-limiting/' },
]

const callCategoryLabels = { posts: '投稿一覧', insights: 'インサイト(いいね数など)', publish: '投稿', search: 'トレンド検索', usage: '利用状況の確認', profile: 'プロフィール', auth: '連携(トークン)' }

function formatScheduledAt(value) {
  return new Date(value).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

// 添付画像(X と Threads の両方で使える範囲にそろえる。Worker 側の maxImages などと同じ値)
const maxImages = 4
const maxImageBytes = 5 * 1024 * 1024
const imageTypes = ['image/jpeg', 'image/png']

const notificationStorageKey = 'sns-posting-notifications'
const notificationLimit = 50
const notificationIcons = { success: Check, error: AlertCircle, info: Info }

function ProfileAvatar({ imageUrl, initial, className = '' }) {
  if (imageUrl) return <img className={`avatar avatar-image ${className}`} src={imageUrl} alt="" />
  return <span className={`avatar peach ${className}`}>{initial}</span>
}

function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1))
  const view = getViewFromHash(route)
  const [post, setPost] = useState('')
  // 添付画像 { id, file, url }。url はプレビュー用の blob URL。下書き・予約には保存しない
  const [images, setImages] = useState([])
  const imageInputRef = useRef(null)
  const [platform, setPlatform] = useState(loadStoredPlatform)
  const [accounts, setAccounts] = useState({ x: emptyAccount, threads: emptyAccount })
  const [archives, setArchives] = useState({ x: emptyArchive, threads: emptyArchive })
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false)
  const workspaceMenuRef = useRef(null)
  const platformInfo = platforms[platform]
  const { connected: isConnected, username, name: accountName, profile } = accounts[platform]
  const { posts: archive, loadedAt: archiveLoadedAt, error: archiveError, isLoading: isArchiveLoading } = archives[platform]
  const [isProfileOpen, setIsProfileOpen] = useState(false)
  const profileMenuRef = useRef(null)
  const [notifications, setNotifications] = useState(() => loadStoredList(notificationStorageKey))
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false)
  const notificationMenuRef = useRef(null)
  const connectResultRef = useRef(null)
  const unreadCount = notifications.filter((item) => !item.read).length
  const [isPosting, setIsPosting] = useState(false)
  const [scheduledPosts, setScheduledPosts] = useState(() => loadStoredList(scheduledStorageKey))
  const [isScheduleOpen, setIsScheduleOpen] = useState(false)
  const [scheduleAt, setScheduleAt] = useState('')
  // 予約は選択中のワークスペース(SNS)の分だけ表示する。以前の予約はXとして扱う
  const sortedScheduledPosts = scheduledPosts.filter((item) => (item.platform || 'x') === platform).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
  // 連携中のアカウントで予約したものと、それ以外(別アカウント・アカウント不明)に分ける
  const ownScheduledPosts = sortedScheduledPosts.filter((item) => isSameAccount(item, accounts[platform]) === true)
  const otherScheduledPosts = sortedScheduledPosts.filter((item) => isSameAccount(item, accounts[platform]) !== true)
  const [drafts, setDrafts] = useState(() => loadStoredList(draftStorageKey))
  // 下書きから開いて編集中の場合はそのID(保存すると上書き、投稿・予約すると削除する)
  const [editingDraftId, setEditingDraftId] = useState(null)
  // 下書きも選択中のワークスペース(SNS)の分だけ、更新が新しい順に表示する
  const sortedDrafts = drafts.filter((item) => item.platform === platform).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  // 連携中のアカウントの下書きと、それ以外(別アカウント)に分ける。アカウント不明の古い下書きは誰でも開ける
  const ownDrafts = sortedDrafts.filter((item) => isSameAccount(item, accounts[platform]) !== false)
  const otherDrafts = sortedDrafts.filter((item) => isSameAccount(item, accounts[platform]) === false)
  const [notice, setNotice] = useState('')
  const [isNoticeError, setIsNoticeError] = useState(false)
  const maxCharacters = platformInfo.maxCharacters
  const isOverLimit = post.length > maxCharacters
  // 未連携時はデフォルト名、連携後はSNSの表示名(取得できなければユーザー名)
  const displayName = isConnected ? accountName || username : 'Ryouma'
  const initial = [...displayName][0]?.toUpperCase() || 'R'
  const avatarUrl = isConnected ? profile?.imageUrl || '' : ''
  const metrics = profile?.metrics
  const joinedAt = profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' }) : ''
  const analyzedPosts = archive.filter((item) => item.public_metrics)
  const totals = analyzedPosts.reduce((sum, item) => ({
    likes: sum.likes + item.public_metrics.like_count,
    reposts: sum.reposts + item.public_metrics.retweet_count,
    replies: sum.replies + item.public_metrics.reply_count,
  }), { likes: 0, reposts: 0, replies: 0 })
  const engagementOf = (item) => item.public_metrics.like_count + item.public_metrics.retweet_count + item.public_metrics.reply_count + (item.public_metrics.quote_count || 0)
  const topPosts = [...analyzedPosts].sort((a, b) => engagementOf(b) - engagementOf(a)).slice(0, 5)
  const now = new Date()
  const today = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`
  const updateArchive = (target, changes) => setArchives((current) => ({ ...current, [target]: { ...current[target], ...(typeof changes === 'function' ? changes(current[target]) : changes) } }))
  const addNotification = (type, title, message = '') => {
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, type, title, message, createdAt: new Date().toISOString(), read: false }
    setNotifications((current) => [item, ...current].slice(0, notificationLimit))
  }

  useEffect(() => {
    // 連携後のリダイレクトで付くクエリは一度だけ読み取り、URLから消す
    // (開発時のStrictModeではeffectが2回実行されるためrefに保持する)
    if (!connectResultRef.current) {
      const params = new URLSearchParams(window.location.search)
      connectResultRef.current = Object.fromEntries(platformKeys.map((key) => [key, params.has(`${key}_connected`)]))
      const returnedFrom = platformKeys.find((key) => params.has(`${key}_connected`) || params.has(`${key}_error`))
      if (returnedFrom) {
        window.history.replaceState(null, '', window.location.pathname + window.location.hash)
        // 連携から戻ってきたら、そのSNSのワークスペースに切り替える
        setPlatform(returnedFrom)
      }
      for (const key of platformKeys) {
        const connectError = params.get(`${key}_error`)
        const label = platforms[key].label
        const messages = { oauth: '認可がキャンセルされたか、有効期限が切れました。', config: '.env に THREADS_APP_ID と THREADS_APP_SECRET を設定し、npm run dev を再起動してください。' }
        if (connectError) addNotification('error', `${label}アカウントの連携に失敗しました`, messages[connectError] || `${label}からの認証情報の取得に失敗しました。`)
      }
    }

    const controller = new AbortController()
    // SNSごとに独立して取得し、片方が失敗してももう片方は表示する
    Promise.allSettled(platformKeys.map((key) => fetch(`/api/${key}/status`, { signal: controller.signal }).then((response) => response.json()).then((data) => [key, data]))).then((results) => {
      if (controller.signal.aborted) return
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        const [key, data] = result.value
        setAccounts((current) => ({ ...current, [key]: { connected: data.connected, userId: data.userId || '', username: data.username || '', name: data.name || '', profile: data.profile || null } }))
        if (connectResultRef.current[key] && data.connected) {
          connectResultRef.current[key] = false
          addNotification('success', `${platforms[key].label}アカウントを連携しました`, `@${data.username}`)
        }
      }
      if (results.every((result) => result.status === 'rejected')) {
        showError('APIサーバーに接続できません。')
        addNotification('error', 'APIサーバーに接続できません', 'npm run dev が起動しているか確認してください。')
      }
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash.slice(1))
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    // 画面を切り替えたら先頭へ、概要画面内の項目(#archiveなど)ならその位置へ移動する
    const target = pageTitles[route] ? null : route && document.getElementById(route)
    if (target) target.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [route])

  // 通知と予約投稿はこのブラウザのlocalStorageに保存する
  useEffect(() => saveStoredList(notificationStorageKey, notifications), [notifications])
  useEffect(() => saveStoredList(scheduledStorageKey, scheduledPosts), [scheduledPosts])
  useEffect(() => saveStoredList(draftStorageKey, drafts), [drafts])
  useEffect(() => {
    try {
      window.localStorage.setItem(platformStorageKey, platform)
    } catch {
      // 保存できない環境では次回はXで開く
    }
  }, [platform])

  useEffect(() => {
    // 通知メニューを開いている間に届いた通知も既読にする
    if (isNotificationsOpen) setNotifications((current) => current.some((item) => !item.read) ? current.map((item) => ({ ...item, read: true })) : current)
  }, [isNotificationsOpen, notifications.length])

  useEffect(() => {
    if (!isProfileOpen && !isNotificationsOpen && !isWorkspaceOpen) return
    const handlePointer = (event) => {
      if (!profileMenuRef.current?.contains(event.target)) setIsProfileOpen(false)
      if (!notificationMenuRef.current?.contains(event.target)) setIsNotificationsOpen(false)
      if (!workspaceMenuRef.current?.contains(event.target)) setIsWorkspaceOpen(false)
    }
    const handleKey = (event) => {
      if (event.key !== 'Escape') return
      setIsProfileOpen(false)
      setIsNotificationsOpen(false)
      setIsWorkspaceOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [isProfileOpen, isNotificationsOpen, isWorkspaceOpen])

  const showError = (message) => {
    setIsNoticeError(true)
    setNotice(message)
  }

  const archiveLimit = 20
  // APIの利用量(Xはクレジット)を抑えるため、ボタンを押したときだけ取得する
  const loadArchive = async () => {
    const target = platform
    const label = platforms[target].label
    updateArchive(target, { isLoading: true, error: '' })
    try {
      const response = await fetch(`/api/${target}/posts`)
      const result = await response.json()
      if (!response.ok) {
        updateArchive(target, { error: result.error || '投稿の取得に失敗しました。' })
        addNotification('error', `${label}の投稿アーカイブの取得に失敗しました`, result.error || `エラー ${response.status}`)
        return
      }
      updateArchive(target, { posts: result.posts.slice(0, archiveLimit), loadedAt: new Date() })
      addNotification('info', `${label}の投稿アーカイブを更新しました`, `${Math.min(result.posts.length, archiveLimit)}件を取得しました。`)
    } catch {
      updateArchive(target, { error: 'APIサーバーに接続できません。' })
      addNotification('error', `${label}の投稿アーカイブの取得に失敗しました`, 'APIサーバーに接続できません。')
    } finally {
      updateArchive(target, { isLoading: false })
    }
  }

  const handleConnect = () => { window.location.href = `/api/${platform}/connect` }
  const handleDisconnect = async () => {
    const target = platform
    await fetch(`/api/${target}/disconnect`, { method: 'POST' })
    setAccounts((current) => ({ ...current, [target]: emptyAccount }))
    setIsProfileOpen(false)
    updateArchive(target, emptyArchive)
    addNotification('info', `${platforms[target].label}アカウントの連携を解除しました`)
  }
  const switchPlatform = (target) => {
    setPlatform(target)
    setIsWorkspaceOpen(false)
    setIsScheduleOpen(false)
    // 編集中の下書きは元のSNSのものなので、切り替えたら新規作成として扱う
    setEditingDraftId(null)
  }
  // トレンド検索(Threads のキーワード検索)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchType, setSearchType] = useState('TOP')
  const [searchPeriod, setSearchPeriod] = useState('7d')
  const [searchResults, setSearchResults] = useState(null)
  const [searchError, setSearchError] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const handleSearch = async (event) => {
    event.preventDefault()
    const q = searchQuery.trim()
    if (!q || isSearching) return
    setIsSearching(true)
    setSearchError('')
    try {
      const response = await fetch(`/api/threads/search?${new URLSearchParams({ q, type: searchType, period: searchPeriod })}`)
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || `エラー ${response.status}`)
      setSearchResults({ q, posts: result.posts })
    } catch (searchFailure) {
      setSearchResults(null)
      setSearchError(searchFailure.message || '検索に失敗しました。')
    } finally {
      setIsSearching(false)
    }
  }

  // API利用状況(Threadsの投稿・返信の上限と直近24時間の消費数)
  const [usage, setUsage] = useState(null)
  const [usageError, setUsageError] = useState('')
  const [isUsageLoading, setIsUsageLoading] = useState(false)
  // quota = 投稿・返信の上限、calls = API呼び出しの合計
  const [usageTab, setUsageTab] = useState('quota')
  const loadUsage = async () => {
    setIsUsageLoading(true)
    setUsageError('')
    try {
      const response = await fetch('/api/threads/usage')
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || `エラー ${response.status}`)
      setUsage(result)
    } catch (loadError) {
      setUsageError(loadError.message || 'API利用状況の取得に失敗しました。')
    } finally {
      setIsUsageLoading(false)
    }
  }
  const usageConnected = accounts.threads.connected
  useEffect(() => {
    // 画面を開いたときに取得する。投稿のたびに数が変わるので、開くたびに取り直す
    if (view === 'usage' && platform === 'threads' && usageConnected) loadUsage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, platform, usageConnected])

  // accountId を渡すと、Worker 側でも連携中のアカウントと一致するか確認する
  // attachments: 添付画像の File。画像があるときだけ multipart/form-data で送る
  const publishPost = async (text, target = platform, accountId = '', attachments = []) => {
    const label = platforms[target].label
    if ((!text.trim() && attachments.length === 0) || !accounts[target].connected || isPosting) return false
    setIsPosting(true)
    let response
    let result
    try {
      let request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, accountId }) }
      if (attachments.length) {
        const form = new FormData()
        form.append('text', text)
        form.append('accountId', accountId)
        for (const file of attachments) form.append('images', file)
        request = { method: 'POST', body: form }
      }
      response = await fetch(`/api/${target}/posts`, request)
      result = await response.json()
    } catch {
      showError(`${label}への投稿に失敗しました。APIサーバーの状態を確認してください。`)
      addNotification('error', `${label}への投稿に失敗しました`, 'APIサーバーに接続できません。')
      return false
    } finally {
      setIsPosting(false)
    }
    if (!response.ok) {
      showError(`${label}への投稿に失敗しました: ${result.error || response.status}`)
      addNotification('error', `${label}への投稿に失敗しました`, result.error || `エラー ${response.status}`)
      return false
    }
    addNotification('success', `${label}へ投稿しました`, [result.text, attachments.length ? `画像${attachments.length}枚` : ''].filter(Boolean).join(' · '))
    setIsNoticeError(false)
    setNotice(`${label}へ投稿しました`)
    updateArchive(target, (current) => ({ posts: [{ id: result.id, text: result.text, created_at: new Date().toISOString() }, ...current.posts].slice(0, archiveLimit) }))
    window.setTimeout(() => setNotice(''), 3000)
    return true
  }

  const handlePost = async () => {
    if (await publishPost(post, platform, '', images.map((item) => item.file))) {
      setPost('')
      clearImages()
      finishEditingDraft()
    }
  }

  const handleSelectImages = (event) => {
    const files = [...event.target.files]
    // 同じファイルを続けて選べるように、選択をリセットする
    event.target.value = ''
    const accepted = []
    const rejected = []
    for (const file of files) {
      if (!imageTypes.includes(file.type)) rejected.push(`${file.name}(JPEG・PNG以外)`)
      else if (file.size > maxImageBytes) rejected.push(`${file.name}(5MB超)`)
      else if (images.length + accepted.length >= maxImages) rejected.push(`${file.name}(${maxImages}枚まで)`)
      else accepted.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, url: URL.createObjectURL(file) })
    }
    if (accepted.length) setImages((current) => [...current, ...accepted])
    if (rejected.length) showError(`添付できない画像があります: ${rejected.join('、')}`)
  }

  const removeImage = (id) => setImages((current) => current.filter((item) => {
    if (item.id === id) URL.revokeObjectURL(item.url)
    return item.id !== id
  }))

  const clearImages = () => setImages((current) => {
    for (const item of current) URL.revokeObjectURL(item.url)
    return []
  })

  // 画像はブラウザに保存できない大きさのため、下書き・予約には本文だけを残す
  const imageNotSavedNote = images.length ? '(画像は保存されません)' : ''

  // 投稿・予約した下書きは一覧から消す
  const finishEditingDraft = () => {
    if (editingDraftId) setDrafts((current) => current.filter((item) => item.id !== editingDraftId))
    setEditingDraftId(null)
  }

  // 下書きを作ったアカウントと連携中のアカウントが違えば、エラーを出して true を返す
  const rejectOtherAccountDraft = (item) => {
    const account = accounts[item.platform]
    if (isSameAccount(item, account) !== false) return false
    const label = platforms[item.platform].label
    const message = !account.connected
      ? `下書きを編集するには${label}アカウント${item.accountUsername ? `(@${item.accountUsername})` : ''}を連携してください。`
      : `この下書きは @${item.accountUsername} で作成されています。@${item.accountUsername} を連携してから編集してください。`
    showError(message)
    addNotification('error', `${label}の下書きを開けませんでした`, message)
    return true
  }

  const handleSaveDraft = () => {
    const text = post.trim()
    if (!text) return
    if (!isConnected) { showError(`下書きを保存するには${platformInfo.label}アカウントを連携してください。`); return }
    const updatedAt = new Date().toISOString()
    // 下書きには作成したアカウントを残す(アカウント不明の古い下書きは、保存したアカウントのものにする)
    const owner = { accountId: accounts[platform].userId, accountUsername: username }
    const editingDraft = editingDraftId && drafts.find((item) => item.id === editingDraftId)
    if (editingDraft) {
      if (rejectOtherAccountDraft(editingDraft)) return
      setDrafts((current) => current.map((item) => item.id === editingDraftId ? { ...item, ...(item.accountId || item.accountUsername ? {} : owner), text, updatedAt } : item))
    } else {
      const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, platform, ...owner, text, createdAt: updatedAt, updatedAt }
      setDrafts((current) => [...current, item])
      setEditingDraftId(item.id)
    }
    setIsNoticeError(false)
    setNotice(`下書きを保存しました${imageNotSavedNote}`)
    window.setTimeout(() => setNotice(''), 3000)
  }

  const openDraft = (item) => {
    if (rejectOtherAccountDraft(item)) return
    setPost(item.text.slice(0, maxCharacters))
    setEditingDraftId(item.id)
    setIsScheduleOpen(false)
    window.location.hash = 'compose'
  }

  const removeDraft = (id) => {
    setDrafts((current) => current.filter((item) => item.id !== id))
    if (id === editingDraftId) setEditingDraftId(null)
  }

  // showAccount: 別アカウントの下書きには、作成したアカウント名を表示する
  const renderDraftRow = (item, showAccount) => {
    const date = new Date(item.updatedAt)
    return (
      <div className="upcoming-row archive-row" key={item.id}>
        <div className="date-block"><b>{date.getDate()}</b><span>{date.getMonth() + 1}月</span></div>
        <button className="upcoming-content draft-open" onClick={() => openDraft(item)}>
          <div className="upcoming-meta"><span className="draft-pill"><FileText size={13} /> 下書き</span>{showAccount && <span className="draft-pill account-pill-small">{item.accountUsername ? `@${item.accountUsername}` : 'アカウント不明'}</span>}<span>{date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} に保存 · {item.text.length}文字</span></div>
          <p>{item.text}</p>
        </button>
        <div className="scheduled-actions">
          <button className="more-button" onClick={() => openDraft(item)} aria-label="下書きを編集" title="下書きを編集"><PenLine size={16} /></button>
          <button className="more-button" onClick={() => removeDraft(item.id)} aria-label="下書きを削除" title="下書きを削除"><Trash2 size={16} /></button>
        </div>
      </div>
    )
  }

  const startNewPost = () => {
    setPost('')
    clearImages()
    setEditingDraftId(null)
    setIsScheduleOpen(false)
  }

  const openSchedule = () => {
    // 初期値は1時間後(分は切り捨て)
    const defaultAt = new Date(Date.now() + 60 * 60 * 1000)
    defaultAt.setSeconds(0, 0)
    setScheduleAt(toLocalInputValue(defaultAt))
    setIsScheduleOpen(true)
  }

  const handleSchedule = (event) => {
    event.preventDefault()
    const scheduledAt = new Date(scheduleAt)
    if (!post.trim() || isOverLimit || Number.isNaN(scheduledAt.getTime())) return
    if (scheduledAt <= new Date()) { showError('予約日時は現在より後の日時を指定してください。'); return }
    if (!isConnected) { showError(`予約するには${platformInfo.label}アカウントを連携してください。`); return }
    // どのアカウントで予約したかを残し、別のアカウントから投稿しないようにする
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, platform, accountId: accounts[platform].userId, accountUsername: username, text: post.trim(), scheduledAt: scheduledAt.toISOString(), createdAt: new Date().toISOString() }
    setScheduledPosts((current) => [...current, item])
    setIsScheduleOpen(false)
    setPost('')
    clearImages()
    finishEditingDraft()
    setIsNoticeError(false)
    setNotice(`${formatScheduledAt(item.scheduledAt)} に予約しました${imageNotSavedNote}`)
    addNotification('info', `${platformInfo.label}の予約投稿を追加しました`, `${formatScheduledAt(item.scheduledAt)} · ${item.text}`)
    window.setTimeout(() => setNotice(''), 3000)
  }

  const removeScheduled = (id) => setScheduledPosts((current) => current.filter((item) => item.id !== id))

  const publishScheduled = async (item) => {
    const target = item.platform || 'x'
    const account = accounts[target]
    const same = isSameAccount(item, account)
    if (same === false) {
      const message = `この予約は @${item.accountUsername} で作成されています。@${item.accountUsername} を連携してから投稿してください。`
      showError(message)
      addNotification('error', `${platforms[target].label}の予約を投稿しませんでした`, message)
      return
    }
    if (same === null && !window.confirm(`予約したアカウントが記録されていない予約です。連携中の @${account.username} から投稿しますか？`)) return
    if (await publishPost(item.text, target, item.accountId || '')) removeScheduled(item.id)
  }

  // showAccount: 別アカウント・アカウント不明の予約には、予約したアカウント名を表示する
  const renderScheduledRow = (item, showAccount) => {
    const date = new Date(item.scheduledAt)
    const isOverdue = date <= new Date()
    return (
      <div className="upcoming-row archive-row" key={item.id}>
        <div className="date-block"><b>{date.getDate()}</b><span>{date.getMonth() + 1}月</span></div>
        <div className="upcoming-content">
          <div className="upcoming-meta">{isOverdue ? <span className="draft-pill overdue-pill"><AlertCircle size={13} /> 予定時刻を過ぎています</span> : <span className="scheduled-pill"><Clock3 size={13} /> 予約済み</span>}{showAccount && <span className="draft-pill account-pill-small">{item.accountUsername ? `@${item.accountUsername}` : 'アカウント不明'}</span>}<span>{formatScheduledAt(item.scheduledAt)}</span></div>
          <p>{item.text}</p>
        </div>
        <div className="scheduled-actions">
          <button className="more-button" disabled={!isConnected || isPosting} onClick={() => publishScheduled(item)} aria-label="今すぐ投稿" title={isConnected ? '今すぐ投稿' : `${platformInfo.label}アカウントを連携すると投稿できます`}><Send size={16} /></button>
          <button className="more-button" onClick={() => removeScheduled(item.id)} aria-label="予約を削除" title="予約を削除"><Trash2 size={16} /></button>
        </div>
      </div>
    )
  }

  const connectionCard = <section className="connection-card"><div className="x-symbol">{platformInfo.symbol}</div><div className="connection-copy"><span className="eyebrow">アカウント連携</span><h2>{isConnected ? `@${username}` : `${platformInfo.label}アカウントを連携`}</h2><p>{isConnected ? '投稿の準備ができています。' : '一度連携すれば、あなたのアカウントへ直接投稿できます。'}</p></div><div className="connection-status">{isConnected ? <><span className="status-dot connected" /> 連携済み</> : <><span className="status-dot" /> 未連携</>}</div><button className={isConnected ? 'disconnect-button' : 'connect-button'} onClick={isConnected ? handleDisconnect : handleConnect}>{isConnected ? '連携を解除' : `${platformInfo.label}を連携`} <Link2 size={16} /></button></section>
  const archiveFooter = isConnected && <div className="archive-footer"><span className="archive-note">{archiveLoadedAt ? `${archiveLoadedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に取得 · ` : ''}{platformInfo.archiveNote}</span><button className="outline-button" disabled={isArchiveLoading} onClick={loadArchive}>{isArchiveLoading ? '読み込み中...' : archiveLoadedAt ? '最新に更新' : '読み込む'}</button></div>

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">S</span><span>STORY<br /><b>STACK</b></span></div>
        <div className="workspace-wrap" ref={workspaceMenuRef}>
          <button className="workspace-switcher" aria-expanded={isWorkspaceOpen} aria-haspopup="menu" onClick={() => setIsWorkspaceOpen((open) => !open)}><span className="avatar platform-avatar">{platformInfo.symbol}</span><span><small>ワークスペース · {platformInfo.label}</small>{isConnected ? displayName : "Ryouma's studio"}</span><ChevronDown size={15} /></button>
          {isWorkspaceOpen && (
            <div className="workspace-menu" role="menu" aria-label="ワークスペースを切り替え">
              {platformKeys.map((key) => (
                <button key={key} role="menuitemradio" aria-checked={key === platform} className={key === platform ? 'active' : undefined} onClick={() => switchPlatform(key)}>
                  <span className="avatar platform-avatar">{platforms[key].symbol}</span>
                  <span><b>{platforms[key].label}</b><small>{accounts[key].connected ? `@${accounts[key].username}` : '未連携'}</small></span>
                  {key === platform && <Check size={15} />}
                </button>
              ))}
            </div>
          )}
        </div>
        <nav><p className="nav-label">メニュー</p><a className={view === 'dashboard' ? 'active' : undefined} href="#dashboard"><LayoutDashboard size={17} /> 概要</a><a className={view === 'compose' ? 'active' : undefined} href="#compose"><PenLine size={17} /> 作成 <span className="nav-count">1</span></a><a href="#calendar"><CalendarDays size={17} /> カレンダー</a><a className={view === 'analytics' ? 'active' : undefined} href="#analytics"><BarChart3 size={17} /> 分析</a><a className={view === 'trends' ? 'active' : undefined} href="#trends"><TrendingUp size={17} /> トレンド検索</a><p className="nav-label">管理</p><a className={view === 'drafts' ? 'active' : undefined} href="#drafts"><FileText size={17} /> 下書き {sortedDrafts.length > 0 && <span className="nav-count muted">{sortedDrafts.length}</span>}</a><a href="#settings"><Settings2 size={17} /> 設定</a><a href="#archive"><Archive size={17} /> 投稿アーカイブ</a><a className={view === 'usage' ? 'active' : undefined} href="#usage"><Gauge size={17} /> API利用状況</a></nav>
        <div className="sidebar-foot"><div className="help-icon"><Sparkles size={17} /></div><div><strong>お困りですか？</strong><small>クイックガイドを読む</small></div><ExternalLink size={14} /></div>
      </aside>
      <main className="main-content" id="dashboard">
        <header className="topbar"><div className="breadcrumbs"><span>ワークスペース</span><span>/</span><b>{pageTitles[view]}</b></div><div className="top-actions"><div className="profile-menu-wrap" ref={notificationMenuRef}>
              <button className="icon-button" aria-label={unreadCount ? `通知(未読${unreadCount}件)` : '通知'} aria-expanded={isNotificationsOpen} aria-haspopup="dialog" onClick={() => { setIsNotificationsOpen((open) => !open); setIsProfileOpen(false) }}><Bell size={18} />{unreadCount > 0 && <i />}</button>
              {isNotificationsOpen && (
                <div className="profile-menu notification-menu" role="dialog" aria-label="通知">
                  <div className="notification-head"><b>通知</b>{notifications.length > 0 && <button onClick={() => setNotifications([])}>すべて削除</button>}</div>
                  {notifications.length === 0 ? <p className="notification-empty">通知はありません。</p> : (
                    <ul className="notification-list">
                      {notifications.map((item) => {
                        const Icon = notificationIcons[item.type] || Info
                        return (
                          <li key={item.id} className={`notification-item ${item.type}`}>
                            <Icon size={15} />
                            <div><b>{item.title}</b>{item.message && <p>{item.message}</p>}<time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div><div className="profile-menu-wrap" ref={profileMenuRef}>
              <button className="profile" aria-expanded={isProfileOpen} aria-haspopup="dialog" onClick={() => { setIsProfileOpen((open) => !open); setIsNotificationsOpen(false) }}><ProfileAvatar imageUrl={avatarUrl} initial={initial} /><span>{displayName}</span><ChevronDown size={14} /></button>
              {isProfileOpen && (
                <div className="profile-menu" role="dialog" aria-label="アカウント情報">
                  {isConnected ? (
                    <>
                      <div className="profile-menu-head">
                        <ProfileAvatar imageUrl={avatarUrl.replace('_normal', '_bigger')} initial={initial} className="large" />
                        <div><b>{displayName}{profile?.verified && <Check size={13} className="verified-mark" aria-label="認証済み" />}</b><span>@{username}</span></div>
                      </div>
                      {profile?.description && <p className="profile-menu-bio">{profile.description}</p>}
                      {(profile?.location || joinedAt) && <div className="profile-menu-meta">{profile.location && <span><MapPin size={12} /> {profile.location}</span>}{joinedAt && <span><CalendarDays size={12} /> {joinedAt}から利用</span>}</div>}
                      {metrics && <div className="profile-menu-stats"><span><b>{metrics.following_count.toLocaleString('ja-JP')}</b> フォロー</span><span><b>{metrics.followers_count.toLocaleString('ja-JP')}</b> フォロワー</span><span><b>{metrics.tweet_count.toLocaleString('ja-JP')}</b> 投稿</span></div>}
                      {!profile && <p className="profile-menu-bio">詳しいプロフィールを表示するには、連携し直してください。</p>}
                      <div className="profile-menu-actions">
                        <a href={platformInfo.profileUrl(username)} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {platformInfo.label}でプロフィールを開く</a>
                        <button onClick={handleDisconnect}><LogOut size={15} /> 連携を解除</button>
                      </div>
                    </>
                  ) : (
                    <div className="profile-menu-empty">
                      <p>{platformInfo.label}アカウントが連携されていません。</p>
                      <button className="connect-button" onClick={handleConnect}>{platformInfo.label}を連携 <Link2 size={16} /></button>
                    </div>
                  )}
                </div>
              )}
            </div></div></header>
        <div className="page-wrap">
          {view === 'dashboard' && (
            <>
            <section className="intro"><div><p className="eyebrow">{today}</p><h1>おはようございます、{displayName}<span>。</span></h1><p className="subcopy">次のストーリーを、みんなに届けましょう。</p></div><button className="outline-button"><Command size={16} /> ショートカット <kbd>⌘ K</kbd></button></section>
              {connectionCard}
              <div className="section-heading"><div><p className="eyebrow">クイックアクション</p><h2>何を投稿しますか？</h2></div><a className="connect-button quick-compose" href="#compose"><PenLine size={16} /> 投稿を作成</a></div>
            <section className="lower-grid single"><div className="recent-section"><div className="section-heading compact scheduled-heading"><div><p className="eyebrow">次の投稿 · このブラウザで予約</p><h2>予約済みの投稿</h2></div><a href="#compose">予約を追加 <PenLine size={14} /></a></div>
              {sortedScheduledPosts.length === 0 && <p className="archive-empty">予約した投稿はありません。作成画面の「予約投稿」から追加できます。</p>}
              {ownScheduledPosts.map((item) => renderScheduledRow(item, false))}
              {otherScheduledPosts.length > 0 && <p className="eyebrow scheduled-group-label">{isConnected ? 'ほかのアカウントの予約' : '連携するアカウントの予約'}</p>}
              {otherScheduledPosts.map((item) => renderScheduledRow(item, true))}
            </div></section>
            <section className="archive-section" id="archive">
              <div className="section-heading compact"><div><p className="eyebrow">アーカイブ · 最新{archiveLimit}件</p><h2>これまでの投稿</h2></div>{isConnected && <a href={platformInfo.profileUrl(username)} target="_blank" rel="noreferrer">{platformInfo.label}で見る <ExternalLink size={14} /></a>}</div>
              <div className="recent-section">
                {!isConnected && <p className="archive-empty">{platformInfo.label}アカウントを連携すると、これまでの投稿がここに表示されます。</p>}
                {isConnected && archive.map((item) => {
                  const date = new Date(item.created_at)
                  const metrics = item.public_metrics
                  return (
                    <div className="upcoming-row archive-row" key={item.id}>
                      <div className="date-block"><b>{date.getDate()}</b><span>{date.getMonth() + 1}月</span></div>
                      <div className="upcoming-content">
                        <div className="upcoming-meta"><span>{date.toLocaleString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>{metrics && <span className="archive-metrics"><span><MessageCircle size={12} /> {metrics.reply_count}</span><span><Repeat2 size={12} /> {metrics.retweet_count}</span><span><Heart size={12} /> {metrics.like_count}</span></span>}</div>
                        <p>{item.text}</p>
                      </div>
                      <a className="more-button" href={platformInfo.postUrl(username, item)} target="_blank" rel="noreferrer" aria-label={`${platformInfo.label}で投稿を開く`}><ExternalLink size={16} /></a>
                    </div>
                  )
                })}
                {isConnected && !isArchiveLoading && !archiveError && archive.length === 0 && <p className="archive-empty">{archiveLoadedAt ? 'まだ投稿がありません。' : `「読み込む」を押すと、最新${archiveLimit}件の投稿を表示します。`}</p>}
                {archiveError && <p className="archive-empty archive-error">{archiveError}</p>}
                {archiveFooter}
              </div>
            </section>
            </>
          )}
          {view === 'compose' && (
            <>
              <section className="intro"><div><p className="eyebrow">{today}</p><h1>投稿を作成<span>。</span></h1><p className="subcopy">連携した{platformInfo.label}アカウントへ、そのまま投稿できます。</p></div>{editingDraftId && <button className="outline-button" onClick={startNewPost}><PenLine size={16} /> 新規作成</button>}</section>
              {!isConnected && connectionCard}
            <section className="composer-grid"><div className="composer-card"><div className="composer-toolbar"><div className="account-pill"><span className="x-mini">{platformInfo.symbol}</span><span><b>{isConnected ? `@${username}` : `${platformInfo.label}アカウント`}</b><small>{platformInfo.label}へ投稿</small></span><ChevronDown size={14} /></div>{editingDraftId && <span className="draft-pill"><FileText size={13} /> 下書きを編集中</span>}<button className="more-button" aria-label="その他"><MoreHorizontal size={19} /></button></div><textarea value={post} onChange={(event) => setPost(event.target.value.slice(0, maxCharacters))} placeholder="世界に向けて発信しましょう…" />{images.length > 0 && (
                <ul className="attachment-grid" aria-label="添付画像">
                  {images.map((item) => <li key={item.id}><img src={item.url} alt={item.file.name} /><button type="button" onClick={() => removeImage(item.id)} aria-label={`${item.file.name} を削除`} title="画像を削除"><X size={14} /></button></li>)}
                </ul>
              )}<div className="composer-footer"><div className="format-actions"><input ref={imageInputRef} type="file" accept={imageTypes.join(',')} multiple hidden onChange={handleSelectImages} /><button type="button" aria-label="画像を追加" title={images.length >= maxImages ? `画像は${maxImages}枚までです` : `画像を追加(JPEG・PNG、5MBまで、${maxImages}枚まで)`} disabled={images.length >= maxImages} onClick={() => imageInputRef.current?.click()}><Image size={19} />{images.length > 0 && <span className="attachment-count">{images.length}</span>}</button><button type="button" aria-label="ファイルを添付" title="画像ファイルを添付" disabled={images.length >= maxImages} onClick={() => imageInputRef.current?.click()}><Paperclip size={19} /></button><button aria-label="ハッシュタグを追加"><Hash size={19} /></button><button aria-label="投稿を削除"><Trash2 size={18} /></button></div><div className="character-count"><span className={post.length > maxCharacters - 30 ? 'near-limit' : ''}>{post.length}</span> / {maxCharacters}<button className="schedule-button draft-save-button" disabled={!post.trim()} onClick={handleSaveDraft}><FileText size={16} /> 下書き保存</button><span className="schedule-wrap"><button className="schedule-button" disabled={!post.trim() || isOverLimit} aria-expanded={isScheduleOpen} onClick={() => isScheduleOpen ? setIsScheduleOpen(false) : openSchedule()}><Clock3 size={16} /> 予約投稿</button>{isScheduleOpen && (
                <form className="schedule-popover" onSubmit={handleSchedule}>
                  <label htmlFor="schedule-at">投稿する日時</label>
                  <input id="schedule-at" type="datetime-local" value={scheduleAt} min={toLocalInputValue(new Date())} onChange={(event) => setScheduleAt(event.target.value)} required />
                  <p>予約はこのブラウザに保存されます。</p>
                  <div><button type="button" className="outline-button" onClick={() => setIsScheduleOpen(false)}>キャンセル</button><button type="submit" className="post-button" disabled={!scheduleAt}>予約する</button></div>
                </form>
              )}</span><button className="post-button" disabled={!isConnected || (!post.trim() && images.length === 0) || isOverLimit || isPosting} onClick={handlePost}><Send size={16} /> {isPosting ? '投稿中...' : '今すぐ投稿'}</button></div></div></div><aside className="preview-card"><div className="preview-label"><span>プレビュー</span><span className="live-dot">LIVE</span></div><div className="preview-post"><div className="preview-user"><span className="avatar peach">{initial}</span><div><b>{isConnected ? displayName : 'あなたのアカウント'}</b><span>@{isConnected ? username : 'username'} · 今</span></div><span className="preview-x">{platformInfo.symbol}</span></div><p>{post || (images.length ? '' : '入力した投稿内容がここに表示されます。')}</p>{images.length > 0 && <div className={`preview-images count-${images.length}`}>{images.map((item) => <img key={item.id} src={item.url} alt="" />)}</div>}<div className="preview-actions"><span>♡ 0</span><span>↻ 0</span><span>♧ 0</span><MoreHorizontal size={15} /></div></div><div className="preview-tip"><Sparkles size={15} /><span><b>印象に残る投稿に</b><br />短く、わかりやすく、あなたらしく。</span></div></aside></section>
            </>
          )}
          {view === 'drafts' && (
            <>
              <section className="intro"><div><p className="eyebrow">{platformInfo.label} · このブラウザに保存</p><h1>下書き<span>。</span></h1><p className="subcopy">作成画面の「下書き保存」で保存した投稿です。クリックすると編集を再開できます。</p></div><a className="connect-button quick-compose" href="#compose" onClick={startNewPost}><PenLine size={16} /> 新規作成</a></section>
              <section className="archive-section">
                <div className="recent-section">
                  {sortedDrafts.length === 0 && <p className="archive-empty">下書きはありません。作成画面の「下書き保存」から追加できます。</p>}
                  {ownDrafts.map((item) => renderDraftRow(item, false))}
                  {otherDrafts.length > 0 && <p className="eyebrow scheduled-group-label">{isConnected ? 'ほかのアカウントの下書き' : '連携するアカウントの下書き'}</p>}
                  {otherDrafts.map((item) => renderDraftRow(item, true))}
                </div>
              </section>
            </>
          )}
          {view === 'trends' && (
            <>
              <section className="intro"><div><p className="eyebrow">{platformInfo.label} · キーワード検索</p><h1>トレンド検索<span>。</span></h1><p className="subcopy">キーワードを含む Threads の投稿を、人気順または新着順で表示します。</p></div></section>
              {platform !== 'threads' ? (
                <p className="archive-empty usage-note">トレンド検索は Threads のみ対応しています。左上のワークスペースを Threads に切り替えてください。</p>
              ) : !isConnected ? connectionCard : (
                <>
                  <form className="trend-search" onSubmit={handleSearch}>
                    <label className="trend-input"><Search size={16} /><input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="キーワードを入力" maxLength={100} aria-label="キーワード" /></label>
                    <select value={searchType} onChange={(event) => setSearchType(event.target.value)} aria-label="並び順"><option value="TOP">人気順</option><option value="RECENT">新着順</option></select>
                    <select value={searchPeriod} onChange={(event) => setSearchPeriod(event.target.value)} aria-label="期間"><option value="1d">24時間以内</option><option value="7d">7日以内</option><option value="30d">30日以内</option><option value="all">期間指定なし</option></select>
                    <button type="submit" className="post-button" disabled={!searchQuery.trim() || isSearching}>{isSearching ? '検索中...' : '検索'}</button>
                  </form>
                  <p className="archive-note trend-note">アプリが審査(アドバンスアクセス)を通過するまでは、連携中のアカウント自身の投稿だけが検索されます。ほかの人の投稿のいいね数は API で取得できないため、人気順は Threads の判断による並びです。</p>
                  {searchError && <p className="archive-empty usage-note">{searchError}</p>}
                  {searchResults && (
                    <section className="archive-section">
                      <div className="section-heading compact"><div><p className="eyebrow">{searchType === 'TOP' ? '人気順' : '新着順'} · {searchResults.posts.length}件</p><h2>「{searchResults.q}」の検索結果</h2></div></div>
                      <div className="recent-section">
                        {searchResults.posts.length === 0 && <p className="archive-empty">該当する投稿はありませんでした。</p>}
                        {searchResults.posts.map((item) => {
                          const date = new Date(item.created_at)
                          return (
                            <div className="upcoming-row archive-row" key={item.id}>
                              <div className="date-block"><b>{date.getDate()}</b><span>{date.getMonth() + 1}月</span></div>
                              <div className="upcoming-content">
                                <div className="upcoming-meta">{item.username && <span className="draft-pill account-pill-small">@{item.username}</span>}<span>{date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
                                <p>{item.text || `(${item.mediaType || 'テキストなし'})`}</p>
                              </div>
                              {item.permalink && <div className="scheduled-actions"><a className="more-button" href={item.permalink} target="_blank" rel="noreferrer" aria-label="Threadsで見る" title="Threadsで見る"><ExternalLink size={16} /></a></div>}
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )}
                </>
              )}
            </>
          )}
          {view === 'usage' && (
            <>
              <section className="intro"><div><p className="eyebrow">{platformInfo.label} · 直近24時間</p><h1>API利用状況<span>。</span></h1><p className="subcopy">Threads API の上限と、現在どれだけ使っているかを表示します。</p></div></section>
              {platform !== 'threads' ? (
                <p className="archive-empty usage-note">X の API 利用状況は、X Developer Portal の Usage で確認してください。左上のワークスペースを Threads に切り替えると、Threads の利用状況を表示します。</p>
              ) : !isConnected ? connectionCard : (
                <>
                  {usageError && <p className="archive-empty usage-note">{usageError}</p>}
                  <div className="usage-tabs" role="tablist" aria-label="表示の切り替え">
                    <button type="button" role="tab" aria-selected={usageTab === 'quota'} className={usageTab === 'quota' ? 'active' : undefined} onClick={() => setUsageTab('quota')}>投稿・返信の上限</button>
                    <button type="button" role="tab" aria-selected={usageTab === 'calls'} className={usageTab === 'calls' ? 'active' : undefined} onClick={() => setUsageTab('calls')}>API呼び出しの合計</button>
                  </div>
                  {usage && usageTab === 'quota' && (
                    <section className="kpi-row" aria-label="Threads API の消費状況">
                      {[['投稿', Send, usage.posts], ['返信', MessageCircle, usage.replies]].filter(([, , quota]) => quota).map(([label, Icon, quota]) => {
                        const ratio = quota.total ? Math.min(quota.used / quota.total, 1) : 0
                        return (
                          <div className="kpi-tile" key={label}>
                            <span><Icon size={13} /> {label}</span>
                            <b>{quota.used.toLocaleString('ja-JP')}<small className="usage-total"> / {quota.total?.toLocaleString('ja-JP') ?? '-'}</small></b>
                            <div className={`usage-meter${ratio >= 0.8 ? ' high' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={quota.total || 0} aria-valuenow={quota.used} aria-label={`${label}の消費`}><i style={{ width: `${ratio * 100}%` }} /></div>
                            <small>残り {quota.total ? (quota.total - quota.used).toLocaleString('ja-JP') : '-'}件 · 直近{formatDuration(quota.durationSeconds) || '24時間'}</small>
                          </div>
                        )
                      })}
                    </section>
                  )}
                  {usage && usageTab === 'calls' && (() => {
                    const used = usage.calls?.total ?? 0
                    const total = usage.callLimit?.total
                    const ratio = total ? Math.min(used / total, 1) : 0
                    const appUsage = usage.appUsage
                    return (
                      <>
                        <section className="kpi-row" aria-label="API呼び出しの消費状況">
                          <div className="kpi-tile">
                            <span><Gauge size={13} /> このアプリの呼び出し</span>
                            <b>{used.toLocaleString('ja-JP')}<small className="usage-total"> / {total ? total.toLocaleString('ja-JP') : '-'}</small></b>
                            <div className={`usage-meter${ratio >= 0.8 ? ' high' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={total || 0} aria-valuenow={used} aria-label="API呼び出しの消費"><i style={{ width: `${ratio * 100}%` }} /></div>
                            <small>直近24時間 · 上限は 4,800 × 表示回数</small>
                          </div>
                          <div className="kpi-tile">
                            <span>表示回数(直近24時間)</span>
                            <b>{usage.callLimit ? usage.callLimit.impressions.toLocaleString('ja-JP') : '-'}</b>
                            <small>{usage.callLimit ? '10未満は10として計算' : '取得できませんでした'}</small>
                          </div>
                          <div className="kpi-tile">
                            <span>Meta の使用率</span>
                            <b>{appUsage ? `${Math.max(appUsage.call_count || 0, appUsage.total_cputime || 0, appUsage.total_time || 0)}%` : '余裕あり'}</b>
                            <small>{appUsage ? `呼び出し${appUsage.call_count ?? 0}% · CPU${appUsage.total_cputime ?? 0}% · 処理時間${appUsage.total_time ?? 0}%` : 'X-App-Usage は呼び出しが多くなると返る'}</small>
                          </div>
                        </section>
                        <dl className="usage-limits usage-breakdown">
                          {Object.entries(callCategoryLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{(usage.calls?.byCategory?.[key] || 0).toLocaleString('ja-JP')}回</dd></div>)}
                        </dl>
                        <p className="archive-note trend-note">このアプリから呼んだ回数だけを数えています(1時間単位で記録)。同じアカウントで別のアプリから呼んだ分は含まれません。</p>
                      </>
                    )
                  })()}
                  <div className="archive-footer"><span className="archive-note">{usage ? `${new Date(usage.checkedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に取得 · ` : ''}時刻ごとに区切らず、直近24時間の件数で数えます</span><button className="outline-button" disabled={isUsageLoading} onClick={loadUsage}>{isUsageLoading ? '読み込み中...' : '最新に更新'}</button></div>
                  <section className="archive-section">
                    <div className="section-heading compact"><div><p className="eyebrow">Meta の仕様とこのアプリ</p><h2>主な上限</h2></div></div>
                    <dl className="usage-limits">
                      <div><dt>投稿</dt><dd>1アカウントにつき直近24時間で{usage?.posts?.total?.toLocaleString('ja-JP') ?? '250'}件まで。上の数値は Threads から取得した実際の値です。</dd></div>
                      <div><dt>返信</dt><dd>1アカウントにつき直近24時間で{usage?.replies?.total?.toLocaleString('ja-JP') ?? '1,000'}件まで。</dd></div>
                      <div><dt>本文</dt><dd>1投稿500文字まで。</dd></div>
                      <div><dt>API呼び出し</dt><dd>直近24時間で「4,800 × 投稿の表示回数」回まで(Meta の仕様)。残りの回数は API から取得できないため、ここには表示していません。</dd></div>
                      <div><dt>このアプリの呼び出し数</dt><dd>投稿1回で2回(作成と公開)。投稿アーカイブの読み込みで「1 + 投稿数」回(最大{archiveLimit + 1}回)。この画面の表示で1回。</dd></div>
                      <div><dt>Cloudflare Workers</dt><dd>無料プランでは1リクエストあたり外部への呼び出しが50回まで。アーカイブの取得件数を増やすときに注意します。</dd></div>
                    </dl>
                  </section>
                  <section className="archive-section">
                    <div className="section-heading compact"><div><p className="eyebrow">Meta for Developers</p><h2>参照URL</h2></div></div>
                    <ul className="usage-references">
                      {usageReferences.map((item) => <li key={item.url}><a href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /><span><b>{item.label}</b><small>{item.url}</small></span></a></li>)}
                    </ul>
                  </section>
                </>
              )}
            </>
          )}
          {view === 'analytics' && (
            <>
              <section className="intro"><div><p className="eyebrow">最新{analyzedPosts.length || archiveLimit}件の投稿</p><h1>投稿の反応<span>。</span></h1><p className="subcopy">{analyzedPosts.length > 0 ? `投稿アーカイブで取得した最新${analyzedPosts.length}件をもとに集計しています。` : `投稿アーカイブで取得した最新${archiveLimit}件までをもとに集計します。`}</p></div></section>
              {!isConnected ? connectionCard : (
                <>
                  {analyzedPosts.length > 0 && (
                    <section className="kpi-row" aria-label="反応の合計">
                      <div className="kpi-tile"><span>集計した投稿</span><b>{analyzedPosts.length}</b><small>件</small></div>
                      <div className="kpi-tile"><span><Heart size={13} /> いいね</span><b>{totals.likes.toLocaleString('ja-JP')}</b><small>合計</small></div>
                      <div className="kpi-tile"><span><Repeat2 size={13} /> リポスト</span><b>{totals.reposts.toLocaleString('ja-JP')}</b><small>合計</small></div>
                      <div className="kpi-tile"><span><MessageCircle size={13} /> 返信</span><b>{totals.replies.toLocaleString('ja-JP')}</b><small>合計</small></div>
                      <div className="kpi-tile"><span><Heart size={13} /> 平均いいね</span><b>{(totals.likes / analyzedPosts.length).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}</b><small>1投稿あたり</small></div>
                    </section>
                  )}
                  <section className="archive-section">
                    <div className="section-heading compact"><div><p className="eyebrow">ランキング</p><h2>反応の多い投稿</h2></div></div>
                    <div className="recent-section">
                      {topPosts.map((item, index) => (
                        <div className="upcoming-row archive-row" key={item.id}>
                          <div className="date-block"><b>{index + 1}</b><span>位</span></div>
                          <div className="upcoming-content">
                            <div className="upcoming-meta"><span>{new Date(item.created_at).toLocaleDateString('ja-JP')}</span><span className="archive-metrics"><span><MessageCircle size={12} /> {item.public_metrics.reply_count}</span><span><Repeat2 size={12} /> {item.public_metrics.retweet_count}</span><span><Heart size={12} /> {item.public_metrics.like_count}</span></span></div>
                            <p>{item.text}</p>
                          </div>
                          <a className="more-button" href={platformInfo.postUrl(username, item)} target="_blank" rel="noreferrer" aria-label={`${platformInfo.label}で投稿を開く`}><ExternalLink size={16} /></a>
                        </div>
                      ))}
                      {analyzedPosts.length === 0 && !archiveError && <p className="archive-empty">{isArchiveLoading ? '読み込み中...' : `「読み込む」を押すと、最新${archiveLimit}件の投稿を取得して集計します。`}</p>}
                      {archiveError && <p className="archive-empty archive-error">{archiveError}</p>}
                      {archiveFooter}
                    </div>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </main>
      {notice && <div className={isNoticeError ? 'toast toast-error' : 'toast'} role={isNoticeError ? 'alert' : 'status'}>{isNoticeError ? <AlertCircle size={17} /> : <Check size={17} />} {notice}<button onClick={() => setNotice('')} aria-label="通知を閉じる"><X size={15} /></button></div>}
    </div>
    /*
      <section id="center">
        <div className="hero">
          <img src={heroImg} className="base" width="170" height="179" alt="" />
          <img src={reactLogo} className="framework" alt="React logo" />
          <img src={viteLogo} className="vite" alt="Vite logo" />
        </div>
        <div>
          <h1>Get started</h1>
          <p>
            Edit <code>src/App.jsx</code> and save to test <code>HMR</code>
          </p>
        </div>
        <button
          type="button"
          className="counter"
          onClick={() => setCount((count) => count + 1)}
        >
          Count is {count}
        </button>
      </section>

      <div className="ticks"></div>

      <section id="next-steps">
        <div id="docs">
          <svg className="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#documentation-icon"></use>
          </svg>
          <h2>Documentation</h2>
          <p>Your questions, answered</p>
          <ul>
            <li>
              <a href="https://vite.dev/" target="_blank">
                <img className="logo" src={viteLogo} alt="" />
                Explore Vite
              </a>
            </li>
            <li>
              <a href="https://react.dev/" target="_blank">
                <img className="button-icon" src={reactLogo} alt="" />
                Learn more
              </a>
            </li>
          </ul>
        </div>
        <div id="social">
          <svg className="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#social-icon"></use>
          </svg>
          <h2>Connect with us</h2>
          <p>Join the Vite community</p>
          <ul>
            <li>
              <a href="https://github.com/vitejs/vite" target="_blank">
                <svg
                  className="button-icon"
                  role="presentation"
                  aria-hidden="true"
                >
                  <use href="/icons.svg#github-icon"></use>
                </svg>
                GitHub
              </a>
            </li>
            <li>
              <a href="https://chat.vite.dev/" target="_blank">
                <svg
                  className="button-icon"
                  role="presentation"
                  aria-hidden="true"
                >
                  <use href="/icons.svg#discord-icon"></use>
                </svg>
                Discord
              </a>
            </li>
            <li>
              <a href="https://x.com/vite_js" target="_blank">
                <svg
                  className="button-icon"
                  role="presentation"
                  aria-hidden="true"
                >
                  <use href="/icons.svg#x-icon"></use>
                </svg>
                X.com
              </a>
            </li>
            <li>
              <a href="https://bsky.app/profile/vite.dev" target="_blank">
                <svg
                  className="button-icon"
                  role="presentation"
                  aria-hidden="true"
                >
                  <use href="/icons.svg#bluesky-icon"></use>
                </svg>
                Bluesky
              </a>
            </li>
          </ul>
        </div>
      </section>

      <div className="ticks"></div>
      <section id="spacer"></section>
    */
  )
}

export default App
