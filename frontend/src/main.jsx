import { useState, useRef, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Brain, ChevronRight, FileVideo, Play, Plus, RotateCcw, Search, Sparkles, Upload, Video, Zap, Shield, Radio, Eye, CheckCircle2, Star, Layers, Key, X, ExternalLink, Cpu, Database } from 'lucide-react'
import './styles.css'

const API = 'http://127.0.0.1:8000'
const formatTime = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`

export default function App() {
  const videoRef = useRef(null)
  const [file, setFile] = useState(null)
  const [url, setUrl] = useState('')
  const [interval, setIntervalValue] = useState(5)
  const [context, setContext] = useState('')
  const [videoContext, setVideoContext] = useState('')
  const [workflow, setWorkflow] = useState([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [stats, setStats] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Ready to build your video index.')
  const [isIndexed, setIsIndexed] = useState(false)
  const [activeMoment, setActiveMoment] = useState(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [videoVersion, setVideoVersion] = useState(Date.now())

  // AI-Assisted vs Non-AI Assisted mode toggle (Default: Non-AI running locally on system)
  const [aiMode, setAiMode] = useState(false)

  // Groq API integration state
  const [groqEnabled, setGroqEnabled] = useState(false)
  const [showKeyModal, setShowKeyModal] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [maskedKey, setMaskedKey] = useState('')

  // Navigation state: 'landing' | 'upload' | 'studio'
  const [currentView, setCurrentView] = useState('landing')
  
  // Skeleton loader testing state (allows previewing loading state)
  const [showSkeletons, setShowSkeletons] = useState(false)

  // Check health and settings on mount
  useEffect(() => {
    async function checkHealth() {
      try {
        const res = await fetch(`${API}/api/health`)
        if (res.ok) {
          const data = await res.json()
          if (data.ready && data.video) {
            setIsIndexed(true)
            setVideoVersion(Date.now())
            if (data.context) {
              setVideoContext(data.context)
              setContext(data.context)
            }
            setMessage('Existing index loaded and ready to search.')
          }
          if (data.groq_enabled) {
            setGroqEnabled(true)
          }
        }

        const settingsRes = await fetch(`${API}/api/settings`)
        if (settingsRes.ok) {
          const sData = await settingsRes.json()
          setGroqEnabled(sData.groq_configured)
          setMaskedKey(sData.groq_key_masked)
        }
      } catch (err) {
        console.warn('Backend not ready yet:', err)
      }
    }
    checkHealth()
  }, [])

  async function saveGroqKey(e) {
    e.preventDefault()
    try {
      const form = new FormData()
      form.append('groq_api_key', apiKeyInput.trim())
      const res = await fetch(`${API}/api/settings`, { method: 'POST', body: form })
      const data = await res.json()
      if (data.saved) {
        setGroqEnabled(data.groq_configured)
        setShowKeyModal(false)
        setMessage(data.groq_configured ? 'Groq Llama-3.2 Vision & Reasoning activated!' : 'Groq key removed. Using local models.')
      }
    } catch (err) {
      console.error(err)
    }
  }

  // Handle switching between AI Assisted and Non-AI Assisted mode
  function handleModeChange(newMode) {
    setAiMode(newMode)
    if (query.trim() && isIndexed) {
      searchVideo(null, newMode)
    }
  }

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
    setMessage(aiMode ? 'Initiating video processing with AI assistance…' : 'Initiating video processing in non-AI local mode…')
    const form = new FormData()
    if (file) form.append('video', file)
    if (url) form.append('url', url)
    form.append('interval', interval)
    if (context.trim()) form.append('context', context.trim())
    form.append('ai_mode', aiMode)

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
            setVideoContext(context.trim())
            setWorkflow([])
            setVideoVersion(Date.now())
            setQuery('')
            setResults([])
            setActiveMoment(null)
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

  async function searchVideo(event, overrideAiMode = null) {
    if (event) event.preventDefault()
    if (!query.trim()) return
    const activeMode = overrideAiMode !== null ? overrideAiMode : aiMode
    setBusy(true)
    setMessage(activeMode ? 'Executing AI-assisted retrieval workflow (Groq Secret Key)...' : 'Executing non-AI vector search locally on system (FAISS)...')
    try {
      const response = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}&top_k=6&ai_mode=${activeMode}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Search failed')
      setResults(data.results || [])
      if (data.workflow) setWorkflow(data.workflow)
      if (data.context) setVideoContext(data.context)
      setMessage(`${data.results.length} moments found (${activeMode ? 'AI-Assisted via Groq' : 'Running Locally on System'}).`)
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
    setContext('')
    setVideoContext('')
    setWorkflow([])
    setQuery('')
    setMessage('Ready to build your video index.')
    setCurrentView('upload')
  }

  // Calculate percentage for range tooltip position
  const sliderPercentage = ((interval - 2) / (20 - 2)) * 100

  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand" onClick={() => setCurrentView('landing')}>
          <span className="brand-mark"><Shield size={19}/></span>
          Secure<span className="muted">/</span>Vision
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

          {/* AI-Assisted vs Non-AI Assisted Segmented Switcher */}
          <div className="mode-toggle-group" role="group" aria-label="Engine Mode">
            <button
              type="button"
              className={`mode-toggle-btn ${!aiMode ? 'is-active non-ai-mode' : ''}`}
              onClick={() => handleModeChange(false)}
              title="Preferable: Non-AI Mode running locally using local system models"
            >
              <Cpu size={12} />
              <span>Non-AI (Local)</span>
            </button>
            <button
              type="button"
              className={`mode-toggle-btn ${aiMode ? 'is-active ai-mode' : ''}`}
              onClick={() => handleModeChange(true)}
              title="AI Mode: Uses Groq API secret key for enhanced reasoning"
            >
              <Sparkles size={12} className={aiMode ? "sparkle-icon-active" : ""} />
              <span>AI Mode (Groq)</span>
            </button>
          </div>

          {isIndexed && (
            <button className="btn-secondary" onClick={resetWorkspace} title="Replace index with a new video">
              <Plus size={14}/> New Video
            </button>
          )}

          <button
            className={`groq-toggle-pill ${groqEnabled ? 'is-active' : ''}`}
            onClick={() => setShowKeyModal(true)}
            title="Configure Groq Cloud API Key"
          >
            <Zap size={13} className={groqEnabled ? "groq-active-zap" : ""}/>
            <span>{groqEnabled ? "GROQ KEY SET" : "CONNECT GROQ"}</span>
          </button>
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
                Pinpoint exact scenes or audio moments instantly with dual retrieval engines: <b>Non-AI mode running 100% locally</b> on your system models, or <b>AI-assisted mode</b> using your Groq secret key for enhanced multimodal reasoning.
              </p>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <button className="btn-primary" onClick={() => setCurrentView('upload')}>
                  <Zap size={17} /> Build Video Index <ChevronRight size={17} />
                </button>
                {isIndexed && (
                  <button className="btn-secondary" onClick={() => setCurrentView('studio')}>
                    <Play size={17} /> Open Studio <ChevronRight size={17} />
                  </button>
                )}
              </div>
            </div>

            {/* Central Source Video Box with Frames Graphic */}
            <div className="hero-frames-graphic">
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
              <h2>Engineered for Dual Search Intelligence</h2>
              <p>Run locally on your system by default, or enable AI mode with your Groq API secret key</p>
            </div>

            <div className="features-grid">
              <div className="feature-card reveal-on-scroll">
                <div className="feature-icon feature-icon-local">
                  <Cpu size={22} />
                </div>
                <h3>Non-AI Mode (Preferred Local Default)</h3>
                <p>Runs 100% on your system using local FAISS and SentenceTransformers. Zero Groq API calls, zero cloud dependency, and total data privacy.</p>
              </div>

              <div className="feature-card reveal-on-scroll">
                <div className="feature-icon feature-icon-ai">
                  <Sparkles size={22} />
                </div>
                <h3>AI Mode (Groq API Key)</h3>
                <p>When enabled, utilizes your secret Groq key to run Llama-3.2 Multimodal Vision and Llama-3.3 reasoning for subtle gestures, photobombs, and emotions.</p>
              </div>

              <div className="feature-card reveal-on-scroll">
                <div className="feature-icon">
                  <Shield size={22} />
                </div>
                <h3>100% Local Storage & Vectors</h3>
                <p>All video frames, FAISS indexes, and extracted audio tensors remain safely saved directly on your workstation.</p>
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

              {/* Video Context Input */}
              <div className="context-card">
                <div className="context-card-header">
                  <div className="context-title">
                    <Sparkles size={16} className="context-icon" />
                    <span>Video Context / Description</span>
                    <span className="optional-badge">Optional</span>
                  </div>
                  <span className={`context-boost-pill ${aiMode ? 'ai-pill' : 'non-ai-pill'}`}>
                    {aiMode ? (groqEnabled ? "⚡ Groq Vision Enabled" : "AI Mode Active") : "⚙️ Local Non-AI Mode"}
                  </span>
                </div>
                <p className="context-desc">
                  {aiMode 
                    ? "In AI Assisted mode, Groq Multimodal Vision (Llama-3.2) inspects each frame's visual actions and people in detail to accurately spot actions like photobombing, sneaks, and reactions."
                    : "In Non-AI mode, frames are indexed with local BLIP models and searched using pure mathematical vector distance without cloud LLM inference."}
                </p>
                <textarea
                  className="context-textarea"
                  rows={3}
                  value={context}
                  onChange={e => setContext(e.target.value)}
                  placeholder="e.g. The actress was photobombing her fans who were taking a photo together..."
                />
              </div>

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
                <Zap size={17}/> {busy ? 'Processing Video…' : `Build Index (${aiMode ? 'AI Assisted (Groq)' : 'Non-AI (Local System)'})`}
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
                src={`${API}/media/video.mp4?v=${videoVersion}`}
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
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <h2>Search Moments</h2>
                  <span className={`engine-badge-tag ${aiMode ? 'ai-tag' : 'non-ai-tag'}`}>
                    {aiMode ? '⚡ AI Mode (Groq Key)' : '⚙️ Non-AI (Local System)'}
                  </span>
                </div>
                <p>Query what was shown or spoken in this video.</p>
              </div>
            </div>

            {/* Prominent Live Engine Mode Status & Switcher Card */}
            <div className={`engine-control-banner ${aiMode ? 'ai-active' : 'local-active'}`}>
              <div className="engine-status-info">
                <div className="engine-status-headline">
                  <span className={aiMode ? "engine-indicator-dot ai" : "engine-indicator-dot local"} />
                  <strong>
                    {aiMode ? "AI Mode Active (Groq Secret Key Enabled)" : "Non-AI Mode Active (Running Locally on System)"}
                  </strong>
                </div>
                <p className="engine-status-subtext">
                  {aiMode 
                    ? "Using secret Groq API key from .env for Llama-3.2 Multimodal Vision & Llama-3.3 semantic reasoning for superior results."
                    : "Running 100% locally using system models (FAISS + MiniLM). Zero Groq API calls made. Completely private."}
                </p>
              </div>
              
              <div className="engine-action-switch">
                <button
                  type="button"
                  className={`engine-switch-btn ${!aiMode ? 'selected-local' : ''}`}
                  onClick={() => handleModeChange(false)}
                  title="Run retrieval locally using system models without Groq API"
                >
                  <Cpu size={13} />
                  <span>Local Non-AI</span>
                </button>
                <button
                  type="button"
                  className={`engine-switch-btn ${aiMode ? 'selected-ai' : ''}`}
                  onClick={() => handleModeChange(true)}
                  title="Use secret Groq API key for enhanced reasoning"
                >
                  <Sparkles size={13} />
                  <span>Groq AI Mode</span>
                </button>
              </div>
            </div>

            {/* Active Context Banner */}
            {videoContext && (
              <div className="active-context-banner">
                <div className="active-context-tag">
                  <Sparkles size={13} />
                  <span>Context Enabled</span>
                </div>
                <div className="active-context-text">
                  "{videoContext}"
                </div>
              </div>
            )}

            <form className="searchbar" onSubmit={searchVideo}>
              <Search size={18}/>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={aiMode 
                  ? "Search dialogue, visual actions, emotions, or scenes (Groq AI Key active)..." 
                  : "Search dialogue or visual keywords (Running locally on system)..."}
              />
              <button className="btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }} disabled={busy}>
                <Search size={15}/> Search
              </button>
            </form>

            {/* Multimodal Retrieval Workflow Display - Different for AI vs Non-AI mode */}
            {workflow.length > 0 && (
              <div className={`retrieval-workflow-card ${aiMode ? 'ai-workflow-card' : 'non-ai-workflow-card'}`}>
                <div className="workflow-card-header">
                  <div className="workflow-card-title">
                    {aiMode ? <Sparkles size={14} className="workflow-title-icon-ai" /> : <Layers size={14} className="workflow-title-icon-non-ai" />}
                    <span>{aiMode ? 'AI-Assisted Neural Workflow' : 'Non-AI Deterministic Workflow'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span className={`workflow-mode-pill ${aiMode ? 'ai-pill' : 'non-ai-pill'}`}>
                      {aiMode ? '⚡ Groq Llama-3.3 (Secret Key)' : '⚙️ Pure System FAISS (Local)'}
                    </span>
                    {videoContext && (
                      <span className="workflow-mode-pill context-pill">Context-Guided</span>
                    )}
                  </div>
                </div>
                <div className="workflow-stepper">
                  {workflow.map((step, sIdx) => (
                    <div className={`workflow-step-node ${step.active ? 'is-active' : ''} ${aiMode ? 'ai-node' : 'non-ai-node'}`} key={step.id || sIdx}>
                      <div className={`step-node-bubble ${aiMode ? 'bubble-ai' : 'bubble-non-ai'}`}>
                        <CheckCircle2 size={13} />
                      </div>
                      <div className="step-node-content">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                          <span className="step-node-title">{step.title}</span>
                          {step.engine && (
                            <span className="step-engine-tag">{step.engine}</span>
                          )}
                        </div>
                        <span className="step-node-detail">{step.detail}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="results-header">
              <span className="results-count">
                {busy 
                  ? (aiMode ? 'Running Groq AI reasoning workflow...' : 'Running local FAISS Euclidean search...') 
                  : results.length ? `${results.length} relevant moments found (${aiMode ? 'AI Mode via Groq Key' : 'Non-AI Local System'})` : 'Moments timeline'}
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
                  const matchPct = Math.round((result.score || (1 / (1 + result.distance))) * 100)
                  return (
                    <article
                      className={`result ${isSelected ? 'active' : ''} ${result.is_preferred ? (aiMode ? 'preferred-result' : 'preferred-result-non-ai') : ''}`}
                      key={`${result.timestamp}-${i}`}
                      onClick={() => seekTo(result.timestamp, result)}
                    >
                      {result.is_preferred && (
                        <div className={aiMode ? "preferred-banner" : "preferred-banner-non-ai"}>
                          <div className={aiMode ? "preferred-label" : "preferred-label-non-ai"}>
                            {aiMode ? <Star size={13} fill="currentColor" /> : <CheckCircle2 size={13} />}
                            <span>{aiMode ? "AI Selected Preferred Moment" : "Top Ranked Local Vector Match"}</span>
                          </div>
                          <span className={aiMode ? "preferred-badge-pill" : "preferred-badge-pill-non-ai"}>
                            {aiMode ? `${matchPct}% Relevance` : `dist: ${result.distance.toFixed(3)}`}
                          </span>
                        </div>
                      )}

                      {aiMode && result.ai_reasoning && (
                        <div className="ai-reasoning-callout">
                          <Sparkles size={14} className="reasoning-sparkle" />
                          <div className="reasoning-text">
                            <strong>AI Moment Insight:</strong> {result.ai_reasoning}
                          </div>
                        </div>
                      )}

                      <div className="result-main">
                        <div className="thumb">
                          {result.frame ? (
                            <img
                              src={`${API}${result.frame}${result.frame.includes('?') ? '&' : '?'}v=${videoVersion}`}
                              alt="Frame preview"
                              loading="lazy"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none'
                                const fb = e.currentTarget.parentElement.querySelector('.thumb-fallback')
                                if (fb) fb.style.display = 'flex'
                              }}
                            />
                          ) : null}
                          <div className="thumb-fallback" style={{ display: result.frame ? 'none' : 'flex' }}>
                            {result.text.startsWith('Auditory:') ? <Radio size={18} /> : <Eye size={18} />}
                            <span>{result.text.startsWith('Auditory:') ? 'Audio Moment' : 'Scene Frame'}</span>
                          </div>
                          <div className="thumb-play">
                            <Play size={20} fill="currentColor"/>
                          </div>
                        </div>
                        <div className="result-copy">
                          <div className="result-meta">
                            <span className="rank">#{i + 1}</span>
                            <span className="time-tag">{formatTime(result.timestamp)}</span>
                            {result.text.startsWith('Auditory:') ? (
                              <span className="kind-badge kind-audio"><Radio size={11}/> Audio</span>
                            ) : (
                              <span className="kind-badge kind-visual"><Eye size={11}/> Visual</span>
                            )}
                            <span className="score">
                              {aiMode ? `match ${matchPct}%` : `similarity ${matchPct}% (L2 ${result.distance.toFixed(2)})`}
                            </span>
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
        <span>Engine: {aiMode ? 'AI Assisted (Groq Secret Key Active)' : 'Non-AI (Running Locally on System)'} · FAISS · Whisper · BLIP</span>
        <span>Secure Vision Local Studio</span>
      </footer>

      {/* Groq API Key Configuration Modal */}
      {showKeyModal && (
        <div className="modal-backdrop" onClick={() => setShowKeyModal(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <Zap size={18} className="modal-icon" />
                <h3>Groq Cloud API Settings</h3>
              </div>
              <button className="modal-close" onClick={() => setShowKeyModal(false)}>
                <X size={18} />
              </button>
            </div>
            
            <p className="modal-subtitle">
              Power your video search with ultra-fast <b>Llama 3.2 Multimodal Vision</b> and <b>Llama 3.3 Reasoning</b> to understand complex actions like photobombing, sneaks, gestures, and reactions.
            </p>

            <form onSubmit={saveGroqKey}>
              <div className="modal-field-group">
                <div className="field-label-row">
                  <span>Groq API Key</span>
                  <a
                    href="https://console.groq.com/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="key-link"
                  >
                    Get Free Key <ExternalLink size={12} />
                  </a>
                </div>
                <input
                  type="password"
                  className="modal-key-input"
                  placeholder={maskedKey ? `Current: ${maskedKey}` : "gsk_..."}
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                />
                <span className="field-help-note">
                  Saved directly to <code>backend/.env</code> on your local device.
                </span>
              </div>

              <div className="modal-actions">
                {groqEnabled && (
                  <button
                    type="button"
                    className="btn-modal-clear"
                    onClick={() => {
                      setApiKeyInput('')
                      saveGroqKey({ preventDefault: () => {} })
                    }}
                  >
                    Clear Key
                  </button>
                )}
                <button type="submit" className="btn-primary" style={{ marginLeft: 'auto' }}>
                  Save & Activate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  )
}

const container = document.getElementById('root')
if (!container._reactRoot) {
  container._reactRoot = createRoot(container)
}
container._reactRoot.render(<App />)
