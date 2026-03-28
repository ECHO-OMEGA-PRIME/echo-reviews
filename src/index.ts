// Echo Reviews v1.0.0 — AI-powered review management & reputation platform
// Cloudflare Worker: D1 + KV + Service Bindings (Engine Runtime, Shared Brain, Email Sender)

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  EMAIL_SENDER: Fetcher;
  ECHO_API_KEY: string;
  ENVIRONMENT: string;
}

interface RLState { c: number; t: number }

function sanitize(s: string, max = 2000): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}

function uid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

function slug(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  for (const b of arr) s += chars[b % chars.length];
  return s;
}

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Echo-API-Key,X-Tenant-ID');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data: unknown, status = 200): Response {
  return cors(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' , 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } }));
}

function err(message: string, status = 400): Response {
  return json({ error: message }

function slog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-reviews', version: '1.0.0', msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
, status);
}

function authOk(req: Request, env: Env): boolean {
  return (req.headers.get('X-Echo-API-Key') || req.headers.get('Authorization')?.replace('Bearer ', '')) === env.ECHO_API_KEY;
}

async function rateLimit(kv: KVNamespace, key: string, max: number, windowSec: number): Promise<boolean> {
  const k = `rl:${key}`;
  const raw = await kv.get(k);
  const now = Date.now();
  if (raw) {
    const st: RLState = JSON.parse(raw);
    const elapsed = (now - st.t) / 1000;
    const decayed = Math.max(0, st.c - (elapsed / windowSec) * max);
    if (decayed + 1 > max) return false;
    await kv.put(k, JSON.stringify({ c: decayed + 1, t: now } as RLState), { expirationTtl: windowSec * 2 });
  } else {
    await kv.put(k, JSON.stringify({ c: 1, t: now } as RLState), { expirationTtl: windowSec * 2 });
  }
  return true;
}

function tenantId(req: Request, url: URL): string {
  return req.headers.get('X-Tenant-ID') || url.searchParams.get('tenant_id') || '';
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    try {
      // ── Public endpoints ──
      if (p === '/health' || p === '/') return json({ status: 'ok', service: 'echo-reviews', version: '1.0.0', timestamp: new Date().toISOString() });

      // Public: submit a review via request token
      if (p === '/submit' && m === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (!await rateLimit(env.CACHE, `submit:${ip}`, 5, 3600)) return err('Rate limited', 429);
        const body = await req.json() as any;
        const { token, rating, title, body: reviewBody, reviewer_name } = body;
        if (!token || !rating || !reviewer_name) return err('token, rating, reviewer_name required');
        if (rating < 1 || rating > 5) return err('Rating must be 1-5');
        const rr = await env.DB.prepare('SELECT * FROM review_requests WHERE token = ? AND status IN (?, ?)').bind(token, 'sent', 'opened').first();
        if (!rr) return err('Invalid or expired review request', 404);
        const reviewId = uid();
        await env.DB.prepare(
          'INSERT INTO reviews (id, tenant_id, location_id, source, reviewer_name, reviewer_email, rating, title, body, status, is_verified, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime(?), datetime(?))'
        ).bind(reviewId, rr.tenant_id, rr.location_id, 'request', sanitize(reviewer_name, 100), rr.customer_email, rating, title ? sanitize(title, 200) : null, reviewBody ? sanitize(reviewBody) : null,
          rating >= 3 ? 'approved' : 'pending', 'now', 'now').run();
        await env.DB.prepare('UPDATE review_requests SET status = ?, completed_at = datetime(?) WHERE id = ?').bind('completed', 'now', rr.id).run();
        // Update location stats
        if (rr.location_id) {
          await env.DB.prepare('UPDATE locations SET total_reviews = total_reviews + 1, avg_rating = (SELECT AVG(rating) FROM reviews WHERE location_id = ? AND status = ?) WHERE id = ?')
            .bind(rr.location_id, 'approved', rr.location_id).run();
        }
        // AI sentiment analysis (fire-and-forget)
        if (reviewBody) {
          (async () => {
            try {
              const sr = await env.ENGINE_RUNTIME.fetch('https://engine/query', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ engine_id: 'GEN-01', query: `Analyze sentiment of this review. Reply with ONE word: positive, neutral, or negative. Then a score from -1.0 to 1.0.\n\nReview: "${reviewBody}"`, max_tokens: 50 })
              });
              const sd = await sr.json() as any;
              const text = (sd.response || sd.answer || '').toLowerCase();
              const sentiment = text.includes('positive') ? 'positive' : text.includes('negative') ? 'negative' : 'neutral';
              const scoreMatch = text.match(/-?\d+\.?\d*/);
              const score = scoreMatch ? parseFloat(scoreMatch[0]) : (sentiment === 'positive' ? 0.8 : sentiment === 'negative' ? -0.8 : 0);
              await env.DB.prepare('UPDATE reviews SET sentiment = ?, sentiment_score = ? WHERE id = ?').bind(sentiment, score, reviewId).run();
            } catch {}
          })();
        }
        return json({ success: true, review_id: reviewId });
      }

      // Public: review request landing page
      if (p.startsWith('/r/') && m === 'GET') {
        const token = p.slice(3);
        const rr = await env.DB.prepare('SELECT rr.*, t.name as tenant_name, t.logo_url, l.name as location_name FROM review_requests rr JOIN tenants t ON t.id = rr.tenant_id LEFT JOIN locations l ON l.id = rr.location_id WHERE rr.token = ?').bind(token).first();
        if (!rr) return cors(new Response('Review request not found or expired.', { status: 404, headers: { 'Content-Type': 'text/html' } }));
        if (rr.status === 'sent') await env.DB.prepare('UPDATE review_requests SET status = ?, opened_at = datetime(?) WHERE id = ?').bind('opened', 'now', rr.id).run();
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leave a Review — ${rr.tenant_name}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8fafc;color:#0f172a;display:flex;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:500px;width:100%;padding:32px}.logo{text-align:center;margin-bottom:16px}
h1{font-size:1.5rem;text-align:center;margin-bottom:8px}p.sub{text-align:center;color:#64748b;margin-bottom:24px}
.stars{display:flex;justify-content:center;gap:8px;margin-bottom:20px}.star{font-size:2.5rem;cursor:pointer;color:#cbd5e1;transition:color 0.2s}.star.active,.star:hover{color:#f59e0b}
label{display:block;font-weight:600;margin-bottom:4px;margin-top:16px}input,textarea{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:1rem}
textarea{min-height:100px;resize:vertical}button{width:100%;padding:14px;background:#14b8a6;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:20px}
button:hover{background:#0d9488}.done{text-align:center;padding:40px 0}.done h2{color:#14b8a6;margin-bottom:8px}</style></head>
<body><div class="card"><div id="form">${rr.logo_url ? `<div class="logo"><img src="${rr.logo_url}" alt="" style="max-height:48px"></div>` : ''}
<h1>How was your experience?</h1><p class="sub">${rr.location_name ? `at ${rr.location_name}` : `with ${rr.tenant_name}`}</p>
<div class="stars" id="stars">${[1,2,3,4,5].map(i => `<span class="star" data-v="${i}" onclick="setRating(${i})">&#9733;</span>`).join('')}</div>
<label>Your Name</label><input id="name" value="${rr.customer_name || ''}" placeholder="Your name">
<label>Title (optional)</label><input id="title" placeholder="Summarize your experience">
<label>Your Review</label><textarea id="body" placeholder="Tell us about your experience..."></textarea>
<button onclick="submit()">Submit Review</button></div><div id="done" style="display:none" class="done"><h2>Thank you!</h2><p>Your review has been submitted.</p></div></div>
<script>let rating=0;function setRating(r){rating=r;document.querySelectorAll('.star').forEach((s,i)=>s.classList.toggle('active',i<r))}
async function submit(){if(!rating){alert('Please select a rating');return}const b={token:'${token}',rating,reviewer_name:document.getElementById('name').value||'Anonymous',
title:document.getElementById('title').value,body:document.getElementById('body').value};const r=await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
if(r.ok){document.getElementById('form').style.display='none';document.getElementById('done').style.display='block'}else{const d=await r.json();alert(d.error||'Error submitting review')}}</script></body></html>`;
        return cors(new Response(html, { headers: { 'Content-Type': 'text/html' } }));
      }

      // Public: embeddable widget
      if (p === '/widget.js') {
        const wid = url.searchParams.get('id');
        if (!wid) return err('Widget id required');
        const cached = await env.CACHE.get(`widget:${wid}`, 'text');
        if (cached) return cors(new Response(cached, { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=300' } }));
        const w = await env.DB.prepare('SELECT w.*, t.name as tenant_name FROM widgets w JOIN tenants t ON t.id = w.tenant_id WHERE w.id = ?').bind(wid).first();
        if (!w) return err('Widget not found', 404);
        const reviews = await env.DB.prepare(
          'SELECT reviewer_name, rating, title, body, created_at FROM reviews WHERE tenant_id = ? AND status = ? AND rating >= ? ORDER BY created_at DESC LIMIT ?'
        ).bind(w.tenant_id, 'approved', w.min_rating, w.max_display).all();
        const stars = (r: number) => '★'.repeat(r) + '☆'.repeat(5 - r);
        const js = `(function(){var d=document,c=d.createElement('div');c.id='echo-reviews-widget';
var reviews=${JSON.stringify((reviews.results || []).map((r: any) => ({ n: r.reviewer_name, r: r.rating, t: r.title, b: r.body, d: r.created_at?.split('T')[0] })))};
var accent='${w.accent_color||'#14b8a6'}';var theme='${w.theme}';
var bg=theme==='dark'?'#0c1220':theme==='light'?'#fff':'(prefers-color-scheme:dark)'?'#0c1220':'#fff';
var tc=theme==='dark'?'#e2e8f0':'#0f172a';var tc2=theme==='dark'?'#94a3b8':'#64748b';
c.innerHTML='<style>#echo-reviews-widget{font-family:-apple-system,sans-serif}#echo-reviews-widget .erw-card{background:'+(theme==='dark'?'#0c1220':'#fff')+';border:1px solid '+(theme==='dark'?'#1e293b':'#e2e8f0')+';border-radius:12px;padding:16px;margin:8px 0}#echo-reviews-widget .erw-stars{color:#f59e0b}#echo-reviews-widget .erw-name{font-weight:700;color:'+tc+'}#echo-reviews-widget .erw-body{color:'+tc2+';font-size:14px;margin-top:6px}#echo-reviews-widget .erw-date{color:'+tc2+';font-size:12px}#echo-reviews-widget .erw-title{font-weight:600;color:'+tc+';margin-top:4px}#echo-reviews-widget .erw-header{text-align:center;margin-bottom:12px;color:'+tc+'}#echo-reviews-widget .erw-avg{font-size:2rem;font-weight:800;color:'+accent+'}</style>';
if(reviews.length){var avg=(reviews.reduce(function(s,r){return s+r.r},0)/reviews.length).toFixed(1);
c.innerHTML+='<div class="erw-header"><div class="erw-avg">'+avg+' / 5</div><div class="erw-stars">${'★'.repeat(4)}★</div><div>'+reviews.length+' reviews</div></div>';
reviews.forEach(function(r){c.innerHTML+='<div class="erw-card"><div><span class="erw-name">'+r.n+'</span> <span class="erw-date">'+r.d+'</span></div><div class="erw-stars">'+'★'.repeat(r.r)+'☆'.repeat(5-r.r)+'</div>'+(r.t?'<div class="erw-title">'+r.t+'</div>':'')+(r.b?'<div class="erw-body">'+r.b+'</div>':'')+'</div>'});}
else{c.innerHTML+='<div class="erw-header"><p>No reviews yet</p></div>';}
var s=d.currentScript||d.querySelector('script[src*="widget.js"]');if(s&&s.parentNode)s.parentNode.insertBefore(c,s);else d.body.appendChild(c);})();`;
        await env.CACHE.put(`widget:${wid}`, js, { expirationTtl: 300 });
        return cors(new Response(js, { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=300' } }));
      }

      // Public: review feed (JSON)
      if (p.startsWith('/public/') && p.endsWith('/reviews') && m === 'GET') {
        const tid = p.split('/')[2];
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
        const minRating = parseInt(url.searchParams.get('min_rating') || '1');
        const rows = await env.DB.prepare(
          'SELECT reviewer_name, rating, title, body, sentiment, created_at FROM reviews WHERE tenant_id = ? AND status = ? AND rating >= ? ORDER BY created_at DESC LIMIT ?'
        ).bind(tid, 'approved', minRating, limit).all();
        const stats = await env.DB.prepare(
          'SELECT COUNT(*) as total, AVG(rating) as avg_rating, SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive, SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative FROM reviews WHERE tenant_id = ? AND status = ?'
        ).bind(tid, 'approved').first();
        return json({ reviews: rows.results, stats });
      }

      // ── Auth-required endpoints ──
      if (!authOk(req, env)) return err('Unauthorized', 401);
      const tid = tenantId(req, url);

      // ── Tenants ──
      if (p === '/tenants' && m === 'POST') {
        const b = await req.json() as any;
        const id = uid();
        await env.DB.prepare('INSERT INTO tenants (id, name, domain, logo_url, reply_email) VALUES (?, ?, ?, ?, ?)')
          .bind(id, sanitize(b.name, 100), b.domain || null, b.logo_url || null, b.reply_email || null).run();
        return json({ id }, 201);
      }
      if (p === '/tenants' && m === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
        return json({ tenants: rows.results });
      }
      if (p.startsWith('/tenants/') && m === 'PUT') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const fields: string[] = []; const vals: any[] = [];
        for (const k of ['name', 'domain', 'logo_url', 'reply_email', 'auto_respond', 'review_request_delay_hours', 'min_rating_for_public']) {
          if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(typeof b[k] === 'string' ? sanitize(b[k], 500) : b[k]); }
        }
        if (fields.length) { vals.push(id); await env.DB.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run(); }
        return json({ updated: true });
      }

      // ── Locations ──
      if (p === '/locations' && m === 'POST') {
        const b = await req.json() as any;
        const id = uid();
        await env.DB.prepare('INSERT INTO locations (id, tenant_id, name, address, city, state, zip, phone, google_place_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, tid, sanitize(b.name, 200), b.address || null, b.city || null, b.state || null, b.zip || null, b.phone || null, b.google_place_id || null).run();
        return json({ id }, 201);
      }
      if (p === '/locations' && m === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM locations WHERE tenant_id = ? ORDER BY name').bind(tid).all();
        return json({ locations: rows.results });
      }
      if (p.startsWith('/locations/') && m === 'PUT') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const fields: string[] = []; const vals: any[] = [];
        for (const k of ['name', 'address', 'city', 'state', 'zip', 'phone', 'google_place_id']) {
          if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(sanitize(String(b[k]), 500)); }
        }
        if (fields.length) { vals.push(id); vals.push(tid); await env.DB.prepare(`UPDATE locations SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...vals).run(); }
        return json({ updated: true });
      }
      if (p.startsWith('/locations/') && m === 'DELETE') {
        const id = p.split('/')[2];
        await env.DB.prepare('DELETE FROM locations WHERE id = ? AND tenant_id = ?').bind(id, tid).run();
        return json({ deleted: true });
      }

      // ── Reviews ──
      if (p === '/reviews' && m === 'GET') {
        const status = url.searchParams.get('status');
        const source = url.searchParams.get('source');
        const rating = url.searchParams.get('rating');
        const location = url.searchParams.get('location_id');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
        const offset = parseInt(url.searchParams.get('offset') || '0');
        let where = 'tenant_id = ?'; const vals: any[] = [tid];
        if (status) { where += ' AND status = ?'; vals.push(status); }
        if (source) { where += ' AND source = ?'; vals.push(source); }
        if (rating) { where += ' AND rating = ?'; vals.push(parseInt(rating)); }
        if (location) { where += ' AND location_id = ?'; vals.push(location); }
        vals.push(limit, offset);
        const rows = await env.DB.prepare(`SELECT * FROM reviews WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...vals).all();
        const total = await env.DB.prepare(`SELECT COUNT(*) as c FROM reviews WHERE ${where.replace(/ LIMIT.*/, '')}`).bind(...vals.slice(0, -2)).first();
        return json({ reviews: rows.results, total: (total as any)?.c || 0 });
      }
      if (p === '/reviews' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.reviewer_name || !b.rating) return err('reviewer_name and rating required');
        const id = uid();
        await env.DB.prepare(
          'INSERT INTO reviews (id, tenant_id, location_id, source, source_review_id, reviewer_name, reviewer_email, rating, title, body, status, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(?), datetime(?))'
        ).bind(id, tid, b.location_id || null, b.source || 'manual', b.source_review_id || null, sanitize(b.reviewer_name, 100), b.reviewer_email || null,
          b.rating, b.title ? sanitize(b.title, 200) : null, b.body ? sanitize(b.body) : null, b.status || 'approved', 'now', 'now').run();
        return json({ id }, 201);
      }
      if (p.match(/^\/reviews\/[^/]+$/) && m === 'PATCH') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const fields: string[] = []; const vals: any[] = [];
        for (const k of ['status', 'tags', 'sentiment', 'sentiment_score']) {
          if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k]); }
        }
        if (b.status === 'approved' && !fields.some(f => f.startsWith('published'))) { fields.push('published_at = datetime(?)'); vals.push('now'); }
        if (fields.length) { vals.push(id, tid); await env.DB.prepare(`UPDATE reviews SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...vals).run(); }
        return json({ updated: true });
      }
      if (p.match(/^\/reviews\/[^/]+$/) && m === 'DELETE') {
        const id = p.split('/')[2];
        await env.DB.prepare('DELETE FROM reviews WHERE id = ? AND tenant_id = ?').bind(id, tid).run();
        return json({ deleted: true });
      }

      // ── Review Responses ──
      if (p.match(/^\/reviews\/[^/]+\/respond$/) && m === 'POST') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        if (!b.response) return err('response required');
        await env.DB.prepare('UPDATE reviews SET response = ?, responded_at = datetime(?), responded_by = ? WHERE id = ? AND tenant_id = ?')
          .bind(sanitize(b.response), 'now', b.responded_by || 'owner', id, tid).run();
        return json({ responded: true });
      }

      // AI response suggestion
      if (p.match(/^\/reviews\/[^/]+\/suggest-response$/) && m === 'POST') {
        const id = p.split('/')[2];
        const review = await env.DB.prepare('SELECT * FROM reviews WHERE id = ? AND tenant_id = ?').bind(id, tid).first();
        if (!review) return err('Review not found', 404);
        const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(tid).first();
        const prompt = `You are a professional business owner responding to a customer review. Business: ${(tenant as any)?.name || 'Our Business'}. Rating: ${review.rating}/5. Review: "${review.body || review.title || 'No text'}". Write a professional, warm, and concise response (2-3 sentences). If positive, thank them. If negative, apologize and offer to make it right. Never be defensive.`;
        const sr = await env.ENGINE_RUNTIME.fetch('https://engine/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine_id: 'GEN-01', query: prompt, max_tokens: 200 })
        });
        const sd = await sr.json() as any;
        return json({ suggestion: sd.response || sd.answer || 'Unable to generate suggestion.' });
      }

      // ── Review Requests ──
      if (p === '/requests' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.customer_email || !b.customer_name) return err('customer_email and customer_name required');
        const id = uid();
        const tkn = slug() + slug();
        const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
        await env.DB.prepare(
          'INSERT INTO review_requests (id, tenant_id, campaign_id, customer_name, customer_email, location_id, token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, tid, b.campaign_id || null, sanitize(b.customer_name, 100), sanitize(b.customer_email, 200), b.location_id || null, tkn, expiresAt).run();
        // Send email (fire-and-forget)
        const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(tid).first();
        const reviewUrl = `${url.origin}/r/${tkn}`;
        (async () => {
          try {
            await env.EMAIL_SENDER.fetch('https://email/send', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: b.customer_email,
                subject: `How was your experience with ${(tenant as any)?.name || 'us'}?`,
                html: `<p>Hi ${b.customer_name},</p><p>We'd love to hear about your recent experience. It only takes a minute!</p><p><a href="${reviewUrl}" style="display:inline-block;padding:12px 24px;background:#14b8a6;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">Leave a Review</a></p><p>Thank you!<br>${(tenant as any)?.name || 'The Team'}</p>`
              })
            });
            await env.DB.prepare('UPDATE review_requests SET status = ?, sent_at = datetime(?) WHERE id = ?').bind('sent', 'now', id).run();
          } catch {}
        })();
        return json({ id, token: tkn, review_url: reviewUrl }, 201);
      }
      if (p === '/requests' && m === 'GET') {
        const status = url.searchParams.get('status');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
        let q = 'SELECT * FROM review_requests WHERE tenant_id = ?';
        const vals: any[] = [tid];
        if (status) { q += ' AND status = ?'; vals.push(status); }
        q += ' ORDER BY created_at DESC LIMIT ?';
        vals.push(limit);
        const rows = await env.DB.prepare(q).bind(...vals).all();
        return json({ requests: rows.results });
      }

      // Bulk send review requests
      if (p === '/requests/bulk' && m === 'POST') {
        const b = await req.json() as any;
        if (!Array.isArray(b.customers) || !b.customers.length) return err('customers array required');
        const batch = b.customers.slice(0, 100);
        const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(tid).first();
        const results: any[] = [];
        for (const c of batch) {
          if (!c.email || !c.name) continue;
          const id = uid();
          const tkn = slug() + slug();
          const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
          await env.DB.prepare(
            'INSERT INTO review_requests (id, tenant_id, campaign_id, customer_name, customer_email, location_id, token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, tid, b.campaign_id || null, sanitize(c.name, 100), sanitize(c.email, 200), c.location_id || null, tkn, expiresAt).run();
          results.push({ id, email: c.email, token: tkn, review_url: `${url.origin}/r/${tkn}` });
        }
        return json({ sent: results.length, requests: results }, 201);
      }

      // ── Campaigns ──
      if (p === '/campaigns' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.name) return err('name required');
        const id = uid();
        await env.DB.prepare('INSERT INTO campaigns (id, tenant_id, name, subject, body_template, location_id, send_after_hours, reminder_enabled, reminder_after_hours, max_reminders) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, tid, sanitize(b.name, 200), b.subject ? sanitize(b.subject, 200) : 'How was your experience?', b.body_template || null, b.location_id || null,
            b.send_after_hours || 24, b.reminder_enabled ?? 1, b.reminder_after_hours || 72, b.max_reminders || 2).run();
        return json({ id }, 201);
      }
      if (p === '/campaigns' && m === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM campaigns WHERE tenant_id = ? ORDER BY created_at DESC').bind(tid).all();
        return json({ campaigns: rows.results });
      }
      if (p.startsWith('/campaigns/') && m === 'PUT') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const fields: string[] = []; const vals: any[] = [];
        for (const k of ['name', 'subject', 'body_template', 'status', 'send_after_hours', 'reminder_enabled', 'reminder_after_hours', 'max_reminders']) {
          if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(typeof b[k] === 'string' ? sanitize(b[k], 500) : b[k]); }
        }
        if (fields.length) { vals.push(id, tid); await env.DB.prepare(`UPDATE campaigns SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...vals).run(); }
        return json({ updated: true });
      }
      if (p.startsWith('/campaigns/') && m === 'DELETE') {
        const id = p.split('/')[2];
        await env.DB.prepare('DELETE FROM campaigns WHERE id = ? AND tenant_id = ?').bind(id, tid).run();
        return json({ deleted: true });
      }

      // ── Widgets ──
      if (p === '/widgets' && m === 'POST') {
        const b = await req.json() as any;
        const id = uid();
        await env.DB.prepare('INSERT INTO widgets (id, tenant_id, name, type, min_rating, max_display, show_avatars, show_dates, theme, accent_color, allowed_domains) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, tid, b.name || 'Default Widget', b.type || 'carousel', b.min_rating || 4, b.max_display || 10, b.show_avatars ?? 1, b.show_dates ?? 1, b.theme || 'auto', b.accent_color || '#14b8a6', JSON.stringify(b.allowed_domains || [])).run();
        const widgetTag = `<script src="${url.origin}/widget.js?id=${id}"></script>`;
        return json({ id, widget_tag: widgetTag }, 201);
      }
      if (p === '/widgets' && m === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM widgets WHERE tenant_id = ? ORDER BY created_at DESC').bind(tid).all();
        return json({ widgets: rows.results });
      }
      if (p.startsWith('/widgets/') && m === 'PUT') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const fields: string[] = []; const vals: any[] = [];
        for (const k of ['name', 'type', 'min_rating', 'max_display', 'show_avatars', 'show_dates', 'theme', 'accent_color', 'custom_css']) {
          if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(typeof b[k] === 'string' ? sanitize(b[k], 2000) : b[k]); }
        }
        if (b.allowed_domains) { fields.push('allowed_domains = ?'); vals.push(JSON.stringify(b.allowed_domains)); }
        if (fields.length) { vals.push(id, tid); await env.DB.prepare(`UPDATE widgets SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...vals).run(); }
        await env.CACHE.delete(`widget:${id}`);
        return json({ updated: true });
      }
      if (p.startsWith('/widgets/') && m === 'DELETE') {
        const id = p.split('/')[2];
        await env.DB.prepare('DELETE FROM widgets WHERE id = ? AND tenant_id = ?').bind(id, tid).run();
        await env.CACHE.delete(`widget:${id}`);
        return json({ deleted: true });
      }

      // ── Competitors ──
      if (p === '/competitors' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.name) return err('name required');
        const id = uid();
        await env.DB.prepare('INSERT INTO competitors (id, tenant_id, name, google_place_id) VALUES (?, ?, ?, ?)').bind(id, tid, sanitize(b.name, 200), b.google_place_id || null).run();
        return json({ id }, 201);
      }
      if (p === '/competitors' && m === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM competitors WHERE tenant_id = ? ORDER BY name').bind(tid).all();
        return json({ competitors: rows.results });
      }
      if (p.startsWith('/competitors/') && m === 'DELETE') {
        const id = p.split('/')[2];
        await env.DB.prepare('DELETE FROM competitors WHERE id = ? AND tenant_id = ?').bind(id, tid).run();
        return json({ deleted: true });
      }

      // ── Analytics ──
      if (p === '/analytics/overview' && m === 'GET') {
        const days = parseInt(url.searchParams.get('days') || '30');
        const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        const cacheKey = `analytics:${tid}:overview:${days}`;
        const cached = await env.CACHE.get(cacheKey, 'json');
        if (cached) return json(cached);
        const totals = await env.DB.prepare(
          'SELECT COUNT(*) as total_reviews, AVG(rating) as avg_rating, SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive, SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as neutral, SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative FROM reviews WHERE tenant_id = ? AND status = ?'
        ).bind(tid, 'approved').first();
        const recent = await env.DB.prepare(
          'SELECT COUNT(*) as recent_reviews, AVG(rating) as recent_avg FROM reviews WHERE tenant_id = ? AND status = ? AND created_at >= ?'
        ).bind(tid, 'approved', since).first();
        const byRating = await env.DB.prepare(
          'SELECT rating, COUNT(*) as count FROM reviews WHERE tenant_id = ? AND status = ? GROUP BY rating ORDER BY rating DESC'
        ).bind(tid, 'approved').all();
        const bySource = await env.DB.prepare(
          'SELECT source, COUNT(*) as count, AVG(rating) as avg_rating FROM reviews WHERE tenant_id = ? AND status = ? GROUP BY source ORDER BY count DESC'
        ).bind(tid, 'approved').all();
        const requestStats = await env.DB.prepare(
          'SELECT COUNT(*) as total, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as completed FROM review_requests WHERE tenant_id = ?'
        ).bind('completed', tid).first();
        const responseRate = await env.DB.prepare(
          'SELECT COUNT(*) as total, SUM(CASE WHEN response IS NOT NULL THEN 1 ELSE 0 END) as responded FROM reviews WHERE tenant_id = ? AND status = ?'
        ).bind(tid, 'approved').first();
        const result = { totals, recent, by_rating: byRating.results, by_source: bySource.results, request_stats: requestStats, response_rate: responseRate };
        await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });
        return json(result);
      }

      if (p === '/analytics/trends' && m === 'GET') {
        const days = parseInt(url.searchParams.get('days') || '30');
        const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        const rows = await env.DB.prepare(
          'SELECT date, reviews_received, avg_rating, requests_sent, requests_completed, responses_sent, positive, neutral, negative FROM analytics_daily WHERE tenant_id = ? AND date >= ? ORDER BY date'
        ).bind(tid, since).all();
        return json({ trends: rows.results });
      }

      if (p === '/analytics/sentiment' && m === 'GET') {
        const rows = await env.DB.prepare(
          'SELECT sentiment, COUNT(*) as count, AVG(sentiment_score) as avg_score FROM reviews WHERE tenant_id = ? AND status = ? AND sentiment IS NOT NULL GROUP BY sentiment'
        ).bind(tid, 'approved').all();
        const recent = await env.DB.prepare(
          "SELECT DATE(created_at) as date, sentiment, COUNT(*) as count FROM reviews WHERE tenant_id = ? AND status = ? AND sentiment IS NOT NULL AND created_at >= datetime('now', '-30 days') GROUP BY DATE(created_at), sentiment ORDER BY date"
        ).bind(tid, 'approved').all();
        return json({ breakdown: rows.results, daily: recent.results });
      }

      // AI: analyze review trends
      if (p === '/analytics/ai-insights' && m === 'GET') {
        const reviews = await env.DB.prepare(
          'SELECT rating, title, body, sentiment, created_at FROM reviews WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT 50'
        ).bind(tid, 'approved').all();
        const prompt = `Analyze these ${reviews.results?.length || 0} customer reviews and provide: 1) Top 3 strengths customers mention, 2) Top 3 areas for improvement, 3) Overall sentiment trend, 4) One actionable recommendation. Be specific and concise.\n\nReviews:\n${(reviews.results || []).map((r: any) => `[${r.rating}★] ${r.title || ''}: ${r.body || 'No text'}`).join('\n')}`;
        const sr = await env.ENGINE_RUNTIME.fetch('https://engine/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine_id: 'GEN-01', query: prompt, max_tokens: 500 })
        });
        const sd = await sr.json() as any;
        return json({ insights: sd.response || sd.answer || 'Unable to generate insights.' });
      }

      // ── Export ──
      if (p === '/export' && m === 'GET') {
        const format = url.searchParams.get('format') || 'json';
        const rows = await env.DB.prepare('SELECT * FROM reviews WHERE tenant_id = ? ORDER BY created_at DESC').bind(tid).all();
        if (format === 'csv') {
          const headers = 'id,reviewer_name,reviewer_email,rating,title,body,sentiment,source,status,created_at\n';
          const csv = headers + (rows.results || []).map((r: any) =>
            `"${r.id}","${r.reviewer_name}","${r.reviewer_email || ''}",${r.rating},"${(r.title || '').replace(/"/g, '""')}","${(r.body || '').replace(/"/g, '""')}","${r.sentiment || ''}","${r.source}","${r.status}","${r.created_at}"`
          ).join('\n');
          return cors(new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=reviews.csv' } }));
        }
        return json({ reviews: rows.results, total: rows.results?.length || 0 });
      }

      return err('Not found', 404);
    } catch (e: any) {
      if (e.message?.includes('JSON')) {
        return err('Invalid JSON body', 400);
      }
      slog('error', 'Unhandled request error', { error: e.message, stack: e.stack });
      return err('Internal server error', 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // Daily analytics aggregation
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const tenants = await env.DB.prepare('SELECT id FROM tenants').all();
    for (const t of (tenants.results || [])) {
      const tid = (t as any).id;
      const stats = await env.DB.prepare(
        `SELECT COUNT(*) as reviews_received, AVG(rating) as avg_rating,
         SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
         SUM(CASE WHEN sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral,
         SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative
         FROM reviews WHERE tenant_id = ? AND DATE(created_at) = ?`
      ).bind(tid, yesterday).first();
      const reqStats = await env.DB.prepare(
        `SELECT COUNT(*) as sent FROM review_requests WHERE tenant_id = ? AND DATE(sent_at) = ?`
      ).bind(tid, yesterday).first();
      const reqCompleted = await env.DB.prepare(
        `SELECT COUNT(*) as completed FROM review_requests WHERE tenant_id = ? AND DATE(completed_at) = ?`
      ).bind(tid, yesterday).first();
      const responded = await env.DB.prepare(
        `SELECT COUNT(*) as responded FROM reviews WHERE tenant_id = ? AND DATE(responded_at) = ?`
      ).bind(tid, yesterday).first();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO analytics_daily (tenant_id, date, reviews_received, avg_rating, requests_sent, requests_completed, responses_sent, positive, neutral, negative)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(tid, yesterday, (stats as any)?.reviews_received || 0, (stats as any)?.avg_rating || 0,
        (reqStats as any)?.sent || 0, (reqCompleted as any)?.completed || 0, (responded as any)?.responded || 0,
        (stats as any)?.positive || 0, (stats as any)?.neutral || 0, (stats as any)?.negative || 0).run();
    }
    // Expire old review requests
    await env.DB.prepare("UPDATE review_requests SET status = 'expired' WHERE status IN ('pending','sent','opened') AND expires_at < datetime('now')").run();
    // Process reminders for campaigns with reminder_enabled
    const campaigns = await env.DB.prepare("SELECT c.*, t.name as tenant_name FROM campaigns c JOIN tenants t ON t.id = c.tenant_id WHERE c.status = 'active' AND c.reminder_enabled = 1").all();
    for (const camp of (campaigns.results || [])) {
      const c = camp as any;
      const pending = await env.DB.prepare(
        "SELECT * FROM review_requests WHERE campaign_id = ? AND status IN ('sent','opened') AND reminder_count < ? AND datetime(COALESCE(last_reminder_at, sent_at), '+' || ? || ' hours') < datetime('now')"
      ).bind(c.id, c.max_reminders, c.reminder_after_hours).all();
      for (const rr of (pending.results || [])) {
        const r = rr as any;
        try {
          await env.EMAIL_SENDER.fetch('https://email/send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: r.customer_email,
              subject: `Reminder: Share your experience with ${c.tenant_name}`,
              html: `<p>Hi ${r.customer_name},</p><p>We noticed you haven't left your review yet. We'd really appreciate your feedback!</p><p><a href="${new URL(r.token ? `/r/${r.token}` : '/', 'https://echo-reviews.bmcii1976.workers.dev').href}" style="display:inline-block;padding:12px 24px;background:#14b8a6;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">Leave a Review</a></p><p>Thank you!<br>${c.tenant_name}</p>`
            })
          });
          await env.DB.prepare('UPDATE review_requests SET reminder_count = reminder_count + 1, last_reminder_at = datetime(?) WHERE id = ?').bind('now', r.id).run();
        } catch {}
      }
    }
  }
};
