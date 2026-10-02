import { useEffect, useRef, useState } from 'react'
import { Archive, BarChart3, Heart, LogOut, MapPin, MessageCircle, Repeat2, Bell, CalendarDays, AlertCircle, Check, ChevronDown, Info, Clock3, Command, ExternalLink, FileText, Hash, Image, LayoutDashboard, Link2, MoreHorizontal, Paperclip, PenLine, Send, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import './App.css'

// サイドバーから切り替える画面(それ以外のハッシュは概要画面内の位置として扱う)
const pageTitles = { dashboard: '概要', compose: '作成', analytics: '分析', drafts: '下書き' }

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

// 予約が連携中のアカウントのものか。true/false、記録がない古い予約は null
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

function formatScheduledAt(value) {
  return new Date(value).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

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
  // accountId を渡すと、Worker 側でも連携中のアカウントと一致するか確認する
  const publishPost = async (text, target = platform, accountId = '') => {
    const label = platforms[target].label
    if (!text.trim() || !accounts[target].connected || isPosting) return false
    setIsPosting(true)
    let response
    let result
    try {
      response = await fetch(`/api/${target}/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, accountId }) })
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
    addNotification('success', `${label}へ投稿しました`, result.text)
    setIsNoticeError(false)
    setNotice(`${label}へ投稿しました`)
    updateArchive(target, (current) => ({ posts: [{ id: result.id, text: result.text, created_at: new Date().toISOString() }, ...current.posts].slice(0, archiveLimit) }))
    window.setTimeout(() => setNotice(''), 3000)
    return true
  }

  const handlePost = async () => {
    if (await publishPost(post)) {
      setPost('')
      finishEditingDraft()
    }
  }

  // 投稿・予約した下書きは一覧から消す
  const finishEditingDraft = () => {
    if (editingDraftId) setDrafts((current) => current.filter((item) => item.id !== editingDraftId))
    setEditingDraftId(null)
  }

  const handleSaveDraft = () => {
    const text = post.trim()
    if (!text) return
    const updatedAt = new Date().toISOString()
    if (editingDraftId && drafts.some((item) => item.id === editingDraftId)) {
      setDrafts((current) => current.map((item) => item.id === editingDraftId ? { ...item, text, updatedAt } : item))
    } else {
      const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, platform, text, createdAt: updatedAt, updatedAt }
      setDrafts((current) => [...current, item])
      setEditingDraftId(item.id)
    }
    setIsNoticeError(false)
    setNotice('下書きを保存しました')
    window.setTimeout(() => setNotice(''), 3000)
  }

  const openDraft = (item) => {
    setPost(item.text.slice(0, maxCharacters))
    setEditingDraftId(item.id)
    setIsScheduleOpen(false)
    window.location.hash = 'compose'
  }

  const removeDraft = (id) => {
    setDrafts((current) => current.filter((item) => item.id !== id))
    if (id === editingDraftId) setEditingDraftId(null)
  }

  const startNewPost = () => {
    setPost('')
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
    finishEditingDraft()
    setIsNoticeError(false)
    setNotice(`${formatScheduledAt(item.scheduledAt)} に予約しました`)
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
        <nav><p className="nav-label">メニュー</p><a className={view === 'dashboard' ? 'active' : undefined} href="#dashboard"><LayoutDashboard size={17} /> 概要</a><a className={view === 'compose' ? 'active' : undefined} href="#compose"><PenLine size={17} /> 作成 <span className="nav-count">1</span></a><a href="#calendar"><CalendarDays size={17} /> カレンダー</a><a className={view === 'analytics' ? 'active' : undefined} href="#analytics"><BarChart3 size={17} /> 分析</a><p className="nav-label">管理</p><a className={view === 'drafts' ? 'active' : undefined} href="#drafts"><FileText size={17} /> 下書き {sortedDrafts.length > 0 && <span className="nav-count muted">{sortedDrafts.length}</span>}</a><a href="#settings"><Settings2 size={17} /> 設定</a><a href="#archive"><Archive size={17} /> 投稿アーカイブ</a></nav>
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
            <section className="composer-grid"><div className="composer-card"><div className="composer-toolbar"><div className="account-pill"><span className="x-mini">{platformInfo.symbol}</span><span><b>{isConnected ? `@${username}` : `${platformInfo.label}アカウント`}</b><small>{platformInfo.label}へ投稿</small></span><ChevronDown size={14} /></div>{editingDraftId && <span className="draft-pill"><FileText size={13} /> 下書きを編集中</span>}<button className="more-button" aria-label="その他"><MoreHorizontal size={19} /></button></div><textarea value={post} onChange={(event) => setPost(event.target.value.slice(0, maxCharacters))} placeholder="世界に向けて発信しましょう…" /><div className="composer-footer"><div className="format-actions"><button aria-label="画像を追加"><Image size={19} /></button><button aria-label="ファイルを添付"><Paperclip size={19} /></button><button aria-label="ハッシュタグを追加"><Hash size={19} /></button><button aria-label="投稿を削除"><Trash2 size={18} /></button></div><div className="character-count"><span className={post.length > maxCharacters - 30 ? 'near-limit' : ''}>{post.length}</span> / {maxCharacters}<button className="schedule-button draft-save-button" disabled={!post.trim()} onClick={handleSaveDraft}><FileText size={16} /> 下書き保存</button><span className="schedule-wrap"><button className="schedule-button" disabled={!post.trim() || isOverLimit} aria-expanded={isScheduleOpen} onClick={() => isScheduleOpen ? setIsScheduleOpen(false) : openSchedule()}><Clock3 size={16} /> 予約投稿</button>{isScheduleOpen && (
                <form className="schedule-popover" onSubmit={handleSchedule}>
                  <label htmlFor="schedule-at">投稿する日時</label>
                  <input id="schedule-at" type="datetime-local" value={scheduleAt} min={toLocalInputValue(new Date())} onChange={(event) => setScheduleAt(event.target.value)} required />
                  <p>予約はこのブラウザに保存されます。</p>
                  <div><button type="button" className="outline-button" onClick={() => setIsScheduleOpen(false)}>キャンセル</button><button type="submit" className="post-button" disabled={!scheduleAt}>予約する</button></div>
                </form>
              )}</span><button className="post-button" disabled={!isConnected || !post.trim() || isOverLimit || isPosting} onClick={handlePost}><Send size={16} /> {isPosting ? '投稿中...' : '今すぐ投稿'}</button></div></div></div><aside className="preview-card"><div className="preview-label"><span>プレビュー</span><span className="live-dot">LIVE</span></div><div className="preview-post"><div className="preview-user"><span className="avatar peach">{initial}</span><div><b>{isConnected ? displayName : 'あなたのアカウント'}</b><span>@{isConnected ? username : 'username'} · 今</span></div><span className="preview-x">{platformInfo.symbol}</span></div><p>{post || '入力した投稿内容がここに表示されます。'}</p><div className="preview-actions"><span>♡ 0</span><span>↻ 0</span><span>♧ 0</span><MoreHorizontal size={15} /></div></div><div className="preview-tip"><Sparkles size={15} /><span><b>印象に残る投稿に</b><br />短く、わかりやすく、あなたらしく。</span></div></aside></section>
            </>
          )}
          {view === 'drafts' && (
            <>
              <section className="intro"><div><p className="eyebrow">{platformInfo.label} · このブラウザに保存</p><h1>下書き<span>。</span></h1><p className="subcopy">作成画面の「下書き保存」で保存した投稿です。クリックすると編集を再開できます。</p></div><a className="connect-button quick-compose" href="#compose" onClick={startNewPost}><PenLine size={16} /> 新規作成</a></section>
              <section className="archive-section">
                <div className="recent-section">
                  {sortedDrafts.length === 0 && <p className="archive-empty">下書きはありません。作成画面の「下書き保存」から追加できます。</p>}
                  {sortedDrafts.map((item) => {
                    const date = new Date(item.updatedAt)
                    return (
                      <div className="upcoming-row archive-row" key={item.id}>
                        <div className="date-block"><b>{date.getDate()}</b><span>{date.getMonth() + 1}月</span></div>
                        <button className="upcoming-content draft-open" onClick={() => openDraft(item)}>
                          <div className="upcoming-meta"><span className="draft-pill"><FileText size={13} /> 下書き</span><span>{date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} に保存 · {item.text.length}文字</span></div>
                          <p>{item.text}</p>
                        </button>
                        <div className="scheduled-actions">
                          <button className="more-button" onClick={() => openDraft(item)} aria-label="下書きを編集" title="下書きを編集"><PenLine size={16} /></button>
                          <button className="more-button" onClick={() => removeDraft(item.id)} aria-label="下書きを削除" title="下書きを削除"><Trash2 size={16} /></button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
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
