import "./order-book.js";
import { MARKET_LIMITS, SIGNAL_LIMITS, TIMEFRAMES, TRADE_DEFAULTS } from "./constants.js";
import { KrakenClient } from "./kraken.js";
import { analyzeMarket } from "./signals.js";
import { blendSignalWithContext, emptyContext, normalizeContext } from "./context-engine.js";
import { renderDecisionCards } from "./decision-ui.js";
import { CORE_SYMBOLS, selectTradeUniverse, TRADE_UNIVERSE_LIMIT } from "./trade-universe.js";
import { classifyDashboardSignals } from "./strategy-runtime.js";

const client = new KrakenClient();
const state = { markets:new Map(), tickers:new Map(), candles:{}, rawSignals:new Map(), signals:new Map(), contexts:new Map(), universe:[], connection:"connecting", analytics:null };
const assetName=(symbol)=>symbol==="PF_XBTUSD"?"BTC":symbol==="PF_ETHUSD"?"ETH":String(symbol).replace(/^PF_/,"").replace(/USD$/,"");
function mergeTicker(symbol,patch){state.tickers.set(symbol,{...(state.tickers.get(symbol)||{}),...patch,symbol});}
function hardenSettingsUi(){const leverage=document.getElementById("maxLeverage");if(leverage){[...leverage.options].forEach(o=>{if(Number(o.value)>SIGNAL_LIMITS.absoluteMaxLeverage)o.remove();});if(Number(leverage.value)>SIGNAL_LIMITS.absoluteMaxLeverage)leverage.value=String(SIGNAL_LIMITS.defaultMaxLeverage);}const risk=document.getElementById("riskPercentage");if(risk){risk.max=String(TRADE_DEFAULTS.maximumRiskPct);if(Number(risk.value)>TRADE_DEFAULTS.maximumRiskPct)risk.value=String(TRADE_DEFAULTS.riskPct);}}
async function loadContext(symbol){const asset=assetName(symbol);if(!CORE_SYMBOLS.includes(symbol)){state.contexts.set(symbol,emptyContext(asset));return;}try{const r=await fetch(`/api/context/${asset.toLowerCase()}`,{cache:"no-store",headers:{accept:"application/json"}});if(!r.ok)throw new Error();state.contexts.set(symbol,normalizeContext(await r.json(),asset));}catch{state.contexts.set(symbol,emptyContext(asset));}}
function reclassify(){state.signals=classifyDashboardSignals({signals:state.rawSignals,candles:state.candles,tickers:state.tickers});}
function evaluate(symbol,reclassifyNow=true){const market=state.markets.get(symbol),ticker=state.tickers.get(symbol)||{};if(!market)return;const technical=analyzeMarket({symbol,candlesByTimeframe:state.candles[symbol]||{},ticker,instrument:market,turnoverQuality:.9,dataAgeMs:Date.now()-(Number(ticker.receivedAt)||0),maxLeverage:SIGNAL_LIMITS.defaultMaxLeverage});state.rawSignals.set(symbol,blendSignalWithContext(technical,state.contexts.get(symbol)||emptyContext(assetName(symbol))));if(reclassifyNow)reclassify();}
const pendingSymbols=new Set();let signalUpdateTimer=null;
function scheduleSignalUpdate(symbol){pendingSymbols.add(symbol);if(signalUpdateTimer)return;signalUpdateTimer=setTimeout(()=>{signalUpdateTimer=null;for(const pending of pendingSymbols)evaluate(pending,false);pendingSymbols.clear();reclassify();render();},500);}
function ensureDesk(){let desk=document.getElementById("decisionDesk");if(desk)return desk;const main=document.querySelector(".dashboard-grid");desk=document.createElement("section");desk.id="decisionDesk";desk.className="decision-desk panel primary-decision-desk";desk.innerHTML=`<div class="panel-heading decision-heading"><div><h2>85+ Trade Decision Desk</h2><span>Dynamische top-${TRADE_UNIVERSE_LIMIT} · BTC/ETH altijd · strengere altcoin-gates</span></div><small>Alleen A/A+ met bevestigde setup kan tradewaardig worden.</small></div><div id="decisionSummary" class="decision-summary"></div><div id="decisionCards" class="decision-cards"><p class="empty-copy">Universum wordt geladen…</p></div>`;main?.prepend(desk);return desk;}
function ensureStrategyValidation(){
  let section=document.getElementById("strategyValidation");
  if(section)return section;
  section=document.createElement("section");
  section.id="strategyValidation";
  section.className="strategy-validation";
  section.innerHTML='<details><summary><span><strong>Strategievalidatie</strong><small>24u expectancy per scoreband</small></span><span>Open resultaten</span></summary><div class="strategy-validation-body"><div class="strategy-heading"><div><h2>PRIME, OPPORTUNITY en SHADOW</h2><span>Technisch en statistisch volledig gescheiden.</span></div><small>Split: 50% T1 + 50% restant met originele stop</small></div><div class="tier-counts"><div><span>PRIME</span><strong id="primeTierCount">0</strong><small>1.0R</small></div><div class="opportunity-tier"><span>OPPORTUNITY</span><strong id="opportunityTierCount">0</strong><small>0.25R · experimenteel</small></div><div><span>SHADOW</span><strong id="shadowTierCount">0</strong><small>0R · geen alert</small></div></div><div id="strategyPerformance" class="strategy-performance"><p class="empty-copy">Outcome-data laden…</p></div></div></details>';
  document.getElementById("decisionCards")?.before(section);
  return section;
}
async function loadAnalytics(){
  try{
    const response=await fetch("/api/strategy/analytics",{headers:{accept:"application/json"}});
    if(!response.ok)throw new Error();
    state.analytics=await response.json();
  }catch{
    state.analytics={configured:false,message:"Outcome-data is tijdelijk niet beschikbaar."};
  }
}
const metric=(value,suffix="")=>Number.isFinite(Number(value))?Number(value).toLocaleString("nl-NL",{minimumFractionDigits:1,maximumFractionDigits:1})+suffix:"—";
function renderStrategyValidation(contexts){
  ensureStrategyValidation();
  const count=(tier)=>contexts.filter(({signal})=>signal.classification?.signalTier===tier).length;
  const prime=document.getElementById("primeTierCount"),opportunity=document.getElementById("opportunityTierCount"),shadow=document.getElementById("shadowTierCount");
  if(prime)prime.textContent=String(count("PRIME"));
  if(opportunity)opportunity.textContent=String(count("OPPORTUNITY"));
  if(shadow)shadow.textContent=String(count("SHADOW"));
  const target=document.getElementById("strategyPerformance");
  if(!target)return;
  if(!state.analytics?.configured){
    target.innerHTML='<p class="empty-copy">'+(state.analytics?.message||"Neon-outcomes zijn nog niet geconfigureerd; live tiercounts blijven wel zichtbaar.")+'</p>';
    return;
  }
  target.innerHTML='<div class="performance-table" role="table" aria-label="Resultaten per scoreband"><div class="performance-row performance-head" role="row"><span>Scoreband</span><span>n</span><span>Win</span><span>T1</span><span>T2</span><span>Stop</span><span>MFE R</span><span>MAE R</span><span>Expectancy</span></div>'+state.analytics.bands.map((band)=>'<div class="performance-row" role="row"><strong>'+band.label+'</strong><span>'+band.sampleSize+'</span><span>'+metric(band.winRate,"%")+'</span><span>'+metric(band.t1HitRate,"%")+'</span><span>'+metric(band.t2HitRate,"%")+'</span><span>'+metric(band.stopRate,"%")+'</span><span>'+metric(band.averageMfeR,"R")+'</span><span>'+metric(band.averageMaeR,"R")+'</span><span>'+metric(band.expectancyR,"R")+'</span><small class="'+(band.sufficientSample?"sample-ok":"sample-low")+'">'+(band.sufficientSample?"steekproef bruikbaar":"n="+band.sampleSize+" — onvoldoende data")+'</small></div>').join("")+'</div>';
}
function renderHeader(){
  const connectionStatus=document.getElementById("connectionStatus");
  const connectionLabel=document.getElementById("connectionLabel");
  const footerConnection=document.getElementById("footerConnection");
  const lastUpdated=document.getElementById("lastUpdated");
  const marketRegime=document.getElementById("marketRegime");
  const bestSetup=document.getElementById("bestSetup");
  const activeSignals=document.getElementById("activeSignals");
  const dataQuality=document.getElementById("dataQuality");
  const rows=state.universe.map((market)=>({market,signal:state.signals.get(market.symbol),ticker:state.tickers.get(market.symbol)})).filter((row)=>row.signal);
  const prime=rows.filter((row)=>row.signal.classification?.signalTier==="PRIME"&&row.signal.classification?.eligible);
  const opportunity=rows.filter((row)=>row.signal.classification?.signalTier==="OPPORTUNITY"&&row.signal.classification?.eligible);
  const freshRows=rows.filter((row)=>Date.now()-(Number(row.ticker?.receivedAt)||0)<=SIGNAL_LIMITS.staleAfterMs);
  const freshest=rows.reduce((latest,row)=>Math.max(latest,Number(row.ticker?.receivedAt)||0),0);
  const hasData=rows.length>0;
  const live=hasData&&freshRows.length===rows.length&&state.connection!=="offline";
  const label=!hasData?"VERBINDEN":live?"LIVE":freshRows.length?"REST":"OFFLINE";
  if(connectionStatus)connectionStatus.className="connection "+(label==="LIVE"?"":label==="VERBINDEN"?"connection-loading":"connection-offline");
  if(connectionLabel)connectionLabel.textContent=label;
  if(footerConnection)footerConnection.textContent=label;
  if(lastUpdated)lastUpdated.textContent=freshest?new Date(freshest).toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit",second:"2-digit"}):"—";
  const btc=state.signals.get("PF_XBTUSD");
  if(marketRegime){marketRegime.textContent=btc?.marketRegime||"Data laden…";marketRegime.className=btc?.marketRegime==="BEARISH"?"bad":btc?.marketRegime==="NEUTRAAL"?"warning":"";}
  const best=[...prime,...opportunity].sort((a,b)=>(Number(b.signal.score)||0)-(Number(a.signal.score)||0))[0];
  if(bestSetup)bestSetup.textContent=best?assetName(best.market.symbol)+" "+(best.signal.classification?.signalTier||best.signal.status)+" "+best.signal.score:"Geen vrijgave";
  if(activeSignals)activeSignals.textContent=String(prime.length);
  if(dataQuality){dataQuality.textContent=!hasData?"Controleren…":freshRows.length+"/"+rows.length+" actueel";dataQuality.className=hasData&&freshRows.length===rows.length?"":freshRows.length?"warning":"bad";}
}
function render(){
  ensureDesk();
  ensureStrategyValidation();
  hardenSettingsUi();
  const cards=document.getElementById("decisionCards");
  const summary=document.getElementById("decisionSummary");
  if(!cards)return;
  const contexts=state.universe.map((market)=>{
    const signal=state.signals.get(market.symbol),ticker=state.tickers.get(market.symbol);
    return signal?{market,ticker,signal}:null;
  }).filter(Boolean).sort((a,b)=>(Number(b.signal.score)||0)-(Number(a.signal.score)||0));
  const count=(tier)=>contexts.filter((context)=>context.signal.classification?.signalTier===tier).length;
  if(summary)summary.innerHTML='<div><span>Universum</span><strong>'+state.universe.length+'/'+TRADE_UNIVERSE_LIMIT+'</strong></div><div><span>85+ PRIME</span><strong class="'+(count("PRIME")?"positive":"neutral")+'">'+count("PRIME")+'</strong></div><div><span>82–84 Opportunity</span><strong class="'+(count("OPPORTUNITY")?"opportunity-text":"neutral")+'">'+count("OPPORTUNITY")+'</strong></div><div><span>Shadow research</span><strong>'+count("SHADOW")+'</strong></div>';
  renderHeader();
  renderStrategyValidation(contexts);
  if(!contexts.length){cards.innerHTML='<p class="empty-copy">Marktdata wordt geladen…</p>';return;}
  cards.innerHTML=contexts.map((context)=>{
    const classification=context.signal.classification||{};
    const wrapper=document.createElement("div");
    renderDecisionCards(wrapper,[context]);
    let banner;
    if(classification.signalTier==="PRIME"&&classification.eligible)banner='<div class="trade-ready-banner">🚨 85+ PRIME · '+context.signal.status+' · '+context.signal.tradeQuality+' · Risk class 1.0R</div>';
    else if(classification.signalTier==="OPPORTUNITY"&&classification.eligible)banner='<div class="opportunity-banner">🟠 82–84 OPPORTUNITY · Risk class 0.25R · Experimental / lower confidence than PRIME</div>';
    else if(classification.signalTier==="SHADOW")banner='<div class="shadow-banner">SHADOW RESEARCH · 0R · geen alert'+(classification.status==="CHASE_BLOCKED"?" · entry gemist":"")+'</div>';
    else banner='<div class="trade-gate-note">'+((Number(context.signal.score)||0)>=75?"Niet vrijgegeven: "+(classification.reasons||[]).slice(0,2).join(" · "):"Onder 75 — alleen context")+'</div>';
    return '<div class="universe-decision tier-'+String(classification.signalTier||"none").toLowerCase()+' '+(classification.eligible?"is-ready":"")+'">'+banner+wrapper.innerHTML+'</div>';
  }).join("");
}
async function load(){ensureDesk();ensureStrategyValidation();hardenSettingsUi();renderHeader();await loadAnalytics();try{const [markets,tickers]=await Promise.all([client.getInstruments(),client.getTickers()]);markets.forEach(m=>state.markets.set(m.symbol,m));tickers.forEach(t=>mergeTicker(t.symbol,t));state.universe=selectTradeUniverse(markets,state.tickers);await Promise.all(state.universe.map(m=>loadContext(m.symbol)));await Promise.all(state.universe.flatMap(m=>Object.keys(TIMEFRAMES).map(async interval=>{state.candles[m.symbol]||={};state.candles[m.symbol][interval]=await client.getCandles(m.symbol,interval,MARKET_LIMITS.chartHistory);})));state.universe.forEach(m=>evaluate(m.symbol,false));reclassify();state.connection="live";render();const symbols=state.universe.map(m=>m.symbol);client.connectPublic(symbols,{getBookOptions(symbol){const m=state.markets.get(symbol);return{contractSize:m?.contractSize||1,targetNotionalUSD:1000};},onStatus(status){state.connection=status;renderHeader();},onTicker(symbol,t){if(!state.markets.has(symbol))return;mergeTicker(symbol,t);scheduleSignalUpdate(symbol);},onBookMetrics(symbol,m){mergeTicker(symbol,m);scheduleSignalUpdate(symbol);},onBookInvalid(symbol){mergeTicker(symbol,{bookValidated:false});scheduleSignalUpdate(symbol);}});setInterval(async()=>{await Promise.all([loadAnalytics(),...CORE_SYMBOLS.map(loadContext)]);state.universe.forEach(m=>evaluate(m.symbol,false));reclassify();render();},5*60*1000);}catch(error){state.connection="offline";renderHeader();const cards=document.getElementById("decisionCards");if(cards)cards.innerHTML=`<p class="empty-copy">Decision Desk kon niet volledig laden. Probeer de marktdata te vernieuwen.</p>`;console.warn("85+ Decision Desk unavailable",error);}}
window.addEventListener("DOMContentLoaded",load);
