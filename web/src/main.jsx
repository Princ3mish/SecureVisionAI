import { useState, useRef, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Brain, ChevronRight, FileVideo, Play, Plus, RotateCcw, Search, Sparkles, Upload, Video, Zap, Shield, Radio, Eye } from 'lucide-react'
import './styles.css'

const API = 'http://localhost:8001'
const formatTime = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`

export default function App() {
  const videoRef = useRef(null)
  const [file, setFile] = useState(null)
  const [url, setUrl] = useState('')
  const [interval, setIntervalValue] = useState(5)
  const [query, setQuery] = useState('missile launch')
  const [results, setResults] = useState([])
  const [stats, setStats] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Ready to build your video index.')
  const [isIndexed, setIsIndexed] = useState(false)
  const [activeMoment, setActiveMoment] = useState(null)
  const [currentTime, setCurrentTime] = useState(0)

  // Navigation state: 'landing' | 'upload' | 'studio'
  const [currentView, setCurrentView] = useState('landing')
  
  // Skeleton loader testing state (allows previewing loading state)
  const [showSkeletons, setShowSkeletons] = useState(false)

  // Check health on mount to see if an active video & index already exists
  useEffect(() => {
    async function checkHealth() {
      try {
        const res = await fetch(`${API}/api/health`)
        if (res.ok) {
          const data = await res.json()
          if (data.ready && data.video) {
            setIsIndexed(true)
            setCurrentView('studio')
            setMessage('Existing index loaded and ready to search.')
          }
        }
      } catch (err) {
        console.warn('Backend not ready yet:', err)
      }
    }
    checkHealth()
  }, [])

  // IntersectionObserver for lightweight entrance animations on scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
          }
        })
      },
      { threshold: 0.15 }
    )

    const elements = document.querySelectorAll('.reveal-on-scroll')
    elements.forEach((el) => observer.observe(el))

    return () => observer.disconnect()
  }, [currentView])

  async function processVideo(event) {
    event.preventDefault()
    setBusy(true)
    setMessage('Initiating video processing…')
    const form = new FormData()
    if (file) form.append('video', file)
    if (url) form.append('url', url)
    form.append('interval', interval)
    try {
      const response = await fetch(`${API}/api/process`, { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Failed to start processing')

      const taskId = data.task_id
      setMessage('Processing started in background…')

      const poll = setInterval(async () => {
        try {
          const res = await fetch(`${API}/api/status/${taskId}`)
          if (!res.ok) throw new Error('Failed to fetch task status')
          const task = await res.json()

          if (task.status === 'completed') {
            clearInterval(poll)
            setStats(task.result)
            setIsIndexed(true)
            setCurrentView('studio')
            setMessage(`Index ready · ${task.result.frames} frames · ${task.result.segments} transcript segments · ${task.result.device}`)
            setBusy(false)
            if (videoRef.current) {
              videoRef.current.load()
            }
          } else if (task.status === 'failed') {
            clearInterval(poll)
            setMessage(`Error: ${task.error}`)
            setBusy(false)
          } else {
            setMessage(task.stage || 'Processing video…')
          }
        } catch (pollErr) {
          clearInterval(poll)
          setMessage(`Status error: ${pollErr.message}`)
          setBusy(false)
        }
      }, 1000)
    } catch (error) {
      setMessage(error.message)
      setBusy(false)
    }
  }

  async function searchVideo(event) {
    event.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    setMessage('Searching the visual and audio index…')
    try {
      const response = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}&top_k=6`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Search failed')
      setResults(data.results)
      setMessage(`${data.results.length} relevant moments found.`)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  function seekTo(timestamp, result) {
    if (videoRef.current) {
      videoRef.current.currentTime = timestamp
      videoRef.current.play()
    }
    setActiveMoment(result)
  }

  function resetWorkspace() {
    setIsIndexed(false)
    setStats(null)
    setResults([])
    setActiveMoment(null)
    setFile(null)
    setUrl('')
    setMessage('Ready to build your video index.')
    setCurrentView('upload')
  }

  // Calculate percentage for range tooltip position
  const sliderPercentage = ((interval - 2) / (20 - 2)) * 100

  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand" onClick={() => setCurrentView(isIndexed ? 'studio' : 'landing')}>
          <span className="brand-mark"><Brain size={19}/></span>
          Moment<span className="muted">/</span>Seek
        </div>
        <div className="nav-right">
          <button
            className={`nav-link ${currentView === 'landing' ? 'active' : ''}`}
            onClick={() => setCurrentView('landing')}
          >
            Landing
          </button>
          <button
            className={`nav-link ${currentView === 'upload' ? 'active' : ''}`}
            onClick={() => setCurrentView('upload')}
          >
            Upload
          </button>
          <button
            className={`nav-link ${currentView === 'studio' ? 'active' : ''}`}
            onClick={() => setCurrentView('studio')}
          >
            Studio
          </button>
          {isIndexed && (
            <button className="btn-secondary" onClick={resetWorkspace} title="Replace index with a new video">
              <Plus size={14}/> New Video
            </button>
          )}
          <div className="nav-pill">
            <span className="pulse"/> LOCAL AI STUDIO
          </div>
        </div>
      </nav>

      {/* VIEW 1: LANDING PAGE */}
      {currentView === 'landing' && (
        <section className="landing-view">
          <div className="landing-hero">
            <div>
              <div className="eyebrow"><Sparkles size={14}/> Multimodal Video Intelligence</div>
              <h1 className="landing-title">
                Find the moment.<br/>
                <span style={{ color: 'var(--accent-highlight)' }}>Not the whole video.</span>
              </h1>
              <p className="landing-subhead">
                Pinpoint exact scenes or audio moments instantly with high-performance local AI transcription and visual frame search.
              </p>
              <button className="btn-primary" onClick={() => setCurrentView('upload')}>
                <Zap size={17} /> Build Video Index <ChevronRight size={17} />
              </button>
            </div>

            {/* NEW HERO ANIMATION: Frames ejecting from source video */}
            <div className="hero-frames-graphic">
              {/* Central Source Video Box */}
              <div className="source-video-box">
                <div className="source-video-icon">
                  <Play size={16} fill="currentColor" />
                </div>
                <span className="source-video-label">SOURCE VIDEO</span>
              </div>

              {/* 4 Ejecting Frame Thumbnails */}
              <div className="eject-frame eject-frame-1">
                <div className="eject-frame-bar" />
                <div className="eject-frame-content">
                  <span className="eject-frame-tag">00:04.2</span>
                </div>
              </div>

              <div className="eject-frame eject-frame-2">
                <div className="eject-frame-bar" />
                <div className="eject-frame-content">
                  <span className="eject-frame-tag">00:12.8</span>
                </div>
              </div>

              <div className="eject-frame eject-frame-3">
                <div className="eject-frame-bar" />
                <div className="eject-frame-content">
                  <span className="eject-frame-tag">00:27.5</span>
                </div>
              </div>

              <div className="eject-frame eject-frame-4">
                <div className="eject-frame-bar" />
                <div className="eject-frame-content">
                  <span className="eject-frame-tag">00:41.0</span>
                </div>
              </div>
            </div>
          </div>

          <div className="features-section">
            <div className="features-header">
              <h2>Engineered for Instant Video Search</h2>
              <p>Multimodal intelligence executing 100% locally on your workstation</p>
            </div>

            <div className="features-grid">
              <div className="feature-card reveal-on-scroll">
                <div className="feature-icon">
                  <Radio size={22} />
                </div>
                <h3>Audio & Speech Search</h3>
                <p>Transcribe and match spoken dialogue instantly using Whisper embeddings for exact keyword and semantic moments.</p>
              </div>

              <div className="feature-card reveal-on-scroll">
                <div className="feature-icon">
                  <Eye size={22} />
                </div>
                <h3>Visual & Scene Search</h3>
                <p>Scan video frames with BLIP visual models to locate objects, actions, logos, and key visual moments.</p>
              </div>

              <div className="feature-card reveal-on-scroll">
                <div className="feature-icon">
                  <Shield size={22} />
                </div>
                <h3>100% Local & Private</h3>
                <p>Zero cloud uploads. All index vectors, frames, and audio tensors stay completely private on your machine.</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* VIEW 2: UPLOAD VIEW */}
      {currentView === 'upload' && (
        <section className="upload-workspace">
          <aside className="panel source-panel">
            <div className="panel-heading">
              <span className="step">01</span>
              <div>
                <h2>Build your index</h2>
                <p>Provide a local video file or URL to index visual frames and transcript audio.</p>
              </div>
            </div>
            <form onSubmit={processVideo}>
              <label className="dropzone">
                {file ? (
                  <>
                    <FileVideo size={28}/>
                    <strong>{file.name}</strong>
                    <small>Video file selected</small>
                  </>
                ) : (
                  <>
                    <Upload size={28}/>
                    <strong>Drop a video file here</strong>
                    <small>MP4, WebM, or MOV formats supported</small>
                  </>
                )}
                <input type="file" accept="video/*" onChange={e => setFile(e.target.files[0])}/>
              </label>
              
              <div className="or"><span>OR PROVIDE A URL</span></div>
              
              <input
                className="text-input"
                placeholder="https://youtube.com/watch?..."
                value={url}
                onChange={e => setUrl(e.target.value)}
              />

              <div className="range-container">
                <div className="range-label">
                  <span>Frame Sampling Interval</span>
                  <b>{interval}s</b>
                </div>
                <div className="range-wrapper">
                  <div
                    className="range-tooltip"
                    style={{ left: `${sliderPercentage}%` }}
                  >
                    {interval}s
                  </div>
                  <input
                    className="range"
                    type="range"
                    min="2"
                    max="20"
                    value={interval}
                    onChange={e => setIntervalValue(Number(e.target.value))}
                  />
                </div>
              </div>

              <button className="btn-primary" style={{ width: '100%' }} disabled={busy}>
                <Zap size={17}/> {busy ? 'Processing Video…' : 'Build Searchable Index'}
                <ChevronRight size={17}/>
              </button>
            </form>

            <div className="status">
              <span className={busy ? 'status-dot working' : 'status-dot'}/>
              <span>{message}</span>
            </div>
          </aside>
        </section>
      )}

      {/* VIEW 3: STUDIO WORKSPACE */}
      {currentView === 'studio' && (
        <section className="studio-workspace">
          {/* Left Column: Interactive Video Player */}
          <aside className="panel player-panel">
            <div className="panel-heading" style={{ marginBottom: '14px' }}>
              <span className="step"><Video size={14}/></span>
              <div>
                <h2>Timeline Player</h2>
                <p>Click any moment in search results to jump immediately to that playhead.</p>
              </div>
            </div>

            <div className="video-container">
              <video
                ref={videoRef}
                src={`${API}/media/video.mp4`}
                controls
                playsInline
                onTimeUpdate={() => {
                  if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
                }}
              />
            </div>

            <div className="player-bar">
              <div className="player-time">
                {formatTime(currentTime)} <span style={{ color: 'var(--text-dim)', fontWeight: 'normal' }}>playhead</span>
              </div>
              <div className="player-info">
                {activeMoment ? (
                  <span>Selected: <b>{formatTime(activeMoment.timestamp)}</b></span>
                ) : (
                  <span>Player Ready</span>
                )}
              </div>
            </div>

            {stats && (
              <div className="stats">
                <span><b>{stats.frames}</b> frames indexed</span>
                <span><b>{stats.segments}</b> audio moments</span>
                <span><b>{stats.device}</b> device</span>
              </div>
            )}
          </aside>

          {/* Right Column: Search & Interactive Results */}
          <section className="panel search-panel">
            <div className="panel-heading">
              <span className="step">02</span>
              <div>
                <h2>Search Moments</h2>
                <p>Query what was shown or spoken in this video.</p>
              </div>
            </div>

            <form className="searchbar" onSubmit={searchVideo}>
              <Search size={18}/>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Try: missile launch, explosion, speech..."
              />
              <button className="btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }} disabled={busy}>
                <Search size={15}/> Search
              </button>
            </form>

            <div className="results-header">
              <span className="results-count">
                {busy ? 'Searching index...' : results.length ? `${results.length} relevant moments` : 'Moments timeline'}
              </span>
              <button
                className="skeleton-toggle-btn"
                onClick={() => setShowSkeletons(!showSkeletons)}
                title="Toggle loading skeleton preview"
              >
                {showSkeletons ? 'Hide Skeleton Preview' : 'Preview Loading Skeletons'}
              </button>
            </div>

            <div className="results">
              {busy || showSkeletons ? (
                // SKELETON LOADERS
                <>
                  {[1, 2, 3, 4].map((n) => (
                    <div className="skeleton-card" key={n}>
                      <div className="skeleton-thumb skeleton-shimmer" />
                      <div className="skeleton-content">
                        <div className="skeleton-line short skeleton-shimmer" />
                        <div className="skeleton-line full skeleton-shimmer" />
                        <div className="skeleton-line medium skeleton-shimmer" />
                      </div>
                    </div>
                  ))}
                </>
              ) : results.length ? (
                results.map((result, i) => {
                  const isSelected = activeMoment && activeMoment.timestamp === result.timestamp
                  return (
                    <article
                      className={`result ${isSelected ? 'active' : ''}`}
                      key={`${result.timestamp}-${i}`}
                      onClick={() => seekTo(result.timestamp, result)}
                    >
                      <div className="result-main">
                        <div className="thumb">
                          {result.frame && <img src={`${API}${result.frame}`} alt="Frame preview"/>}
                          <div className="thumb-play">
                            <Play size={20} fill="currentColor"/>
                          </div>
                        </div>
                        <div className="result-copy">
                          <div className="result-meta">
                            <span className="rank">#{i + 1}</span>
                            <span className="time-tag">{formatTime(result.timestamp)}</span>
                            <span className="score">match {(1 / (1 + result.distance)).toFixed(2)}</span>
                          </div>
                          <p>{result.text}</p>
                        </div>
                      </div>

                      {isSelected && (
                        <div className="result-expanded-detail">
                          <span className="detail-badge">
                            <Play size={12} fill="currentColor"/> Seeking playhead to {formatTime(result.timestamp)}
                          </span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-highlight)' }}>
                            Active Moment
                          </span>
                        </div>
                      )}
                    </article>
                  )
                })
              ) : (
                <div className="empty">
                  <div className="empty-icon"><Search size={25}/></div>
                  <h3>Your moments will appear here</h3>
                  <p>Type a query above to jump directly to matching scenes or audio.</p>
                </div>
              )}
            </div>
          </section>
        </section>
      )}

      <footer>
        <span>Powered by Whisper · BLIP · FAISS</span>
        <span>Moment-Seek Local Studio</span>
      </footer>
    </main>
  )
}

const container = document.getElementById('root')
if (!container._reactRoot) {
  container._reactRoot = createRoot(container)
}
container._reactRoot.render(<App />)
