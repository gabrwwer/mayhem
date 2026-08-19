#!/usr/bin/env node
// Poll the API to collect flow trace events for up to timeoutSeconds
const API = process.env.API_URL || 'http://127.0.0.1:3001';
const pollInterval = 5000;
const timeoutSeconds = parseInt(process.env.TIMEOUT_SECONDS || '180', 10);
const wantedEvents = new Set(['TOKEN_DISCOVERED','FLOW_POST_ATTEMPT','FLOW_POST_ACCEPTED','CANDIDATE_DETECTED','EARLY_FLOW_EVALUATION']);

const seen = {};
const start = Date.now();

function nowSec(){ return ((Date.now()-start)/1000).toFixed(1); }

const AUTH = process.env.API_AUTH_TOKEN || 'testtoken';

async function fetchJson(path){
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${AUTH}` } });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function poll(){
  try{
    const events = await fetchJson('/api/events');
    for(const e of events){
      if (wantedEvents.has(e.eventType)){
        if (!seen[e.eventType]) seen[e.eventType] = [];
        // avoid duplicates (by id)
        if (!seen[e.eventType].find(x=>x.id===e.id)) seen[e.eventType].push(e);
      }
    }

    // discoveries
    const discoveries = await fetchJson('/api/discoveries');

    const summary = {
      time: nowSec(),
      discoveriesCount: Array.isArray(discoveries)?discoveries.length:0,
      eventsCaptured: Object.fromEntries(Object.entries(seen).map(([k,v])=>[k,v.length])),
    };

    console.log(JSON.stringify(summary));

    // If we have at least one TOKEN_DISCOVERED and FLOW_POST_ACCEPTED and EARLY_FLOW_EVALUATION, finish
    if ((seen['TOKEN_DISCOVERED']?.length||0) > 0 && (seen['FLOW_POST_ACCEPTED']?.length||0) > 0 && (seen['EARLY_FLOW_EVALUATION']?.length||0) > 0){
      console.log('Found complete trace — dumping details');
      const out = { discoveries, events: seen };
      console.log(JSON.stringify(out, null, 2));
      return true;
    }

    if (((Date.now()-start)/1000) > timeoutSeconds){
      console.log('Timeout reached — partial results:');
      console.log(JSON.stringify({ discoveries, events: seen }, null, 2));
      return true;
    }

    return false;
  }catch(err){
    console.error('Poll error', err.message || err);
    return false;
  }
}

(async ()=>{
  console.log('Collecting flow trace from', API);
  while(true){
    const done = await poll();
    if (done) break;
    await new Promise(r=>setTimeout(r,pollInterval));
  }
  process.exit(0);
})();
