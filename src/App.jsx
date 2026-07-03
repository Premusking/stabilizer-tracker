import { useState, useEffect, useCallback } from 'react'

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ES = 'https://api-sepolia.etherscan.io/api'
const POOLS = [
  { id:'T-Pool', pair:'USDT/USDZ', addr:'0x7C348b70F640B47b64ecDb154960D337ce7a98B4', color:'#1D9E74' },
  { id:'C-Pool', pair:'USDC/USDZ', addr:'0x0578E5EA652C62DB20F4475F685A4b587314A30f', color:'#2563EB' },
  { id:'S-Pool', pair:'USDS/USDZ', addr:'0xC94fbB2C1Da52F8561A829a4838f117DD7316F54', color:'#7C3AED' },
  { id:'P-Pool', pair:'PYUSD/USDZ',addr:'0x7Dd6979749b60C60eaaa55e4A50e732DAbc5DdD3',color:'#DB2777' },
]
const POOL_ADDRS = POOLS.map(p => p.address?.toLowerCase() || p.addr.toLowerCase())
const poolByAddr = addr => POOLS.find(p => p.addr.toLowerCase() === addr?.toLowerCase())

// ─── ETHERSCAN HELPERS ────────────────────────────────────────────────────────
async function esGet(params) {
  try {
    const qs = new URLSearchParams({ ...params, sort:'desc' }).toString()
    const r = await fetch(`${ES}?${qs}`)
    const j = await r.json()
    return Array.isArray(j.result) ? j.result : []
  } catch { return [] }
}

async function getWalletTxs(address) {
  // Fetch normal txs + token txs in parallel
  const [normal, tokens] = await Promise.all([
    esGet({ module:'account', action:'txlist', address, startblock:'0', endblock:'99999999', offset:'500' }),
    esGet({ module:'account', action:'tokentx', address, startblock:'0', endblock:'99999999', offset:'500' }),
  ])

  const txMap = new Map()

  // Process token transfers (most useful — shows amounts + tokens)
  for (const tx of tokens) {
    if (txMap.has(tx.hash)) continue
    const from = tx.from.toLowerCase()
    const to   = tx.to.toLowerCase()
    const isToPool   = POOL_ADDRS.includes(to)
    const isFromPool = POOL_ADDRS.includes(from)
    if (!isToPool && !isFromPool) continue

    const pool = poolByAddr(isToPool ? to : from)
    const amt  = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal || '18'))
    const ts   = parseInt(tx.timeStamp)

    txMap.set(tx.hash, {
      hash:    tx.hash,
      type:    isToPool ? 'swap' : 'receive',
      label:   isToPool ? `Swap ${tx.tokenSymbol} → ${pool?.id}` : `Receive ${tx.tokenSymbol} ← ${pool?.id}`,
      pool:    pool?.id || 'Unknown',
      pair:    pool?.pair || '',
      color:   pool?.color || '#888',
      amt:     parseFloat(amt.toFixed(4)),
      symbol:  tx.tokenSymbol,
      ts,
      block:   parseInt(tx.blockNumber),
      shortHash: tx.hash.slice(0,8)+'…'+tx.hash.slice(-6),
    })
  }

  // Process normal txs to catch swaps not captured by token transfers
  for (const tx of normal) {
    if (txMap.has(tx.hash)) continue
    if (tx.isError === '1') continue
    const to = tx.to?.toLowerCase()
    if (!POOL_ADDRS.includes(to)) continue

    const pool = poolByAddr(to)
    const ts   = parseInt(tx.timeStamp)

    txMap.set(tx.hash, {
      hash:     tx.hash,
      type:     'interaction',
      label:    `Interacted with ${pool?.id}`,
      pool:     pool?.id || 'Unknown',
      pair:     pool?.pair || '',
      color:    pool?.color || '#888',
      amt:      parseFloat((parseFloat(tx.value)/1e18).toFixed(6)),
      symbol:   'ETH',
      ts,
      block:    parseInt(tx.blockNumber),
      shortHash: tx.hash.slice(0,8)+'…'+tx.hash.slice(-6),
    })
  }

  return [...txMap.values()].sort((a,b) => b.ts - a.ts)
}

async function getLeaderboard() {
  // Collect all unique wallets from all pool txs
  const addrMap = new Map() // addr -> { swaps, volume, pools }

  await Promise.all(POOLS.map(async pool => {
    const txs = await esGet({
      module:'account', action:'tokentx',
      address: pool.addr, startblock:'0', endblock:'99999999', offset:'500'
    })
    for (const tx of txs) {
      const from = tx.from.toLowerCase()
      const to   = tx.to.toLowerCase()
      // wallet is the non-pool side
      const wallet = POOL_ADDRS.includes(from) ? to : from
      if (POOL_ADDRS.includes(wallet)) continue // skip pool-to-pool

      if (!addrMap.has(wallet)) {
        addrMap.set(wallet, { swaps:0, volume:0, pools: new Set(), txCount:0 })
      }
      const e = addrMap.get(wallet)
      e.swaps++
      e.volume += parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal || '18'))
      e.pools.add(pool.id)
      e.txCount++
    }
  }))

  // Score and rank
  const entries = [...addrMap.entries()].map(([addr, d]) => {
    const swapPts   = Math.min(d.swaps * 4, 400)
    const volPts    = Math.min(Math.floor(d.volume * 0.001), 300)
    const poolPts   = d.pools.size * 50
    const score     = Math.min(swapPts + volPts + poolPts, 1000)
    const tier      = score>=800?'Diamond':score>=600?'Gold':score>=350?'Silver':score>=150?'Bronze':'Newcomer'
    return {
      addr, score, swaps: d.swaps,
      volume: Math.round(d.volume),
      poolCount: d.pools.size,
      pools: [...d.pools],
      tier,
    }
  })

  return entries.sort((a,b) => b.score - a.score).slice(0, 100)
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
const TIER_META = {
  Diamond: { color:'#60A5FA', bg:'#1e3a5f', emoji:'💎' },
  Gold:    { color:'#FBBF24', bg:'#3d2c00', emoji:'🥇' },
  Silver:  { color:'#9CA3AF', bg:'#2a2a2a', emoji:'🥈' },
  Bronze:  { color:'#F97316', bg:'#3d1f00', emoji:'🥉' },
  Newcomer:{ color:'#A78BFA', bg:'#2e1f5e', emoji:'🌱' },
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now()/1000 - ts)
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`
  return `${Math.floor(diff/86400)}d ago`
}
function shortAddr(a) { return a.slice(0,6)+'…'+a.slice(-4) }
function fmtNum(n) {
  if (n >= 1e6) return '$'+(n/1e6).toFixed(1)+'M'
  if (n >= 1e3) return '$'+(n/1e3).toFixed(1)+'k'
  return '$'+n.toLocaleString()
}

function filterByPeriod(txs, period) {
  const now = Date.now()/1000
  const cutoff = period==='daily' ? now-86400 : period==='weekly' ? now-604800 : now-2592000
  return txs.filter(t => t.ts >= cutoff)
}

function calcWalletScore(txs) {
  const swaps    = txs.filter(t=>t.type==='swap').length
  const volume   = txs.filter(t=>t.type==='swap').reduce((s,t)=>s+t.amt,0)
  const pools    = new Set(txs.map(t=>t.pool).filter(Boolean))

  // Streak
  const days = new Set(txs.map(t=>new Date(t.ts*1000).toISOString().slice(0,10)))
  const sorted = [...days].sort().reverse()
  let streak=0, cur=new Date(); cur.setHours(0,0,0,0)
  for (const d of sorted) {
    const diff = Math.round((cur-new Date(d))/86400000)
    if (diff<=1){streak++;cur=new Date(d)}else break
  }

  const swapPts   = Math.min(swaps*4, 400)
  const volPts    = Math.min(Math.floor(volume*0.001), 300)
  const poolPts   = pools.size*50
  const streakPts = Math.min(streak*10, 100)
  const score     = Math.min(swapPts+volPts+poolPts+streakPts, 1000)
  const tier      = score>=800?'Diamond':score>=600?'Gold':score>=350?'Silver':score>=150?'Bronze':'Newcomer'

  return { swaps, volume:Math.round(volume), pools:[...pools], streak, activeDays:days.size, swapPts, volPts, poolPts, streakPts, score, tier }
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  app:    { minHeight:'100vh', background:'#0a0e0c', color:'#e8ede9', fontFamily:"'Inter',system-ui,sans-serif", fontSize:14 },
  topbar: { background:'rgba(10,14,12,.95)', borderBottom:'1px solid #1a221e', position:'sticky', top:0, zIndex:50, backdropFilter:'blur(12px)' },
  topInner:{ maxWidth:1280, margin:'0 auto', padding:'0 20px', height:52, display:'flex', alignItems:'center', justifyContent:'space-between' },
  brand:  { display:'flex', alignItems:'center', gap:10 },
  brandIcon:{ width:30, height:30, borderRadius:8, background:'#1A9E74', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 },
  main:   { maxWidth:1280, margin:'0 auto', padding:'20px', display:'grid', gridTemplateColumns:'1fr 380px', gap:20 },
  card:   { background:'#111815', border:'1px solid #1a221e', borderRadius:14, padding:18 },
  cardTitle:{ fontSize:13, fontWeight:600, color:'#7a9a80', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:14, display:'flex', alignItems:'center', gap:7 },
  input:  { width:'100%', height:42, background:'#0d1410', border:'1px solid #1e2d24', borderRadius:8, padding:'0 14px', color:'#e8ede9', fontSize:14, fontFamily:"'JetBrains Mono',monospace", outline:'none', boxSizing:'border-box' },
  btn:    { height:42, padding:'0 20px', background:'#1A9E74', color:'#fff', border:'none', borderRadius:8, fontSize:14, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap' },
  pill:   (color,bg) => ({ fontSize:11, padding:'2px 9px', borderRadius:20, background:bg, color:color, fontWeight:600 }),
  tabBar: { display:'flex', gap:4, background:'#0d1410', borderRadius:8, padding:3, marginBottom:16, border:'1px solid #1a221e' },
  tab:    (active) => ({ flex:1, height:30, border: active?'1px solid #1e2d24':'1px solid transparent', background:active?'#111815':'none', borderRadius:6, fontSize:13, color:active?'#e8ede9':'#5a7a60', cursor:'pointer', fontWeight:active?500:400 }),
  metric: { background:'#0d1410', borderRadius:10, padding:'12px 14px', border:'1px solid #1a221e' },
  sep:    { borderBottom:'1px solid #1a221e', margin:'0 -18px', marginBottom:14 },
  mono:   { fontFamily:"'JetBrains Mono',monospace" },
  dot:    { width:7, height:7, borderRadius:'50%', background:'#1A9E74', display:'inline-block', animation:'pulse 2s infinite' },
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function TierBadge({ tier, large }) {
  const m = TIER_META[tier] || TIER_META.Newcomer
  return (
    <span style={{ ...S.pill(m.color, m.bg), fontSize: large?13:11, padding: large?'4px 12px':'2px 9px' }}>
      {m.emoji} {tier}
    </span>
  )
}

function MiniBar({ txs }) {
  const now = Date.now()/1000
  const days = Array.from({length:7},(_,i)=>{
    const d = new Date((now-(6-i)*86400)*1000)
    const ds = d.toISOString().slice(0,10)
    return { label:d.toLocaleDateString('en',{weekday:'short'}), count: txs.filter(t=>new Date(t.ts*1000).toISOString().slice(0,10)===ds).length }
  })
  const max = Math.max(...days.map(d=>d.count),1)
  return (
    <div style={{display:'flex',alignItems:'flex-end',gap:4,height:60}}>
      {days.map((d,i)=>(
        <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:3,height:'100%',justifyContent:'flex-end'}}>
          <div style={{width:'100%',borderRadius:3,background:d.count>0?'#1A9E74':'#1a221e',height:`${Math.max(d.count/max*100,d.count>0?10:5)}%`,transition:'height .4s'}} title={`${d.count} txs`}/>
          <span style={{fontSize:9,color:'#3a5a40'}}>{d.label}</span>
        </div>
      ))}
    </div>
  )
}

function TxRow({ tx }) {
  return (
    <div style={{display:'flex',alignItems:'flex-start',gap:10,padding:'9px 0',borderBottom:'1px solid #131d16'}}>
      <div style={{width:8,height:8,borderRadius:'50%',background:tx.color,marginTop:5,flexShrink:0}}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,color:'#d0ddd1'}}>{tx.label}</div>
        <div style={{fontSize:11,color:'#3a5a40',...S.mono,marginTop:2}}>{tx.shortHash} · {tx.pair}</div>
      </div>
      <div style={{textAlign:'right',flexShrink:0}}>
        <div style={{fontSize:13,fontWeight:500}}>{tx.amt > 0 ? `${tx.amt.toLocaleString()} ${tx.symbol}` : '—'}</div>
        <div style={{fontSize:11,color:'#3a5a40'}}>{timeAgo(tx.ts)}</div>
      </div>
    </div>
  )
}

function ScoreRing({ score, tier }) {
  const m = TIER_META[tier] || TIER_META.Newcomer
  const r=38, circ=2*Math.PI*r
  return (
    <div style={{position:'relative',width:92,height:92,flexShrink:0}}>
      <svg width={92} height={92} style={{transform:'rotate(-90deg)'}}>
        <circle cx={46} cy={46} r={r} fill="none" stroke="#1a221e" strokeWidth={7}/>
        <circle cx={46} cy={46} r={r} fill="none" stroke={m.color} strokeWidth={7}
          strokeDasharray={circ} strokeDashoffset={circ*(1-score/1000)}
          strokeLinecap="round" style={{transition:'stroke-dashoffset 1s ease'}}/>
      </svg>
      <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
        <span style={{fontSize:20,fontWeight:700,lineHeight:1}}>{score}</span>
        <span style={{fontSize:9,color:'#3a5a40',marginTop:1}}>/ 1000</span>
      </div>
    </div>
  )
}

// ─── WALLET PANEL ─────────────────────────────────────────────────────────────
function WalletPanel() {
  const [input, setInput]     = useState('')
  const [address, setAddress] = useState(null)
  const [allTxs, setAllTxs]   = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [period, setPeriod]   = useState('weekly')
  const [tab, setTab]         = useState('activity')

  const check = useCallback(async (addr) => {
    const a = (addr || input).trim()
    if (a.length < 10) return
    setAddress(a); setLoading(true); setError(null); setAllTxs([])
    try {
      const txs = await getWalletTxs(a)
      setAllTxs(txs)
      if (txs.length === 0) setError('No Stabilizer testnet activity found for this wallet.')
    } catch(e) {
      setError('Failed to fetch data. Try again.')
    } finally { setLoading(false) }
  }, [input])

  const txs     = filterByPeriod(allTxs, period)
  const stats   = address ? calcWalletScore(allTxs) : null
  const poolAgg = stats ? POOLS.map(p => ({
    ...p,
    count: allTxs.filter(t=>t.pool===p.id).length,
    vol:   allTxs.filter(t=>t.pool===p.id).reduce((s,t)=>s+t.amt,0),
  })) : []

  return (
    <div style={{display:'flex',flexDirection:'column',gap:16}}>
      {/* Search */}
      <div style={S.card}>
        <div style={S.cardTitle}>🔍 Wallet checker</div>
        <div style={{display:'flex',gap:8}}>
          <input style={S.input} placeholder="Enter wallet address (0x…)" value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&check()}
            onFocus={e=>e.target.style.borderColor='#1A9E74'}
            onBlur={e=>e.target.style.borderColor='#1e2d24'}/>
          <button style={S.btn} onClick={()=>check()}>Check</button>
        </div>
      </div>

      {/* Empty state */}
      {!address && !loading && (
        <div style={{...S.card, textAlign:'center', padding:'48px 20px', color:'#3a5a40'}}>
          <div style={{fontSize:36,marginBottom:12}}>🔭</div>
          <div style={{fontSize:15,color:'#5a7a60',fontWeight:500}}>Enter a wallet address above</div>
          <div style={{fontSize:13,marginTop:6}}>Track swaps · LP positions · Streaks · Score</div>
          <div style={{fontSize:12,marginTop:4}}>Daily · Weekly · Monthly views</div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{...S.card,textAlign:'center',padding:'48px',color:'#3a5a40'}}>
          <div style={{fontSize:28,marginBottom:10,animation:'spin 1s linear infinite',display:'inline-block'}}>⟳</div>
          <div style={{marginTop:8}}>Scanning Sepolia for activity…</div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div style={{...S.card,background:'#1a0e0e',border:'1px solid #3a1a1a',color:'#f87171',padding:16}}>
          ⚠️ {error}
        </div>
      )}

      {/* Results */}
      {stats && !loading && (
        <>
          {/* Header card */}
          <div style={S.card}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
              <div>
                <div style={{fontSize:13,...S.mono,color:'#d0ddd1',fontWeight:500}}>{shortAddr(address)}</div>
                <div style={{fontSize:11,color:'#3a5a40',marginTop:2}}>
                  {stats.activeDays} active days · last seen {allTxs[0]?timeAgo(allTxs[0].ts):'—'}
                  <span style={{color:'#1A9E74',marginLeft:8}}>● Live · Sepolia</span>
                </div>
              </div>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <TierBadge tier={stats.tier} large/>
                <button onClick={()=>{navigator.clipboard?.writeText(address)}} style={{...S.btn,background:'#1a221e',fontSize:12,height:32,padding:'0 10px'}}>Copy</button>
                <button onClick={()=>check(address)} style={{...S.btn,background:'#1a221e',fontSize:12,height:32,padding:'0 10px'}}>↻</button>
              </div>
            </div>

            {/* Score + metrics */}
            <div style={{display:'flex',gap:14,alignItems:'center',marginBottom:16}}>
              <ScoreRing score={stats.score} tier={stats.tier}/>
              <div style={{flex:1,display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                {[
                  ['Swap pts', stats.swapPts, '#1A9E74'],
                  ['Vol pts',  stats.volPts,  '#2563EB'],
                  ['Pool pts', stats.poolPts, '#7C3AED'],
                  ['Streak',   `${stats.streakPts}pts`, '#DB2777'],
                ].map(([l,v,c])=>(
                  <div key={l} style={S.metric}>
                    <div style={{fontSize:16,fontWeight:600,color:c}}>{v}</div>
                    <div style={{fontSize:11,color:'#3a5a40',marginTop:1}}>{l}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Stats row */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
              {[
                ['Total swaps', stats.swaps],
                ['Volume', fmtNum(stats.volume)],
                ['Pools used', stats.pools.length+' / 4'],
                ['Day streak', stats.streak+'d'],
              ].map(([l,v])=>(
                <div key={l} style={S.metric}>
                  <div style={{fontSize:18,fontWeight:600}}>{v}</div>
                  <div style={{fontSize:11,color:'#3a5a40',marginTop:1}}>{l}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Activity card */}
          <div style={S.card}>
            {/* Period tabs */}
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
              <div style={S.cardTitle}>📋 Activity</div>
              <div style={{display:'flex',gap:4}}>
                {['daily','weekly','monthly'].map(p=>(
                  <button key={p} onClick={()=>setPeriod(p)} style={{
                    height:26,padding:'0 10px',borderRadius:20,fontSize:11,fontWeight:500,border:'1px solid',
                    borderColor: period===p?'#1A9E74':'#1a221e',
                    background:  period===p?'#0d2e22':'none',
                    color:       period===p?'#1A9E74':'#3a5a40',cursor:'pointer',
                  }}>{p.charAt(0).toUpperCase()+p.slice(1)}</button>
                ))}
              </div>
            </div>

            {/* Sub tabs */}
            <div style={S.tabBar}>
              {[['activity','Transactions'],['chart','7d Chart'],['pools','By Pool']].map(([id,label])=>(
                <button key={id} style={S.tab(tab===id)} onClick={()=>setTab(id)}>{label}</button>
              ))}
            </div>

            {tab === 'activity' && (
              txs.length === 0
                ? <div style={{padding:'32px 0',textAlign:'center',color:'#3a5a40'}}>No activity in this period</div>
                : txs.slice(0,30).map((tx,i)=><TxRow key={i} tx={tx}/>)
            )}

            {tab === 'chart' && (
              <div>
                <div style={{fontSize:12,color:'#3a5a40',marginBottom:10}}>Transactions per day (last 7 days)</div>
                <MiniBar txs={allTxs}/>
              </div>
            )}

            {tab === 'pools' && (
              <div>
                {poolAgg.map(p=>(
                  <div key={p.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 0',borderBottom:'1px solid #131d16'}}>
                    <div style={{width:4,height:40,borderRadius:2,background:p.color,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:500}}>{p.id}</div>
                      <div style={{fontSize:11,color:'#3a5a40'}}>{p.pair}</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{fontSize:14,fontWeight:600,color: p.count>0?p.color:'#3a5a40'}}>{p.count} txs</div>
                      <div style={{fontSize:11,color:'#3a5a40'}}>{p.vol>0?fmtNum(p.vol):'—'}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ─── LEADERBOARD PANEL ────────────────────────────────────────────────────────
function LeaderboardPanel() {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [loaded,  setLoaded]  = useState(false)
  const [sortBy,  setSortBy]  = useState('score')
  const [search,  setSearch]  = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getLeaderboard()
      setEntries(data)
      setLoaded(true)
    } catch(e) {
      setEntries([])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const sorted = [...entries]
    .sort((a,b) => sortBy==='score'?b.score-a.score : sortBy==='swaps'?b.swaps-a.swaps : b.volume-a.volume)
    .filter(e => !search || e.addr.toLowerCase().includes(search.toLowerCase()))

  const tierCounts = entries.reduce((acc,e)=>{ acc[e.tier]=(acc[e.tier]||0)+1; return acc },{})

  return (
    <div style={{display:'flex',flexDirection:'column',gap:0}}>
      <div style={S.card}>
        {/* Header */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
          <div style={S.cardTitle}>🏆 Leaderboard <span style={{color:'#3a5a40',fontSize:11,fontWeight:400}}>Top 100</span></div>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            {loaded && <span style={{fontSize:11,color:'#1A9E74'}}>● {entries.length} participants</span>}
            <button onClick={load} style={{...S.btn,height:28,padding:'0 10px',fontSize:12,background:'#1a221e'}}>↻</button>
          </div>
        </div>

        {/* Tier breakdown */}
        {loaded && (
          <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:14}}>
            {Object.entries(TIER_META).map(([t,m])=> tierCounts[t] ? (
              <span key={t} style={S.pill(m.color,m.bg)}>{m.emoji} {t} ×{tierCounts[t]}</span>
            ) : null)}
          </div>
        )}

        {/* Sort + search */}
        <div style={{display:'flex',gap:8,marginBottom:14}}>
          <input style={{...S.input,fontFamily:"'Inter',sans-serif",fontSize:12,flex:1}}
            placeholder="Filter by address…" value={search} onChange={e=>setSearch(e.target.value)}/>
          <div style={{display:'flex',gap:4}}>
            {['score','swaps','volume'].map(s=>(
              <button key={s} onClick={()=>setSortBy(s)} style={{
                height:38,padding:'0 10px',borderRadius:8,fontSize:12,fontWeight:500,border:'1px solid',
                borderColor: sortBy===s?'#1A9E74':'#1a221e',
                background:  sortBy===s?'#0d2e22':'#0d1410',
                color:       sortBy===s?'#1A9E74':'#3a5a40',cursor:'pointer',
              }}>{s.charAt(0).toUpperCase()+s.slice(1)}</button>
            ))}
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{padding:'40px',textAlign:'center',color:'#3a5a40'}}>
            <div style={{fontSize:24,marginBottom:8,animation:'spin 1s linear infinite',display:'inline-block'}}>⟳</div>
            <div>Scanning all pool activity on Sepolia…</div>
            <div style={{fontSize:12,marginTop:4}}>This may take 10–20 seconds</div>
          </div>
        )}

        {/* Empty */}
        {!loading && loaded && sorted.length === 0 && (
          <div style={{padding:'32px',textAlign:'center',color:'#3a5a40'}}>
            No participants found yet
          </div>
        )}

        {/* Table header */}
        {!loading && sorted.length > 0 && (
          <div style={{display:'grid',gridTemplateColumns:'28px 1fr 60px 60px 70px',gap:8,padding:'6px 8px',background:'#0d1410',borderRadius:8,marginBottom:4}}>
            {['#','Wallet','Score','Swaps','Tier'].map(h=>(
              <div key={h} style={{fontSize:10,color:'#3a5a40',fontWeight:600,textTransform:'uppercase',letterSpacing:'.05em',...(h==='Score'||h==='Swaps'?{textAlign:'right'}:{})}}>{h}</div>
            ))}
          </div>
        )}

        {/* Rows */}
        {!loading && sorted.slice(0,100).map((e,i)=>{
          const m = TIER_META[e.tier] || TIER_META.Newcomer
          const rank = sortBy==='score' ? i+1 : entries.findIndex(x=>x.addr===e.addr)+1
          return (
            <div key={e.addr} style={{
              display:'grid',gridTemplateColumns:'28px 1fr 60px 60px 70px',gap:8,
              padding:'9px 8px',borderBottom:'1px solid #0f1812',alignItems:'center',
              background: rank<=3 ? `${m.bg}55` : 'none',
              borderRadius: rank<=3 ? 8 : 0,
            }}>
              <div style={{fontSize:rank<=3?15:12,color:rank===1?'#FBBF24':rank===2?'#9CA3AF':rank===3?'#F97316':'#3a5a40',textAlign:'center',fontWeight:600}}>
                {rank<=3?['🥇','🥈','🥉'][rank-1]:rank}
              </div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:12,...S.mono,color:'#d0ddd1'}}>{shortAddr(e.addr)}</div>
                <div style={{fontSize:10,color:'#3a5a40',marginTop:1}}>{e.pools.join(' · ')} · {e.poolCount} pool{e.poolCount!==1?'s':''}</div>
              </div>
              <div style={{textAlign:'right',fontSize:13,fontWeight:600,color:m.color}}>{e.score}</div>
              <div style={{textAlign:'right',fontSize:13,color:'#9aad9a'}}>{e.swaps}</div>
              <div><TierBadge tier={e.tier}/></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState('wallet')

  return (
    <div style={S.app}>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        *{box-sizing:border-box;margin:0;padding:0}
        input::placeholder{color:#2a4030}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#1a2e20;border-radius:4px}
        @media(max-width:900px){
          .main-grid{grid-template-columns:1fr !important}
          .lb-cols{grid-template-columns:22px 1fr 55px 55px !important}
        }
      `}</style>

      {/* Top bar */}
      <div style={S.topbar}>
        <div style={S.topInner}>
          <div style={S.brand}>
            <div style={S.brandIcon}>⚖</div>
            <div>
              <div style={{fontSize:14,fontWeight:700,lineHeight:1.1}}>Stabilizer Tracker</div>
              <div style={{fontSize:11,color:'#3a5a40'}}>Testnet · Ethereum Sepolia</div>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <span style={{fontSize:11,color:'#1A9E74',display:'flex',alignItems:'center',gap:5}}>
              <span style={S.dot}/>Live
            </span>
            <span style={{fontSize:11,padding:'2px 8px',borderRadius:20,background:'#0d1410',border:'1px solid #1a221e',color:'#3a5a40'}}>11155111</span>
            <a href="https://app.stabilizer.finance" target="_blank" rel="noopener noreferrer"
              style={{fontSize:12,padding:'4px 12px',background:'#0d2e22',border:'1px solid #1A9E74',borderRadius:8,color:'#1A9E74',fontWeight:500}}>
              Open App ↗
            </a>
          </div>
        </div>
      </div>

      {/* Mobile nav */}
      <div style={{maxWidth:1280,margin:'0 auto',padding:'16px 20px 0',display:'none'}} className="mobile-nav">
        <div style={S.tabBar}>
          <button style={S.tab(view==='wallet')} onClick={()=>setView('wallet')}>🔍 Wallet</button>
          <button style={S.tab(view==='leaderboard')} onClick={()=>setView('leaderboard')}>🏆 Leaderboard</button>
        </div>
      </div>

      {/* Desktop two-col layout */}
      <div style={{...S.main,padding:'20px'}} className="main-grid">
        <WalletPanel/>
        <LeaderboardPanel/>
      </div>

      {/* Footer */}
      <div style={{maxWidth:1280,margin:'0 auto',padding:'16px 20px',borderTop:'1px solid #1a221e',textAlign:'center',color:'#2a4030',fontSize:12}}>
        Stabilizer Protocol · Ethereum Sepolia Testnet · No real funds ·{' '}
        <a href="https://app.stabilizer.finance" target="_blank" rel="noopener noreferrer" style={{color:'#1A9E74'}}>app.stabilizer.finance</a>
      </div>
    </div>
  )
}
