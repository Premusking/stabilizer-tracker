import { useState, useCallback } from 'react'

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ES = 'https://api-sepolia.etherscan.io/api'

// Known Stabilizer pool addresses (for labeling)
const POOLS = [
  { id:'T-Pool', pair:'USDT/USDZ', addr:'0x7C348b70F640B47b64ecDb154960D337ce7a98B4', color:'#1D9E74' },
  { id:'C-Pool', pair:'USDC/USDZ', addr:'0x0578E5EA652C62DB20F4475F685A4b587314A30f', color:'#2563EB' },
  { id:'S-Pool', pair:'USDS/USDZ', addr:'0xC94fbB2C1Da52F8561A829a4838f117DD7316F54', color:'#7C3AED' },
  { id:'P-Pool', pair:'PYUSD/USDZ',addr:'0x7Dd6979749b60C60eaaa55e4A50e732DAbc5DdD3',color:'#DB2777' },
]
const POOL_ADDRS = new Set(POOLS.map(p => p.addr.toLowerCase()))
const poolByAddr = a => POOLS.find(p => p.addr.toLowerCase() === a?.toLowerCase())

// Stabilizer-related token symbols
const STAB_TOKENS = new Set(['USDZ','USDT','USDC','USDS','PYUSD'])

// ─── ETHERSCAN FETCH ──────────────────────────────────────────────────────────
async function esGet(params) {
  try {
    const qs = new URLSearchParams({ ...params, sort:'desc', offset:'500' }).toString()
    const r  = await fetch(`${ES}?${qs}`)
    const j  = await r.json()
    return Array.isArray(j.result) ? j.result : []
  } catch { return [] }
}

async function fetchAll(address) {
  const addr = address.toLowerCase()

  // Fetch normal txs, token transfers, and internal txs all at once
  const [normalRaw, tokenRaw] = await Promise.all([
    esGet({ module:'account', action:'txlist',  address, startblock:'0', endblock:'99999999' }),
    esGet({ module:'account', action:'tokentx', address, startblock:'0', endblock:'99999999' }),
  ])

  const txMap = new Map()

  // ── Token transfers (primary source — has symbol, amount, decimals) ────────
  for (const tx of tokenRaw) {
    const from = tx.from.toLowerCase()
    const to   = tx.to.toLowerCase()
    const sym  = tx.tokenSymbol || ''
    const isPool = POOL_ADDRS.has(from) || POOL_ADDRS.has(to)
    const isStabToken = STAB_TOKENS.has(sym)

    // Include if: involves a pool address OR involves a Stabilizer token
    if (!isPool && !isStabToken) continue

    const pool = poolByAddr(from) || poolByAddr(to)
    const amt  = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal || '18'))
    const walletSending = from === addr

    const key = tx.hash + sym // same tx can have multiple token transfers
    if (!txMap.has(key)) {
      txMap.set(key, {
        hash:    tx.hash,
        shortHash: tx.hash.slice(0,8)+'…'+tx.hash.slice(-6),
        ts:      parseInt(tx.timeStamp),
        block:   parseInt(tx.blockNumber),
        type:    isPool ? (walletSending ? 'swap' : 'receive') : 'transfer',
        label:   pool
          ? (walletSending ? `Swap ${sym} → ${pool.id}` : `Receive ${sym} ← ${pool.id}`)
          : `${sym} Transfer`,
        pool:    pool?.id || '—',
        pair:    pool?.pair || sym,
        color:   pool?.color || '#4ade80',
        amt,
        symbol:  sym,
        toAddr:  tx.to,
        fromAddr:tx.from,
      })
    }
  }

  // ── Normal txs to pool addresses ──────────────────────────────────────────
  for (const tx of normalRaw) {
    if (txMap.has(tx.hash)) continue
    if (tx.isError === '1') continue
    const to = tx.to?.toLowerCase() || ''
    if (!POOL_ADDRS.has(to)) continue

    const pool = poolByAddr(to)
    txMap.set(tx.hash, {
      hash:     tx.hash,
      shortHash: tx.hash.slice(0,8)+'…'+tx.hash.slice(-6),
      ts:       parseInt(tx.timeStamp),
      block:    parseInt(tx.blockNumber),
      type:     'interaction',
      label:    `Contract call → ${pool?.id || 'Pool'}`,
      pool:     pool?.id || '—',
      pair:     pool?.pair || '',
      color:    pool?.color || '#4ade80',
      amt:      parseFloat(tx.value) / 1e18,
      symbol:   'ETH',
      toAddr:   tx.to,
      fromAddr: tx.from,
    })
  }

  const all = [...txMap.values()].sort((a,b) => b.ts - a.ts)

  // Also collect all USDZ token transactions (no pool filter) for full history
  const usdzAll = tokenRaw.filter(tx => tx.tokenSymbol === 'USDZ')
  for (const tx of usdzAll) {
    const key = tx.hash + tx.tokenSymbol
    if (txMap.has(key)) continue
    const amt = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal || '18'))
    const walletSending = tx.from.toLowerCase() === addr
    txMap.set(key, {
      hash:     tx.hash,
      shortHash: tx.hash.slice(0,8)+'…'+tx.hash.slice(-6),
      ts:       parseInt(tx.timeStamp),
      block:    parseInt(tx.blockNumber),
      type:     walletSending ? 'mint' : 'receive',
      label:    walletSending ? `Sent USDZ` : `Received USDZ`,
      pool:     '—', pair:'USDZ', color:'#4ade80',
      amt, symbol:'USDZ',
      toAddr:   tx.to, fromAddr: tx.from,
    })
  }

  return [...txMap.values()].sort((a,b) => b.ts - a.ts)
}

async function fetchLeaderboard() {
  const walletMap = new Map()

  // Get token transfers for each pool contract
  await Promise.all(POOLS.map(async pool => {
    const rows = await esGet({
      module:'account', action:'tokentx',
      address: pool.addr, startblock:'0', endblock:'99999999',
    })
    for (const tx of rows) {
      const from = tx.from.toLowerCase()
      const to   = tx.to.toLowerCase()
      const wallet = POOL_ADDRS.has(from) ? to : from
      if (POOL_ADDRS.has(wallet) || wallet === pool.addr.toLowerCase()) continue

      if (!walletMap.has(wallet)) walletMap.set(wallet, { swaps:0, vol:0, pools:new Set(), ts:0 })
      const e = walletMap.get(wallet)
      e.swaps++
      e.vol += parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal || '18'))
      e.pools.add(pool.id)
      e.ts = Math.max(e.ts, parseInt(tx.timeStamp))
    }
  }))

  return [...walletMap.entries()].map(([addr, d]) => {
    const swapPts  = Math.min(d.swaps * 4, 400)
    const volPts   = Math.min(Math.floor(d.vol * 0.001), 300)
    const poolPts  = d.pools.size * 75
    const score    = Math.min(swapPts + volPts + poolPts, 1000)
    const tier     = score>=800?'Diamond':score>=600?'Gold':score>=350?'Silver':score>=150?'Bronze':'Newcomer'
    return { addr, score, swaps:d.swaps, vol:Math.round(d.vol), pools:[...d.pools], poolCount:d.pools.size, tier, lastSeen:d.ts }
  }).sort((a,b) => b.score-a.score).slice(0,100)
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
const TIER_META = {
  Diamond: { c:'#60A5FA', bg:'#1e3a5f', e:'💎' },
  Gold:    { c:'#FBBF24', bg:'#3d2c00', e:'🥇' },
  Silver:  { c:'#9CA3AF', bg:'#252525', e:'🥈' },
  Bronze:  { c:'#F97316', bg:'#3d1f00', e:'🥉' },
  Newcomer:{ c:'#A78BFA', bg:'#2e1f5e', e:'🌱' },
}
const fmtAmt = (n,sym) => n > 0 ? `${n >= 1000 ? n.toLocaleString(undefined,{maximumFractionDigits:0}) : n.toFixed(n<1?4:2)} ${sym}` : '—'
const fmtVol = n => n >= 1e6 ? '$'+(n/1e6).toFixed(1)+'M' : n >= 1000 ? '$'+(n/1000).toFixed(1)+'k' : '$'+n
const timeAgo = ts => { const d=Math.floor(Date.now()/1000-ts); return d<3600?`${Math.floor(d/60)}m ago`:d<86400?`${Math.floor(d/3600)}h ago`:`${Math.floor(d/86400)}d ago` }
const short = a => a.slice(0,6)+'…'+a.slice(-4)
const periodSec = { daily:86400, weekly:604800, monthly:2592000 }

function score(txs) {
  const swaps   = txs.filter(t=>['swap','interaction'].includes(t.type)).length
  const vol     = txs.filter(t=>t.type==='swap').reduce((s,t)=>s+t.amt,0)
  const pools   = new Set(txs.filter(t=>t.pool!=='—').map(t=>t.pool))
  const days    = new Set(txs.map(t=>new Date(t.ts*1000).toISOString().slice(0,10)))
  const sorted  = [...days].sort().reverse()
  let streak=0,cur=new Date();cur.setHours(0,0,0,0)
  for(const d of sorted){const diff=Math.round((cur-new Date(d))/86400000);if(diff<=1){streak++;cur=new Date(d)}else break}
  const swapPts = Math.min(swaps*4,400)
  const volPts  = Math.min(Math.floor(vol*0.001),300)
  const poolPts = pools.size*75
  const sPts    = Math.min(streak*10,100)
  const total   = Math.min(swapPts+volPts+poolPts+sPts,1000)
  return { swaps, vol:Math.round(vol), pools:[...pools], streak, activeDays:days.size, swapPts, volPts, poolPts, sPts, score:total,
    tier: total>=800?'Diamond':total>=600?'Gold':total>=350?'Silver':total>=150?'Bronze':'Newcomer' }
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const card  = { background:'#111815', border:'1px solid #1c2820', borderRadius:14, padding:18 }
const muted = { color:'#3a5840' }
const mono  = { fontFamily:"'JetBrains Mono','Courier New',monospace" }
const btn   = (active,sm) => ({
  height:sm?28:38, padding:sm?'0 10px':'0 16px', borderRadius:sm?20:8,
  fontSize:sm?11:13, fontWeight:500, border:'1px solid',
  borderColor: active?'#1A9E74':'#1c2820',
  background:  active?'#0a2e1e':'#0d1410',
  color:       active?'#1A9E74':'#3a5840', cursor:'pointer',
})

// ─── WALLET PANEL ─────────────────────────────────────────────────────────────
function WalletPanel() {
  const [input,  setInput]  = useState('')
  const [addr,   setAddr]   = useState(null)
  const [txs,    setTxs]    = useState([])
  const [loading,setLoading]= useState(false)
  const [err,    setErr]    = useState(null)
  const [period, setPeriod] = useState('weekly')
  const [tab,    setTab]    = useState('txs')

  const check = useCallback(async (a) => {
    const val = (a||input).trim()
    if (val.length < 10) return
    setAddr(val); setLoading(true); setErr(null); setTxs([])
    try {
      const data = await fetchAll(val)
      setTxs(data)
      if (data.length === 0) setErr('No Stabilizer testnet activity found. Make sure you have done swaps on app.stabilizer.finance on Sepolia.')
    } catch(e) { setErr('Fetch failed. Try again.') }
    finally { setLoading(false) }
  }, [input])

  const cutoff  = Date.now()/1000 - periodSec[period]
  const filtered = txs.filter(t => t.ts >= cutoff)
  const st      = addr ? score(txs) : null
  const poolAgg = POOLS.map(p => ({ ...p, count: txs.filter(t=>t.pool===p.id).length, vol: txs.filter(t=>t.pool===p.id).reduce((s,t)=>s+t.amt,0) }))

  // 7-day chart
  const chart7d = Array.from({length:7},(_,i)=>{
    const d = new Date(Date.now()-(6-i)*86400000)
    const ds = d.toISOString().slice(0,10)
    return { label:d.toLocaleDateString('en',{weekday:'short'}), count: txs.filter(t=>new Date(t.ts*1000).toISOString().slice(0,10)===ds).length }
  })
  const maxBar = Math.max(...chart7d.map(d=>d.count),1)

  const tm = st ? (TIER_META[st.tier]||TIER_META.Newcomer) : null

  return (
    <div style={{display:'flex',flexDirection:'column',gap:14}}>
      {/* Search */}
      <div style={card}>
        <div style={{fontSize:11,fontWeight:600,color:'#3a5840',textTransform:'uppercase',letterSpacing:'.07em',marginBottom:12}}>🔍 Wallet Checker</div>
        <div style={{display:'flex',gap:8}}>
          <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&check()}
            placeholder="0x… wallet address"
            style={{flex:1,height:40,background:'#0a0f0c',border:'1px solid #1c2820',borderRadius:8,padding:'0 14px',color:'#e0ede1',fontSize:13,...mono,outline:'none',boxSizing:'border-box'}}
            onFocus={e=>e.target.style.borderColor='#1A9E74'} onBlur={e=>e.target.style.borderColor='#1c2820'}/>
          <button onClick={()=>check()} style={{height:40,padding:'0 18px',background:'#1A9E74',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer'}}>Check</button>
        </div>
      </div>

      {/* Empty */}
      {!addr && !loading && (
        <div style={{...card,textAlign:'center',padding:'52px 20px',...muted}}>
          <div style={{fontSize:34,marginBottom:10}}>🔭</div>
          <div style={{fontSize:15,color:'#5a7a60',fontWeight:500,marginBottom:6}}>Track your Stabilizer testnet activity</div>
          <div style={{fontSize:12}}>Paste any wallet that has swapped on app.stabilizer.finance</div>
          <div style={{fontSize:12,marginTop:3}}>Daily · Weekly · Monthly · Score · Leaderboard rank</div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{...card,textAlign:'center',padding:'48px',...muted}}>
          <div style={{fontSize:28,marginBottom:10,display:'inline-block',animation:'spin 1s linear infinite'}}>⟳</div>
          <div>Scanning Sepolia for Stabilizer activity…</div>
        </div>
      )}

      {/* Error */}
      {err && !loading && <div style={{...card,background:'#1a0f0f',border:'1px solid #3a1a1a',color:'#f87171',fontSize:13}}>⚠️ {err}</div>}

      {/* Results */}
      {st && !loading && (
        <>
          {/* Profile card */}
          <div style={card}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
              <div>
                <div style={{fontSize:13,...mono,fontWeight:500}}>{short(addr)}</div>
                <div style={{fontSize:11,marginTop:2,...muted}}>
                  {st.activeDays} active days
                  {txs[0] && ` · last seen ${timeAgo(txs[0].ts)}`}
                  <span style={{color:'#1A9E74',marginLeft:8}}>● Live · Sepolia</span>
                </div>
              </div>
              <div style={{display:'flex',gap:7,alignItems:'center'}}>
                <span style={{fontSize:13,padding:'4px 12px',borderRadius:20,background:tm.bg,color:tm.c,fontWeight:600}}>{tm.e} {st.tier}</span>
                <button onClick={()=>check(addr)} style={{...btn(false,true),borderRadius:8,height:32,padding:'0 10px'}}>↻</button>
                <button onClick={()=>navigator.clipboard?.writeText(addr)} style={{...btn(false,true),borderRadius:8,height:32,padding:'0 10px'}}>Copy</button>
              </div>
            </div>

            {/* Score row */}
            <div style={{display:'flex',gap:14,alignItems:'center',marginBottom:14}}>
              {/* Ring */}
              <div style={{position:'relative',width:88,height:88,flexShrink:0}}>
                <svg width={88} height={88} style={{transform:'rotate(-90deg)'}}>
                  <circle cx={44} cy={44} r={36} fill="none" stroke="#1c2820" strokeWidth={7}/>
                  <circle cx={44} cy={44} r={36} fill="none" stroke={tm.c} strokeWidth={7}
                    strokeDasharray={2*Math.PI*36} strokeDashoffset={2*Math.PI*36*(1-st.score/1000)}
                    strokeLinecap="round" style={{transition:'stroke-dashoffset 1s ease'}}/>
                </svg>
                <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
                  <span style={{fontSize:19,fontWeight:700,lineHeight:1}}>{st.score}</span>
                  <span style={{fontSize:9,...muted}}>/ 1000</span>
                </div>
              </div>
              {/* Pts breakdown */}
              <div style={{flex:1,display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                {[['Swap pts',st.swapPts,'#1A9E74'],['Vol pts',st.volPts,'#2563EB'],['Pool pts',st.poolPts,'#7C3AED'],['Streak pts',st.sPts,'#DB2777']].map(([l,v,c])=>(
                  <div key={l} style={{background:'#0d1410',borderRadius:8,padding:'10px 12px',border:'1px solid #1c2820'}}>
                    <div style={{fontSize:16,fontWeight:600,color:c}}>{v}</div>
                    <div style={{fontSize:10,...muted,marginTop:1}}>{l}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Stats row */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
              {[['Total txs',txs.length],['Volume',fmtVol(st.vol)],['Pools',`${st.pools.length}/4`],['Streak',`${st.streak}d`]].map(([l,v])=>(
                <div key={l} style={{background:'#0d1410',borderRadius:8,padding:'10px 12px',border:'1px solid #1c2820',textAlign:'center'}}>
                  <div style={{fontSize:18,fontWeight:600}}>{v}</div>
                  <div style={{fontSize:10,...muted,marginTop:1}}>{l}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Activity card */}
          <div style={card}>
            {/* Period + tab row */}
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
              <div style={{display:'flex',gap:4}}>
                {['daily','weekly','monthly'].map(p=>(
                  <button key={p} onClick={()=>setPeriod(p)} style={btn(period===p,true)}>{p.charAt(0).toUpperCase()+p.slice(1)}</button>
                ))}
              </div>
              <div style={{display:'flex',gap:4}}>
                {[['txs','Transactions'],['chart','7d Chart'],['pools','Pools']].map(([id,lbl])=>(
                  <button key={id} onClick={()=>setTab(id)} style={btn(tab===id,true)}>{lbl}</button>
                ))}
              </div>
            </div>

            {/* Transactions tab */}
            {tab==='txs' && (
              filtered.length === 0
                ? <div style={{padding:'28px 0',textAlign:'center',...muted,fontSize:13}}>No activity in this {period} period</div>
                : filtered.slice(0,40).map((tx,i)=>(
                    <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'9px 0',borderBottom:'1px solid #0f180f'}}>
                      <div style={{width:8,height:8,borderRadius:'50%',background:tx.color,marginTop:5,flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,color:'#d0ddd0'}}>{tx.label}</div>
                        <div style={{fontSize:11,...muted,...mono,marginTop:2}}>{tx.shortHash}</div>
                      </div>
                      <div style={{textAlign:'right',flexShrink:0}}>
                        <div style={{fontSize:13,fontWeight:500}}>{fmtAmt(tx.amt,tx.symbol)}</div>
                        <div style={{fontSize:11,...muted}}>{timeAgo(tx.ts)}</div>
                      </div>
                    </div>
                  ))
            )}

            {/* Chart tab */}
            {tab==='chart' && (
              <div>
                <div style={{fontSize:11,...muted,marginBottom:10}}>Transactions per day — last 7 days</div>
                <div style={{display:'flex',alignItems:'flex-end',gap:5,height:80}}>
                  {chart7d.map((d,i)=>(
                    <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:4,height:'100%',justifyContent:'flex-end'}}>
                      <div style={{width:'100%',borderRadius:3,background:d.count>0?'#1A9E74':'#1c2820',height:`${Math.max(d.count/maxBar*100,d.count>0?10:4)}%`,transition:'height .4s'}} title={`${d.count}`}/>
                      <span style={{fontSize:10,...muted}}>{d.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Pools tab */}
            {tab==='pools' && poolAgg.map(p=>(
              <div key={p.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 0',borderBottom:'1px solid #0f180f'}}>
                <div style={{width:4,height:38,borderRadius:2,background:p.color,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:500}}>{p.id}</div>
                  <div style={{fontSize:11,...muted}}>{p.pair}</div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{fontSize:14,fontWeight:600,color:p.count>0?p.color:'#2a3a28'}}>{p.count} txs</div>
                  <div style={{fontSize:11,...muted}}>{p.vol>0?fmtVol(p.vol):'—'}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
function Leaderboard() {
  const [entries,setEntries] = useState([])
  const [loading,setLoading] = useState(false)
  const [loaded, setLoaded]  = useState(false)
  const [sortBy, setSortBy]  = useState('score')
  const [search, setSearch]  = useState('')

  const load = useCallback(async()=>{
    setLoading(true)
    try { const d=await fetchLeaderboard(); setEntries(d); setLoaded(true) }
    catch{}
    finally { setLoading(false) }
  },[])

  useState(()=>{ load() },[])

  const sorted = [...entries]
    .sort((a,b)=>sortBy==='score'?b.score-a.score:sortBy==='swaps'?b.swaps-a.swaps:b.vol-a.vol)
    .filter(e=>!search||e.addr.includes(search.toLowerCase()))

  const tierCount = entries.reduce((a,e)=>({...a,[e.tier]:(a[e.tier]||0)+1}),{})

  return (
    <div style={card}>
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:600,color:'#3a5840',textTransform:'uppercase',letterSpacing:'.07em'}}>
          🏆 Leaderboard <span style={{color:'#2a3a28',fontWeight:400}}>Top 100</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          {loaded && <span style={{fontSize:11,color:'#1A9E74'}}>● {entries.length} participants</span>}
          <button onClick={load} style={{...btn(false,true),borderRadius:8,height:28,padding:'0 10px'}}>↻ Load</button>
        </div>
      </div>

      {/* Tier pills */}
      {loaded && (
        <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:12}}>
          {Object.entries(TIER_META).map(([t,m])=>tierCount[t]?(
            <span key={t} style={{fontSize:11,padding:'2px 8px',borderRadius:20,background:m.bg,color:m.c,fontWeight:600}}>{m.e} {t} ×{tierCount[t]}</span>
          ):null)}
        </div>
      )}

      {/* Sort + search */}
      <div style={{display:'flex',gap:8,marginBottom:12}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Filter address…"
          style={{flex:1,height:34,background:'#0a0f0c',border:'1px solid #1c2820',borderRadius:8,padding:'0 12px',color:'#e0ede1',fontSize:12,...mono,outline:'none',boxSizing:'border-box'}}/>
        <div style={{display:'flex',gap:4}}>
          {['score','swaps','volume'].map(s=>(
            <button key={s} onClick={()=>setSortBy(s)} style={btn(sortBy===s,true)}>{s.charAt(0).toUpperCase()+s.slice(1)}</button>
          ))}
        </div>
      </div>

      {/* Not loaded */}
      {!loaded && !loading && (
        <div style={{padding:'40px 0',textAlign:'center',...muted}}>
          <div style={{fontSize:13,marginBottom:10}}>Click ↻ Load to fetch leaderboard</div>
          <div style={{fontSize:11}}>Reads all Stabilizer pool activity from Sepolia</div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{padding:'40px 0',textAlign:'center',...muted}}>
          <div style={{fontSize:24,marginBottom:8,display:'inline-block',animation:'spin 1s linear infinite'}}>⟳</div>
          <div style={{fontSize:13}}>Scanning all 4 pools on Sepolia…</div>
          <div style={{fontSize:11,marginTop:4}}>~10–20 seconds</div>
        </div>
      )}

      {/* Table */}
      {!loading && sorted.length > 0 && (
        <>
          <div style={{display:'grid',gridTemplateColumns:'28px 1fr 55px 50px 72px',gap:6,padding:'5px 6px',background:'#0a0f0c',borderRadius:6,marginBottom:4}}>
            {['#','Wallet','Score','Swaps','Tier'].map(h=>(
              <div key={h} style={{fontSize:10,color:'#2a3a28',fontWeight:700,textTransform:'uppercase',letterSpacing:'.05em',...(['Score','Swaps'].includes(h)?{textAlign:'right'}:{})}}>{h}</div>
            ))}
          </div>
          {sorted.map((e,i)=>{
            const m   = TIER_META[e.tier]||TIER_META.Newcomer
            const val = sortBy==='score'?e.score:sortBy==='swaps'?e.swaps:fmtVol(e.vol)
            return (
              <div key={e.addr} style={{display:'grid',gridTemplateColumns:'28px 1fr 55px 50px 72px',gap:6,padding:'8px 6px',borderBottom:'1px solid #0d1610',alignItems:'center',background:i<3?m.bg+'44':'none',borderRadius:i<3?8:0}}>
                <div style={{fontSize:i<3?15:12,textAlign:'center',color:i===0?'#FBBF24':i===1?'#9CA3AF':i===2?'#F97316':'#2a3a28',fontWeight:600}}>
                  {i<3?['🥇','🥈','🥉'][i]:i+1}
                </div>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:11,...mono,color:'#c0d0c0'}}>{short(e.addr)}</div>
                  <div style={{fontSize:10,...muted,marginTop:1}}>{e.pools.join(' · ')}{e.lastSeen?` · ${timeAgo(e.lastSeen)}`:''}</div>
                </div>
                <div style={{textAlign:'right',fontSize:13,fontWeight:700,color:m.c}}>{val}</div>
                <div style={{textAlign:'right',fontSize:12,color:'#6a8a68'}}>{e.swaps}</div>
                <div><span style={{fontSize:11,padding:'2px 7px',borderRadius:20,background:m.bg,color:m.c,fontWeight:600,whiteSpace:'nowrap'}}>{m.e} {e.tier}</span></div>
              </div>
            )
          })}
        </>
      )}

      {!loading && loaded && sorted.length === 0 && (
        <div style={{padding:'28px',textAlign:'center',...muted,fontSize:13}}>No participants found yet</div>
      )}
    </div>
  )
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <div style={{minHeight:'100vh',background:'#080c0a',color:'#d8ead8',fontFamily:"'Inter',system-ui,sans-serif",fontSize:14}}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        input::placeholder{color:#1e3020}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#1c2820;border-radius:4px}
        @media(max-width:860px){.grid{grid-template-columns:1fr !important}}
      `}</style>

      {/* Topbar */}
      <div style={{background:'rgba(8,12,10,.96)',borderBottom:'1px solid #1c2820',position:'sticky',top:0,zIndex:50,backdropFilter:'blur(12px)'}}>
        <div style={{maxWidth:1240,margin:'0 auto',padding:'0 20px',height:50,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:28,height:28,borderRadius:7,background:'#1A9E74',display:'flex',alignItems:'center',justifyContent:'center',fontSize:15}}>⚖</div>
            <div>
              <div style={{fontSize:14,fontWeight:700,lineHeight:1.1}}>Stabilizer Tracker</div>
              <div style={{fontSize:11,color:'#3a5840'}}>Testnet · Ethereum Sepolia</div>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <span style={{fontSize:11,color:'#1A9E74',display:'flex',alignItems:'center',gap:5}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:'#1A9E74',display:'inline-block',animation:'pulse 2s infinite'}}/>Live
            </span>
            <span style={{fontSize:11,padding:'2px 8px',borderRadius:20,background:'#0d1410',border:'1px solid #1c2820',color:'#3a5840'}}>11155111</span>
            <a href="https://app.stabilizer.finance" target="_blank" rel="noopener noreferrer"
              style={{fontSize:12,padding:'4px 12px',background:'#0a2e1e',border:'1px solid #1A9E74',borderRadius:8,color:'#1A9E74',fontWeight:500,textDecoration:'none'}}>
              App ↗
            </a>
          </div>
        </div>
      </div>

      {/* Pool pills */}
      <div style={{maxWidth:1240,margin:'0 auto',padding:'12px 20px',display:'flex',gap:8,flexWrap:'wrap'}}>
        {POOLS.map(p=>(
          <span key={p.id} style={{fontSize:12,padding:'3px 10px',borderRadius:20,background:'#0d1410',border:`1px solid ${p.color}44`,color:p.color,fontWeight:500}}>
            ● {p.id} · {p.pair}
          </span>
        ))}
      </div>

      {/* Main grid */}
      <div className="grid" style={{maxWidth:1240,margin:'0 auto',padding:'0 20px 40px',display:'grid',gridTemplateColumns:'1fr 400px',gap:16,alignItems:'start'}}>
        <WalletPanel/>
        <Leaderboard/>
      </div>
    </div>
  )
}
