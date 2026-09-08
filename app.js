import * as P from './planner.js';
import { CONFIG } from './config.js';
import { cloud, initCloud, onCloudChange, signIn, signOut, isPro, pullState, pushStateSoon } from './cloud.js';

const KEY = 'fuel:v1';
const APP_VERSION = 'v21';
const FREE_LIBRARY_LIMIT = 8;
const DATA = { ingredients: [], recipes: [] };
const S = load();

function load() {
  const base = { tab: 'plan', activeWeek: null, weeks: {}, tubs: {}, customRecipes: [], customIngredients: [], inbox: [], settings: { portion: 1, weight: 85, goal: 'build', proteinTarget: 180, snackProtein: 24, budget: 50, avoid: [] } };
  try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return base; }
}
function syncable() { const { tab, search, planSearch, ideasOpen, ideaTag, ...rest } = S; return rest; }
function save() { S.updatedAt = new Date().toISOString(); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} pushStateSoon(syncable); }

const ING = () => DATA.ingredients.concat(S.customIngredients);
const RAW = () => DATA.recipes.concat(S.customRecipes);
let SCALED = { f: null, list: null, n: 0 };
// Meals (not snacks) are scaled so the active week's picks land on the calorie target.
function mealsKcalAt1x(w) {
  const raw = RAW(); const ing = ING(); const rec = Object.fromEntries(raw.map((r) => [r.id, r]));
  const active = (w.days || []).filter(Boolean).length || 1;
  let meals = 0, snacks = 0;
  (w.grid || []).forEach((d, i) => { if (!w.days[i]) return; for (const sl of P.SLOTS) { const v = d[sl]; const rid = P.isTub(v) ? P.tubRecipe(v) : v; if (rid && rec[rid]) meals += P.kcalPerPortion(rec[rid], ing); } });
  for (const [id, n] of Object.entries(w.snacks || {})) if (rec[id] && n) snacks += P.kcalPerPortion(rec[id], ing) * n;
  return { meals: meals / active, snacks: snacks / active };
}
function weekFactor(w, kcalTarget = S.settings.kcalTarget) {
  if (!w || !w.grid) return 1;
  const { meals, snacks } = mealsKcalAt1x(w);
  if (!meals || !kcalTarget) return 1;
  const f = (kcalTarget - snacks) / meals;
  return Math.round(Math.min(1.6, Math.max(0.6, f)) * 20) / 20;
}
const REC = () => {
  const raw = RAW(); const w = S.weeks?.[S.activeWeek];
  const f = weekFactor(w);
  if (SCALED.f !== f || SCALED.n !== raw.length) { SCALED = { f, n: raw.length, list: raw.map((r) => (r.slots.includes('snack') ? r : { ...r, ingredients: r.ingredients.map((x) => ({ id: x.id, qty: Math.round(x.qty * f * 100) / 100 })) })) }; META.clear(); }
  return SCALED.list;
};
const inLibrary = (id) => !S.library || S.library.includes(id);
const ingById = (id) => ING().find((i) => i.id === id);
// What actually gets bought for an ingredient id: the week's fruit pick, thighs instead of breast.
function resolveFor(w) {
  return (id) => {
    if (id === 'chicken_breast' && S.settings.preferThigh) return 'chicken_thigh';
    const it = ingById(id);
    if (it?.choices?.length) return (w.choices && w.choices[id]) || it.choices[0];
    return id;
  };
}
const recById = (id) => REC().find((r) => r.id === id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const cellStyle = (id) => `background:hsl(${hue(id)} 90% 82%);color:hsl(${hue(id)} 70% 22%);`;

// ---------- weeks ----------
const iso = (d) => d.toISOString().slice(0, 10);
function sundayOf(date) { const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return iso(d); }
function addDays(isoDate, n) { const d = new Date(isoDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function fmtDate(isoDate) { const d = new Date(isoDate + 'T00:00:00Z'); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
const W = () => S.weeks[S.activeWeek];
function blankWeek() { return { portions: {}, grid: null, overflow: [], cookDay: 0, ticks: {}, days: [true, true, true, true, true, true, true], choices: {}, pantry: {}, fresh: {} }; }
function setupWeeks() {
  const thisSun = sundayOf(new Date()), nextSun = addDays(thisSun, 7);
  // migrate v1 single-week state
  if (S.portions) { S.weeks[thisSun] = { portions: S.portions, grid: S.grid, overflow: S.overflow || [], cookDay: S.cookDay || 0, ticks: S.ticks || {} }; delete S.portions; delete S.grid; delete S.overflow; delete S.cookDay; delete S.ticks; }
  for (const k of Object.keys(S.weeks)) if (k < thisSun) delete S.weeks[k];
  S.weeks[thisSun] ||= blankWeek(); S.weeks[nextSun] ||= blankWeek();
  if (!S.weeks[S.activeWeek]) S.activeWeek = thisSun;
  S.thisSun = thisSun; S.nextSun = nextSun;
  // pantry used to be one global list; it now belongs to each week (a fresh week starts with nothing ticked)
  if (S.pantry) { const p = S.pantry; if (p.peppers_frozen !== undefined) { p.pepper = p.peppers_frozen; delete p.peppers_frozen; } S.weeks[thisSun].pantry = { ...(S.weeks[thisSun].pantry || {}), ...p }; delete S.pantry; }
  S.tubs ||= {}; S.freshDefault ||= {}; S.settings.avoid ||= []; S.settings.weight ||= 85; S.settings.goal ||= 'build'; S.settings.kcalTarget ||= P.kcalTargetFor(S.settings.weight, S.settings.goal);
  // Personal recipe library: existing users keep everything they had; new users start with the core set and add from Ideas.
  // Personal recipe library. Starts as the core set; everything else lives in "Find more meal ideas".
  // Free accounts (cloud on, not paid) start with the first 8 core recipes; everyone else with the full core set.
  if (!S.library) { const core = RAW().filter((r) => r.core && !r.slots.includes('snack')).map((r) => r.id); const snacks = RAW().filter((r) => r.core && r.slots.includes('snack')).map((r) => r.id); S.library = (cloud.enabled && !isPro() ? core.slice(0, FREE_LIBRARY_LIMIT) : core).concat(snacks); for (const wk of Object.values(S.weeks)) for (const id of Object.keys(wk.portions || {})) if (!S.library.includes(id)) S.library.push(id); }
  for (const wk of Object.values(S.weeks)) wk.snacks ||= {};
  for (const w of Object.values(S.weeks)) { w.days ||= [true, true, true, true, true, true, true]; w.choices ||= {}; w.pantry ||= {}; w.fresh ||= {}; if (!w.grid) relayout(w); }
  if (!S.settings.onboarded && Object.values(S.weeks).some((w) => Object.keys(w.portions).length)) S.settings.onboarded = true;
  save();
}
function lockedCells(w) { const l = {}; (w.grid || []).forEach((d, i) => { for (const s of P.SLOTS) if (P.isOut(d[s]) || P.isTub(d[s])) l[`${i}-${s}`] = d[s]; }); return l; }
function relayout(w = W()) {
  const locked = lockedCells(w);
  let { grid, overflow } = P.autoLayout(w.portions, REC(), w.cookDay, w.days, locked);
  // The week can't hold more than its slots: trim portions to what fits rather than carrying phantom extras.
  if (overflow.length) { w.portions = P.gridCounts(grid); ({ grid, overflow } = P.autoLayout(w.portions, REC(), w.cookDay, w.days, locked)); }
  w.grid = grid; w.overflow = overflow;
  for (const k of Object.keys(w.fresh || {})) { const [d, s] = k.split('-'); if (!P.isRecipeCell(grid[+d]?.[s])) delete w.fresh[k]; }
  save();
}
function portionsFromGrid(w = W()) {
  const counts = {};
  for (const d of w.grid) for (const s of P.SLOTS) if (P.isRecipeCell(d[s])) counts[d[s]] = (counts[d[s]] || 0) + 1;
  w.portions = counts; w.overflow = []; save();
}
function weekLabel(k) { return k === S.thisSun ? 'This week' : k === S.nextSun ? 'Next week' : `Week of ${fmtDate(k)}`; }
function weekSwitch() {
  return `<div class="chip-row week-switch">${[S.thisSun, S.nextSun].map((k, i) => (i === 1 && !isPro()) ? `<button class="chip" data-action="upgrade" data-why="next">🔒 ${weekLabel(k)}</button>` : `<button class="chip ${S.activeWeek === k ? 'on' : ''}" data-action="week" data-week="${k}">${weekLabel(k)} <span class="muted small">${fmtDate(k)}</span></button>`).join('')}</div>`;
}

// ---------- boot ----------
async function boot() {
  try {
    const [i, r] = await Promise.all([fetch('data/ingredients.json').then((x) => x.json()), fetch('data/recipes.json').then((x) => x.json())]);
    DATA.ingredients = i.items; DATA.recipes = r.items; DATA.priceNote = i.checkedNote; DATA.priceDate = (i.items.flatMap((x) => x.packs || []).map((p) => p.checked).sort().pop()) || '';
  } catch (e) {
    document.getElementById('view').innerHTML = `<div class="bad-box">Couldn't load the recipe data. ${esc(e.message)}</div>`;
    return;
  }
  setupWeeks();
  document.getElementById('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.tab; save(); render({ top: true }); } });
  const v = document.getElementById('view');
  v.addEventListener('click', onAction); v.addEventListener('change', onChange); v.addEventListener('input', onInput);
  v.addEventListener('pointerdown', onDragStart);
  v.addEventListener('contextmenu', (e) => { if (e.target.closest('.cell')) e.preventDefault(); });
  render();
  if (!S.settings.onboarded) openIntro();
  onCloudChange(() => { if (S.tab === 'pantry' || S.tab === 'shop') render(); });
  initCloud().then(async () => {
    if (!cloud.user) return;
    const remote = await pullState();
    if (remote && remote.updated_at && (!S.updatedAt || remote.updated_at > S.updatedAt)) {
      const keepTab = S.tab; Object.assign(S, remote.data, { tab: keepTab }); setupWeeks(); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} render(); toast('Synced from your account');
    } else if (!remote) { pushStateSoon(syncable); }
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function render(opts = {}) {
  const view = document.getElementById('view'); const y = view.scrollTop;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  document.getElementById('view').innerHTML = ({ plan: renderPlan, cook: renderCook, shop: renderShop, recipes: renderRecipes, pantry: renderPantry })[S.tab]();
  view.scrollTop = opts.top ? 0 : y;
}

// ----- Plan -----
const AVOID = {
  fish: { label: 'Fish & tuna', ids: ['tuna', 'salmon', 'prawns'] }, pork: { label: 'Pork', ids: ['pork_mince_5', 'nduja'] }, beef: { label: 'Beef', ids: ['beef_mince_5'] },
  thigh: { label: 'Chicken thighs', ids: ['chicken_thigh'] }, eggs: { label: 'Eggs', ids: ['egg'] }, dairy: { label: 'Dairy', ids: ['cheddar', 'skyr', 'cottage_cheese', 'milk', 'butter', 'parmesan'] },
  spicy: { label: 'Spicy food', ids: ['sriracha', 'chilli_powder', 'curry_paste'] }, nuts: { label: 'Peanuts', ids: ['peanut_butter'] }, coconut: { label: 'Coconut', ids: ['coconut_milk'] },
};
function avoidedIds() { return new Set((S.settings.avoid || []).flatMap((k) => AVOID[k]?.ids || [])); }
function isAvoided(r) { const av = avoidedIds(); return av.size > 0 && r.ingredients.some((x) => av.has(x.id)); }
function suggestions(n = 6) { return REC().filter((r) => inLibrary(r.id) && !r.slots.includes('snack') && !isAvoided(r) && r.cookMinutes > 0).map((r) => ({ r, score: metaFor(r).c.cost ? metaFor(r).pp / metaFor(r).c.cost : 0 })).sort((a, b) => b.score - a.score).slice(0, n).map((x) => x.r); }
const META = new Map();
function metaFor(r) { let m = META.get(r.id); if (!m) { const ing = ING(); m = { pp: P.proteinPerPortion(r, ing), kcal: P.kcalPerPortion(r, ing), c: P.costPerPortion(r, ing) }; META.set(r.id, m); } return m; }
function mealMeta(r) {
  const { pp, c } = metaFor(r);
  const cost = c.cost ? `~£${c.cost.toFixed(2)}` : '';
  const flex = '';
  const cold = r.cold ? '<span class="badge ok">cold ok</span>' : '';
  const fz = r.freezer ? '<span class="badge">freezes</span>' : (r.fridgeDays ? `<span class="badge warn">fridge ${r.fridgeDays}d</span>` : '<span class="badge">made fresh</span>');
  return `${pp}g protein${cost ? ` · ${cost} a portion` : ''} ${flex}${cold}${fz}`;
}
function snackExtra(w) {
  const active = w.days.filter(Boolean).length || 1;
  let p = 0, k = 0;
  for (const [id, n] of Object.entries(w.snacks || {})) { const r = recById(id); if (!r || !n) continue; p += metaFor(r).pp * n; k += metaFor(r).kcal * n; }
  return { protein: p / active, kcal: k / active, count: Object.values(w.snacks || {}).reduce((a, b) => a + b, 0) };
}
// Everything to buy/cook this week: grid portions plus snack counts.
function weekCounts(w, opts) { const c = P.gridCounts(w.grid, opts); for (const [id, n] of Object.entries(w.snacks || {})) if (n > 0 && recById(id)) c[id] = (c[id] || 0) + n; return c; }
// Cells to make fresh: per-cell flags plus any recipe the user has set to "always fresh".
function freshMap(w) {
  const m = { ...(w.fresh || {}) };
  (w.grid || []).forEach((d, i) => { for (const sl of P.SLOTS) { const v = d[sl]; if (P.isRecipeCell(v) && S.freshDefault?.[v]) m[`${i}-${sl}`] = true; } });
  return m;
}
function snackBar(w) {
  const items = Object.entries(w.snacks || {}).filter(([id, n]) => n > 0 && recById(id));
  const active = w.days.filter(Boolean).length || 1;
  if (!items.length) return `<div class="snackbar empty"><span>Snacks this week: none yet.</span> <span class="muted">Pick some under the meal list and they'll show here.</span></div>`;
  const total = items.reduce((a, [, n]) => a + n, 0);
  const ex = snackExtra(w);
  return `<div class="snackbar"><div class="row"><b class="grow">Snacks this week</b><span class="small muted">${total} total · about ${Math.round((total / active) * 10) / 10} a day · +${Math.round(ex.protein)}g protein</span></div><div class="chip-row" style="margin:6px 0 0">${items.map(([id, n]) => `<span class="chip meal" style="${cellStyle(id)}">${esc(shortName(recById(id)))} × ${n}</span>`).join('')}</div></div>`;
}
function planTop(w) {
  const recipes = REC(), ing = ING();
  const st = P.gridStats(w.grid, recipes, ing, snackExtra(w), w.days);
  const target = S.settings.proteinTarget;
  const max = Math.max(target * 1.2, ...st.perDay);
  const bars = st.perDay.map((p) => `<div class="bar ${p < target ? 'low' : ''}"><b>${p}</b><i style="height:${Math.round((p / max) * 100)}%"></i></div>`).join('');
  const chosen = Object.keys(w.portions).filter((id) => w.portions[id] > 0);
  const overflow = (w.overflow || []).map((o) => `<div class="warn-box">${esc(recById(o.id)?.name)}: ${o.unplaced} portion${o.unplaced > 1 ? 's' : ''} won't fit in the week. Drop the count or move something.</div>`).join('');
  const cell = (v, i, s) => {
    if (!w.days[i]) return `<div class="cell off"></div>`;
    if (!v) return `<button class="cell empty" data-action="cell" data-day="${i}" data-slot="${s}">+</button>`;
    if (P.isOut(v)) return `<button class="cell out" data-action="cell" data-day="${i}" data-slot="${s}"><span class="cname">Out</span><span class="cmeta shortn">🍽</span><span class="cmark full">eating out</span></button>`;
    if (P.isTub(v)) { const r = recById(P.tubRecipe(v)); return `<button class="cell tubcell" style="${cellStyle(P.tubRecipe(v))}" data-action="cell" data-day="${i}" data-slot="${s}"><span class="cname"><span class="full">${esc(r?.name || '')}</span><span class="shortn">${esc(shortName(r))}</span></span><span class="cmeta"><span class="full">${r ? metaFor(r).pp : 0}g · freezer tub</span><span class="shortn">${r ? metaFor(r).pp : 0}g 🧊</span></span><span class="cmark full">from the freezer</span></button>`; }
    const r = recById(v); if (!r) return `<button class="cell empty" data-action="cell" data-day="${i}" data-slot="${s}">+</button>`;
    const fm = freshMap(w); const isFresh = !!fm[`${i}-${s}`];
    const tp = P.tubPlan(r, w.grid, w.cookDay, fm);
    const cls = isFresh || tp.fresh ? 'freshcell' : tp.freezer.includes(i) ? 'frozen' : tp.late.includes(i) ? 'late' : '';
    const mark = isFresh ? 'make fresh' : cls === 'frozen' ? '❄ freezer' : cls === 'late' ? '⚠ fridge' : tp.fresh ? 'fresh' : 'fridge';
    const markShort = isFresh ? '🍳' : cls === 'frozen' ? '❄' : cls === 'late' ? '⚠' : '';
    return `<button class="cell ${cls}" style="${cellStyle(v)}" data-action="cell" data-day="${i}" data-slot="${s}" draggable="false"><span class="cname"><span class="full">${esc(r.name)}</span><span class="shortn">${esc(shortName(r))}</span></span><span class="cmeta"><span class="full">${metaFor(r).pp}g protein</span><span class="shortn">${metaFor(r).pp}g ${markShort}</span></span><span class="cmark full">${mark}</span></button>`;
  };
  const gridHtml = `<div class="grid"><div></div>${P.DAYS.map((d, i) => `<div class="hd ${w.days[i] ? '' : 'off'}"><span>${d}</span><button class="dayx" data-action="dayx" data-day="${i}" title="${w.days[i] ? 'Skip this day' : 'Put this day back'}">${w.days[i] ? '×' : '+'}</button></div>`).join('')}
    ${P.SLOTS.map((s) => `<div class="lbl">${({ breakfast: 'Bfast', lunch: 'Lunch', dinner: 'Dinner' })[s]}</div>` + w.grid.map((d, i) => cell(d[s], i, s)).join('')).join('')}</div>`;
  const tubs = Object.entries(S.tubs).filter(([, n]) => n > 0);
  const tubHtml = tubs.length ? `<p class="small" style="margin-top:8px"><b>In the freezer:</b> ${tubs.map(([id, n]) => `${esc(shortName(recById(id)))} ×${n}`).join(', ')}. Tap an empty cell to use one; it costs nothing to buy or cook.</p>` : '';
  const summary = chosen.length
    ? `<div class="chip-row">${chosen.map((id) => `<span class="chip meal" style="${cellStyle(id)}">${esc(shortName(recById(id)))} × ${w.portions[id]}</span>`).join('')}</div>`
    : `<p class="muted">Nothing picked yet. Tick meals below and they land in the grid.</p>`;
  const hasGrid = chosen.length || tubs.length || Object.keys(lockedCells(w)).length;
  return `<div class="card"><h3>${weekLabel(S.activeWeek)} <span class="muted small">from Sun ${fmtDate(S.activeWeek)}</span></h3>${summary}${tubHtml}
    <div class="stat-grid" style="margin-top:10px"><div class="stat"><b>${st.filled}<span>/${st.slots}</span></b><span>meal slots filled</span></div><div class="stat"><b>${st.distinct}</b><span>different meals</span></div><div class="stat"><b>${st.avg}g</b><span>avg protein/day</span></div></div>
    <p class="small muted" style="margin-top:8px">About <b>${st.avgKcal.toLocaleString()} kcal</b> a day from meals and snacks, against a target of ${(S.settings.kcalTarget || 0).toLocaleString()}. Meals are sized at <b>${weekFactor(w)}×</b> to get there${weekFactor(w) >= 1.6 ? ' (that is the biggest they go; add snacks for the rest)' : weekFactor(w) <= 0.6 ? ' (that is the smallest they go; drop a snack or a meal)' : ''}. Targets live in Pantry → Settings.</p>
    <div class="bars" style="margin-top:26px">${bars}</div><div class="bars-labels">${P.DAYS.map((d) => `<div>${d}</div>`).join('')}</div>
    <p class="small muted">Target ${target}g a day, snacks included (${Math.round(snackExtra(w).protein)}g a day from snacks). Amber days are under.</p></div>
  ${hasGrid ? `<div class="card">${gridHtml}
    <p class="small muted" style="margin-top:10px">Press and hold a meal to pick it up, then tap where it goes (two meals swap). Tap a cell to change it, mark it "eating out", make it fresh that day, or use a freezer tub. ❄ from the freezer that day, thaw the night before. ⚠ past its fridge life and can't be frozen.</p>
    ${snackBar(w)}
    <p class="small muted" style="margin:8px 0 2px">Cook day</p>
    <div class="day-pick">${P.DAYS.map((d, i) => `<button data-action="cookday" data-day="${i}" class="${w.cookDay === i ? 'on' : ''}">${d}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px"><button class="btn ghost small" data-action="relayout">Re-lay out</button><button class="btn ghost small" data-action="clear-week">Clear week</button></div></div>` : ''}
  ${overflow}${lateWarnings(w)}`;
}
function pickRow(r, w, free) {
  const n = w.portions[r.id] || 0;
  const full = P.roomFor(r, free) <= 0;
  return `<div class="recipe-row pick ${n ? 'on' : ''} ${full && !n ? 'full' : ''}" data-row="${r.id}"><input type="checkbox" class="tick" data-pick="${r.id}" ${n ? 'checked' : ''} ${full && !n ? 'disabled' : ''} aria-label="Include ${esc(r.name)}"><div class="grow"><div class="name">${esc(r.name)}</div><div class="meta">${mealMeta(r)}${full && !n ? ' <span class="badge">week full</span>' : ''}</div></div>
      ${n ? `<div class="stepper"><button data-action="dec" data-id="${r.id}">−</button><b>${n}</b><button data-action="inc" data-id="${r.id}" ${full ? 'disabled' : ''}>+</button></div>` : ''}</div>`;
}
function snackRow(r, w) { const n = w.snacks[r.id] || 0; return `<div class="recipe-row pick ${n ? 'on' : ''}" data-row="${r.id}"><input type="checkbox" class="tick" data-snack-pick="${r.id}" ${n ? 'checked' : ''} aria-label="Include ${esc(r.name)}"><div class="grow"><div class="name">${esc(r.name)}</div><div class="meta">${mealMeta(r)}</div></div>${n ? `<div class="stepper"><button data-action="sdec" data-id="${r.id}">−</button><b>${n}</b><button data-action="sinc" data-id="${r.id}">+</button></div>` : ''}</div>`; }
function renderPlan() {
  const w = W(); const recipes = REC();
  const q = (S.planSearch || '').toLowerCase();
  const free = P.freeSlots(w.grid, w.days);
  const mine = recipes.filter((r) => inLibrary(r.id) && !r.slots.includes('snack'));
  const visible = mine.filter((r) => !isAvoided(r));
  const hidden = mine.length - visible.length;
  const snacks = recipes.filter((r) => r.slots.includes('snack') && inLibrary(r.id) && !isAvoided(r) && (!q || r.name.toLowerCase().includes(q)));
  const snackHtml = snacks.length ? `<h2>Snacks <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:600">· how many this week</span></h2><div class="card">${snacks.map((r) => snackRow(r, w)).join('')}</div>` : '';
  const group = (slot, title) => {
    const list = visible.filter((r) => (slot === 'breakfast' ? r.slots[0] === 'breakfast' : r.slots[0] !== 'breakfast') && (!q || r.name.toLowerCase().includes(q)));
    return list.length ? `<h2>${title}</h2><div class="card">${list.map((r) => pickRow(r, w, free)).join('')}</div>` : '';
  };
  const sug = !Object.keys(w.portions).length ? suggestions(6) : [];
  const sugHtml = sug.length ? `<div class="card"><h3>Best value for your goal</h3><p class="small muted">Most protein per pound, skipping anything you've said you don't eat.</p><div class="chip-row">${sug.map((r) => `<button class="chip" data-action="quick-pick" data-id="${r.id}">+ ${esc(shortName(r))} · ${metaFor(r).pp}g · £${metaFor(r).c.cost.toFixed(2)}</button>`).join('')}</div></div>` : '';
  return `<h1>Plan</h1>${weekSwitch()}<div id="plan-top">${planTop(w)}</div>
  <h2 style="margin-top:26px">Pick meals</h2>
  <input class="search" placeholder="Search meals" value="${esc(S.planSearch || '')}" data-plan-search>
  ${sugHtml}
  <div id="plan-pick">${group('breakfast', 'Breakfasts')}${group('mains', 'Mains (lunch or dinner)')}
  ${snackHtml}
  ${hidden ? `<p class="small muted">${hidden} recipe${hidden > 1 ? 's' : ''} hidden because of what you don't eat (Pantry → Settings).</p>` : ''}
  <p class="small muted">Missing something? Recipes → <b>Find more meal ideas</b>.</p></div>`;
}
// Re-draw only what changed on the Plan tab: the top card/grid and the state of each pick row.
function refreshPlan() {
  const top = document.getElementById('plan-top'); const w = W();
  if (!top || S.tab !== 'plan') { render(); return; }
  top.innerHTML = planTop(w);
  const free = P.freeSlots(w.grid, w.days);
  document.querySelectorAll('.recipe-row.pick').forEach((rowEl) => { const r = recById(rowEl.dataset.row); if (!r) return; const tmp = document.createElement('div'); tmp.innerHTML = r.slots.includes('snack') ? snackRow(r, w) : pickRow(r, w, free); const fresh = tmp.firstElementChild; if (fresh.outerHTML !== rowEl.outerHTML) rowEl.replaceWith(fresh); });
}
function shortName(r) { if (!r) return ''; if (r.short) return r.short; const w = r.name.split(' '); let out = w[0]; if (w[1] && (out + ' ' + w[1]).length <= 11) out += ' ' + w[1]; return out; }
function lateWarnings(w) {
  const out = [];
  for (const [rid, n] of Object.entries(w.portions)) {
    const r = recById(rid); if (!r || !n || r.cookMinutes === 0) continue;
    const tp = P.tubPlan(r, w.grid, w.cookDay, freshMap(w));
    if (tp.late.length) out.push(`<div class="warn-box"><b>${esc(r.name)}</b> keeps ${r.fridgeDays} day${r.fridgeDays === 1 ? '' : 's'} and can't be frozen, so the ${tp.late.map((d) => P.DAYS[d]).join(', ')} portion${tp.late.length > 1 ? 's need' : ' needs'} a second cook midweek. Move ${tp.late.length > 1 ? 'them' : 'it'} earlier or swap for a freezer recipe.</div>`);
  }
  return out.join('');
}
function defaultPortions(r) { return r.slots[0] === 'breakfast' ? 4 : 3; }

// ----- Cook -----
function renderCook() {
  const w = W(); const recipes = REC(), ing = ING();
  const all = weekCounts(w);
  const fm = freshMap(w);
  const counts = weekCounts(w, { fresh: fm, skipFresh: true });
  const rs = P.runSheet(counts, recipes);
  const fresh = Object.entries(all).filter(([rid, n]) => n > 0 && recById(rid)?.cookMinutes === 0).map(([rid, n]) => ({ recipe: recById(rid), portions: n }));
  for (const c of P.freshCells(w.grid, fm)) { const r = recById(c.id); if (r) fresh.push({ recipe: r, portions: 1, day: P.DAYS[c.day] }); }
  const head = `<h1>Cook</h1>${weekSwitch()}`;
  if (!rs.list.length && !fresh.length) return `${head}<div class="card"><p>Nothing picked for ${weekLabel(S.activeWeek).toLowerCase()} yet. Tick meals on the Plan tab.</p></div>`;
  const cookDay = P.DAYS[w.cookDay];
  const sheet = rs.list.map((x) => `<li><b>${esc(x.recipe.name)}</b> × ${x.portions} <span class="muted small">· ${x.recipe.cookMinutes} min · ${x.recipe.equipment.join(', ')}</span></li>`).join('');
  const grouped = {};
  for (const x of fresh) { const g = (grouped[x.recipe.id] ||= { recipe: x.recipe, portions: 0, days: [] }); g.portions += x.portions; if (x.day && !g.days.includes(x.day)) g.days.push(x.day); }
  const freshList = Object.values(grouped).map((g) => `<li><div class="row"><span class="grow"><b>${esc(g.recipe.name)}</b> × ${g.portions} <span class="muted small">· ${g.days.length ? `make fresh on ${g.days.join(', ')}` : `made fresh, ${g.recipe.slots[0]}`}${g.recipe.cookMinutes ? ` · ${g.recipe.cookMinutes} min` : ''}</span></span>${g.recipe.cookMinutes > 0 && S.freshDefault[g.recipe.id] ? `<button class="btn ghost small" data-action="fresh-default" data-id="${g.recipe.id}" data-on="0">Batch it instead</button>` : ''}</div>
    ${g.recipe.cookMinutes > 0 ? `<p class="small muted" style="margin:4px 0 0">Per portion: ${P.scaleIngredients(g.recipe, 1, ing).map((i) => `${esc(i.name)} ${P.fmtQty(i.qty, i.unit)}`).join(', ')}.</p>` : ''}</li>`).join('');
  const cards = rs.list.map(({ recipe: r, portions: n }) => {
    const scaled = P.scaleIngredients(r, n, ing);
    const tp = P.tubPlan(r, w.grid, w.cookDay, fm);
    const reheat = { none: 'Eat cold', microwave: 'Microwave 2–3 min, stir halfway', hob: 'Reheat in a pan', 'air-fryer': 'Air-fryer 6 min at 180°C' }[r.reheat] || '';
    return `<div class="card"><h3>${esc(r.name)} <span class="muted">× ${n}</span></h3>
      <p class="small muted">${P.proteinPerPortion(r, ing)}g protein a portion · ${r.cookMinutes} min · ${r.equipment.join(', ')}</p>
      <div class="seg"><button class="on">Batch on ${cookDay}</button><button data-action="fresh-default" data-id="${r.id}" data-on="1">Make fresh each time</button></div>
      <div class="ing-list">${scaled.map((s) => `<span>${esc(s.name)}</span><b>${P.fmtQty(s.qty, s.unit)}</b>`).join('')}</div>
      <ol class="steps">${r.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
      ${r.notes ? `<p class="small muted">${esc(r.notes)}</p>` : ''}
      <div class="tub"><div><b>${tp.total}</b><span>tubs</span></div><div><b>${tp.fridge.length}</b><span>fridge${tp.fridge.length ? `<br>eat by ${tp.eatBy}` : ''}</span></div><div><b>${tp.freezer.length}</b><span>freezer${tp.freezer.length ? '<br>thaw night before' : ''}</span></div></div>
      <p class="small" style="margin-top:8px">${tp.fridge.length ? `Fridge tubs for ${tp.fridge.map((d) => P.DAYS[d]).join(', ')}. ` : ''}${tp.freezer.length ? `Freezer tubs for ${tp.freezer.map((d) => P.DAYS[d]).join(', ')}. ` : ''}${reheat}.</p>
      ${tp.late.length ? `<div class="warn-box">${tp.late.map((d) => P.DAYS[d]).join(', ')}: past fridge life and not freezable. Cook ${tp.late.length} portion${tp.late.length > 1 ? 's' : ''} fresh that week, or move ${tp.late.length > 1 ? 'them' : 'it'} earlier on the Plan tab.</div>` : ''}
      ${tp.total < n ? `<p class="small muted">${n - tp.total} portion${n - tp.total > 1 ? 's' : ''} not on the grid.</p>` : ''}
    </div>`;
  }).join('');
  return `${head}
  <div class="card"><h3>Run sheet for ${cookDay}</h3><p class="small muted">Longest cook first. Start the oven or air-fryer items, then run the hob ones alongside. About ${rs.minutes} minutes if done back to back; less when they overlap.</p><ol class="steps">${sheet}</ol>
  ${fresh.length ? `<hr><p class="small muted">Made on the day, not batched. Anything with an air-fryer and 20 minutes can live here.</p><ul class="clean">${freshList}</ul>` : ''}
  <p class="small muted" style="margin-top:8px">Rice rule: cooked rice goes in the freezer the same day unless it's eaten within 24 hours.</p></div>
  ${cards}`;
}

// ----- Shop -----
// What the week needs to buy, after the pantry: shared by the Shop tab and the settings preview.
function shopNeeds(w, recipes) {
  const counts = weekCounts(w);
  const resolve = resolveFor(w);
  const rawNeeds = P.aggregateNeeds(counts, recipes);
  const needsAll = P.aggregateNeeds(counts, recipes, resolve);
  // pantry keys may be the generic id (e.g. frozen_fruit) or the resolved one
  const pantryFor = {}; for (const id of Object.keys(needsAll)) { const generic = Object.keys(rawNeeds).find((g) => resolve(g) === id); pantryFor[id] = w.pantry[id] !== undefined ? w.pantry[id] : (generic ? w.pantry[generic] : undefined); }
  return { counts, resolve, rawNeeds, needsAll, pantryFor, needs: P.netPantry(needsAll, pantryFor) };
}
function renderShop() {
  const w = W(); const ing = ING(), recipes = REC();
  const { counts, resolve, rawNeeds, needsAll, pantryFor, needs } = shopNeeds(w, recipes);
  const usedBy = {};
  for (const [rid, n] of Object.entries(counts)) { const r = recById(rid); if (!r) continue; for (const x of r.ingredients) (usedBy[resolve(x.id)] ||= []).push(`${r.short || r.name} ×${n}`); }
  const choiceHtml = Object.keys(rawNeeds).map(ingById).filter((it) => it?.choices?.length).map((it) => `<label class="field">${esc(it.name)}<select data-choice="${it.id}">${it.choices.map((c) => `<option value="${c}" ${resolve(it.id) === c ? 'selected' : ''}>${esc(ingById(c)?.name || c)}</option>`).join('')}</select></label>`).join('');
  const fullWeek = P.compareShops(needsAll, ing)[0];
  const head = `<h1>Shop</h1>${weekSwitch()}`;
  if (!Object.keys(needsAll).length) return `${head}<div class="card"><p>Nothing picked for ${weekLabel(S.activeWeek).toLowerCase()} yet. Tick meals on the Plan tab.</p></div>`;
  // Rank: items a shop doesn't sell are not the app's fault and you'd buy them elsewhere, so only
  // genuinely unpriced items make a shop "not comparable". Then cheapest total wins.
  const ranked = P.compareShops(needs, ing).map((b) => {
    const notSold = b.missing.filter((m) => (ingById(m.id)?.unavailable || []).includes(b.shop));
    const unpriced = b.missing.filter((m) => !(ingById(m.id)?.unavailable || []).includes(b.shop));
    return { ...b, notSold, unpriced };
  }).sort((a, b) => (a.unpriced.length - b.unpriced.length) || (a.total - b.total));
  const byShop = Object.fromEntries(ranked.map((b) => [b.shop, b]));
  const split = P.cheapestSplit(needs, ing);
  const best = ranked[0];
  const budget = S.settings.budget;
  const pct = Math.min(100, Math.round((best.total / budget) * 100));
  // per-shop totals table
  const shown = isPro() ? ranked : ranked.slice(0, 1);
  const totals = `<table class="tbl"><thead><tr><th>Shop</th><th class="r">Total</th><th class="r">Priced</th><th class="r">Not sold</th><th class="r">Unpriced</th></tr></thead><tbody>${shown.map((b) => `<tr class="${b === best ? 'best' : ''}"><td>${P.SHOP_NAMES[b.shop]}${b === best ? ' <span class="badge ok">cheapest</span>' : ''}</td><td class="r"><b>${P.gbp(b.total)}</b></td><td class="r">${b.lines.length}</td><td class="r">${b.notSold.length ? `<span class="badge">${b.notSold.length}</span>` : '0'}</td><td class="r">${b.unpriced.length ? `<span class="badge warn">${b.unpriced.length} · not comparable</span>` : '0'}</td></tr>`).join('')}</tbody></table>
    ${isPro() ? '' : `<p class="small"><button class="btn small" data-action="upgrade" data-why="shops">🔒 Compare all five shops</button> <span class="muted">Free shows the cheapest one.</span></p>`}
    <p class="small muted">Every price is read from that supermarket's own website (Tesco, ASDA, Sainsbury's and Aldi). "Not sold" means the shop doesn't stock it, so you'd get it elsewhere or already have it; the total leaves it out. "Unpriced" means no price exists online: Lidl publishes none for its everyday range, so Lidl stays blank until a shelf label is added.</p>`;
  // per-item comparison
  const ids = Object.keys(needs).filter((id) => ingById(id));
  const cheapestFor = (id) => { let m = null; for (const s of P.SHOPS) { const l = byShop[s].lines.find((x) => x.id === id); if (l && (m === null || l.cost < m)) m = l.cost; } return m; };
  const items = `<div class="scroll-x"><table class="tbl cmp"><thead><tr><th>Item</th>${P.SHOPS.map((s) => `<th class="r">${P.SHOP_NAMES[s].replace("Sainsbury's", 'Sains.')}</th>`).join('')}</tr></thead><tbody>${ids.map((id) => {
    const it = ingById(id); const min = cheapestFor(id);
    return `<tr><td>${esc(it.name)}<span class="sub">${P.fmtQty(P.round1(needs[id]), it.unit)}</span></td>${P.SHOPS.map((s) => { const l = byShop[s].lines.find((x) => x.id === id); return `<td class="r ${l && l.cost === min ? 'min' : ''}">${l ? P.gbp(l.cost) : '<span class="muted">—</span>'}</td>`; }).join('')}</tr>`;
  }).join('')}</tbody></table></div>`;
  const shopCard = (b, open) => {
    const lines = b.lines.map((l) => {
      const k = `${b.shop}:${l.id}`; const done = !!w.ticks[k];
      return `<label class="line ${done ? 'done' : ''}"><input type="checkbox" data-tick="${k}" ${done ? 'checked' : ''}><span class="grow"><span class="name">${l.n > 1 ? `${l.n} × ` : ''}${esc(l.pack.name)}</span><span class="sub">${esc((usedBy[l.id] || []).join(', '))}</span></span><span class="cost">${P.gbp(l.cost)}</span></label>`;
    }).join('');
    const notSold = b.missing.filter((m) => (ingById(m.id)?.unavailable || []).includes(b.shop)).map((m) => esc(m.name));
    const unpriced = b.missing.filter((m) => !(ingById(m.id)?.unavailable || []).includes(b.shop)).map((m) => esc(m.name));
    const missing = (notSold.length ? `<div class="warn-box">Not sold at ${P.SHOP_NAMES[b.shop]}: ${notSold.join(', ')}.</div>` : '') + (unpriced.length ? `<div class="warn-box">No ${P.SHOP_NAMES[b.shop]} price on file for: ${unpriced.join(', ')}. ${b.shop === 'lidl' ? 'Lidl publishes no prices online; a shelf photo fixes this.' : b.shop === 'aldi' ? "Aldi's site lists nothing; the Aldi prices here come from Tesco and Sainsbury's price-match labels." : 'Tell Claude and it gets added.'}</div>` : '');
    return `<details class="shop-card ${b === best ? 'best' : ''}" ${open ? 'open' : ''}><summary><span><b>${P.SHOP_NAMES[b.shop]}</b>${b === best ? ' <span class="badge ok">cheapest</span>' : ''}${b.missing.length ? ` <span class="badge warn">${b.missing.length} unpriced</span>` : ''}</span><span class="total">${P.gbp(b.total)}</span></summary>${missing}<div>${lines}</div></details>`;
  };
  const splitHtml = split ? `<div class="card"><h3>Two shops saves ${P.gbp(split.saving)}</h3><p class="small muted">${P.SHOP_NAMES[split.shops[0]]} + ${P.SHOP_NAMES[split.shops[1]]} = ${P.gbp(split.total)} against ${P.gbp(best.total)} at ${P.SHOP_NAMES[best.shop]}. Only worth it if you're passing both.</p>
    ${split.baskets.map((b) => `<p class="small"><b>${P.SHOP_NAMES[b.shop]}</b> ${P.gbp(b.total)}: ${b.lines.map((l) => esc(l.name)).join(', ')}</p>`).join('')}</div>` : '';
  const unpricedAll = ids.filter((id) => !(ingById(id)?.packs || []).length).map((id) => ingById(id)?.name);
  const haveRows = Object.keys(needsAll).filter((id) => pantryFor[id] !== undefined).map((id) => { const it = ingById(id); const v = pantryFor[id]; return `<div class="line"><span class="grow"><span class="name">${esc(it?.name || id)}</span><span class="sub">${v === true ? 'plenty in' : `${P.fmtQty(v, it.unit)} in, need ${P.fmtQty(P.round1(needsAll[id]), it.unit)}`} · ${esc((usedBy[id] || []).join(', '))}</span></span><button class="btn ghost small" data-action="need" data-id="${id}">Need it</button></div>`; }).join('');
  const oldest = ranked.map((b) => b.oldest).filter(Boolean).sort()[0];
  return `${head}
  ${choiceHtml ? `<div class="card">${choiceHtml}</div>` : ''}
  <div class="card"><div class="row"><span class="grow"><b style="font-size:22px">${P.gbp(best.total)}</b> at ${P.SHOP_NAMES[best.shop]}</span><span class="muted small">budget ${P.gbp(budget)}</span></div>
    <div class="budget ${best.total > budget ? 'over' : ''}"><i style="width:${pct}%"></i></div>
    ${haveRows ? `<p class="small"><b>${Object.keys(needsAll).filter((id) => pantryFor[id] !== undefined).length} ingredients are left off because they're ticked in Pantry</b> (see the bottom of this page). A new week starts with nothing ticked.</p>` : ''}
    <p class="small muted">${best.total > budget ? `Over budget by ${P.gbp(best.total - budget)}. Drop a portion or two of the priciest meal.` : `${P.gbp(budget - best.total)} left for coffees.`} Prices checked ${oldest || 'n/a'}.</p></div>
  <h2>Price by shop</h2><div class="card">${totals}</div>
  <h2>Item by item</h2><div class="card">${items}<p class="small muted">Green is the cheapest for that item. Swipe sideways for more shops.</p></div>
  ${splitHtml}
  <h2>Tick-off list</h2><div class="shop-rank">${ranked.map((b, i) => shopCard(b, i === 0)).join('')}</div>
  ${unpricedAll.length ? `<div class="card" style="margin-top:10px"><h3>No price anywhere yet</h3><p class="small muted">${unpricedAll.map(esc).join(', ')}. Left out of the totals until priced.</p></div>` : ''}
  ${haveRows ? `<h2>Already in your pantry</h2><div class="card"><p class="small muted">Left off the list because it's ticked in Pantry. Tap "Need it" to put it back on. Buying everything would be ${P.gbp(fullWeek.total)} at ${P.SHOP_NAMES[fullWeek.shop]}.</p>${haveRows}</div>` : ''}
  <p class="small muted">${esc(DATA.priceNote || '')}</p>`;
}

// ----- Recipes -----
const TAGS = [['budget', 'Cheap (under £1.50)'], ['high-protein', '50g+ protein'], ['cold-lunch', 'Cold lunch'], ['quick', '25 min or less'], ['breakfast', 'Breakfast'], ['snack', 'Snacks'], ['curry', 'Curry'], ['pasta', 'Pasta'], ['mexican', 'Mexican'], ['asian', 'Asian'], ['british', 'Plain & simple'], ['veggie', 'Meat-free']];
function tagsOf(r) {
  const m = metaFor(r); const t = new Set(r.tags || []);
  if (m.c.cost && m.c.cost <= 1.5) t.add('budget'); if (m.pp >= 50) t.add('high-protein'); if (r.cookMinutes <= 25) t.add('quick'); if (r.cold) t.add('cold-lunch'); if (r.slots.includes('snack')) t.add('snack'); if (r.slots[0] === 'breakfast') t.add('breakfast');
  return t;
}
function recipeRow(r, action) {
  return `<div class="recipe-row" data-action="open-recipe" data-id="${r.id}"><div class="grow"><div class="name">${esc(r.name)}</div><div class="meta">${mealMeta(r)}${S.customRecipes.some((c) => c.id === r.id) ? ' <span class="badge">yours</span>' : ''}</div></div>${action || '<span class="muted">›</span>'}</div>`;
}
function renderRecipes() {
  const q = (S.search || '').toLowerCase();
  const all = REC();
  const mine = all.filter((r) => inLibrary(r.id) && (!q || r.name.toLowerCase().includes(q)));
  const list = mine.map((r) => recipeRow(r)).join('');
  const inbox = (S.inbox || []);
  const inboxHtml = inbox.length ? `<div class="card"><h3>Waiting for Claude <span class="badge warn">${inbox.length}</span></h3>
    <ul class="clean">${inbox.map((x, i) => `<li class="row"><span class="grow small" style="word-break:break-all">${esc(x.url)}${x.note ? `<span class="sub muted">${esc(x.note)}</span>` : ''}</span><button class="btn ghost small" data-action="inbox-rm" data-i="${i}">×</button></li>`).join('')}</ul>
    <button class="btn block" data-action="inbox-copy" style="margin-top:10px">Copy the list for Claude</button>
    <p class="small muted">Paste it into a Claude chat. The recipes get priced, added here and pushed to your phone.</p></div>` : '';
  const tag = S.ideaTag || '';
  const ideas = all.filter((r) => !inLibrary(r.id) && !isAvoided(r) && (!tag || tagsOf(r).has(tag)) && (!q || r.name.toLowerCase().includes(q)));
  const ideasCount = all.filter((r) => !inLibrary(r.id) && !isAvoided(r)).length;
  const ideasHtml = S.ideasOpen ? `<div class="card" id="ideas"><h3>Meal ideas <span class="muted small">${ideasCount} not in your list</span></h3>
    <div class="chip-row"><button class="chip ${!tag ? 'on' : ''}" data-action="idea-tag" data-tag="">All</button>${TAGS.map(([k, l]) => `<button class="chip ${tag === k ? 'on' : ''}" data-action="idea-tag" data-tag="${k}">${l}</button>`).join('')}</div>
    ${ideas.length ? ideas.map((r) => recipeRow(r, `<button class="btn small" data-action="lib-add" data-id="${r.id}">+ Add</button>`)).join('') : '<p class="muted">Nothing left to add here. Try another filter, or paste a link below.</p>'}</div>` : '';
  return `<h1>Recipes</h1>
  <button class="btn block ${S.ideasOpen ? 'ghost' : ''}" data-action="ideas-toggle" style="margin-bottom:10px">${S.ideasOpen ? 'Hide meal ideas' : `✨ Find more meal ideas (${ideasCount})`}</button>
  ${ideasHtml}
  <div class="row" style="margin-bottom:12px"><button class="btn ghost grow" data-action="add-link">+ From an Instagram link</button><button class="btn ghost" data-action="add-recipe">Type one in</button></div>
  ${inboxHtml}
  <input class="search" placeholder="Search ${mine.length} of your recipes" value="${esc(S.search || '')}" data-search>
  <h2>My recipes</h2><div class="card">${list || '<p class="muted">Nothing here yet. Add some from the ideas above.</p>'}</div>`;
}
function linkForm() {
  return `<h3>Add from a link</h3><p class="small muted">Instagram only opens for a logged-in browser, so the app can't read the reel itself. Paste the link here; Claude turns it into a priced recipe and pushes it to the app.</p>
  <form id="link-form"><label class="field">Reel or recipe link<input name="url" type="url" required placeholder="https://www.instagram.com/reel/…"></label>
  <label class="field">Anything to change? (optional)<input name="note" placeholder="e.g. swap thighs for breast, no coriander"></label>
  <button class="btn block" type="submit">Save to the list</button></form>`;
}
function recipeDetail(r) {
  const ing = ING();
  const custom = S.customRecipes.some((c) => c.id === r.id);
  const c = P.costPerPortion(r, ing);
  const ings = P.scaleIngredients(r, 1, ing).map((s) => `<span>${esc(s.name)}</span><b>${P.fmtQty(s.qty, s.unit)}</b>`).join('');
  const lib = inLibrary(r.id);
  return `<h3>${esc(r.name)}</h3><p class="small muted">${P.proteinPerPortion(r, ing)}g protein · ${P.kcalPerPortion(r, ing)} kcal · ~£${c.cost.toFixed(2)} a portion${c.unpriced.length ? ` (excl. ${c.unpriced.join(', ')})` : ''} · ${r.slots.join(' or ')} · ${r.cookMinutes ? r.cookMinutes + ' min' : 'no batch cook'} · ${r.cold ? 'cold ok' : 'eat hot'} · ${r.freezer ? 'freezes' : r.fridgeDays ? `fridge ${r.fridgeDays} days, no freezer` : 'make fresh'}</p>
  <h2>Per portion</h2><div class="ing-list">${ings}</div>
  <h2>Method</h2><ol class="steps">${r.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
  ${r.notes ? `<p class="small muted">${esc(r.notes)}</p>` : ''}
  ${r.source && r.source.startsWith('http') ? `<p class="small"><a href="${esc(r.source)}" target="_blank" rel="noopener">Source reel</a></p>` : ''}
  <div class="row" style="margin-top:12px">${lib ? `<button class="btn grow" data-action="add-portion" data-id="${r.id}">Add to ${weekLabel(S.activeWeek).toLowerCase()}</button><button class="btn ghost" data-action="lib-remove" data-id="${r.id}">Remove from my recipes</button>` : `<button class="btn grow" data-action="lib-add" data-id="${r.id}">+ Add to my recipes</button>`}${custom ? `<button class="btn danger" data-action="delete-recipe" data-id="${r.id}">Delete</button>` : ''}</div>`;
}
function recipeForm() {
  const opts = ING().map((i) => `<option value="${i.id}">${esc(i.name)} (${i.unit})</option>`).join('');
  return `<h3>Add a recipe</h3><form id="recipe-form">
  <label class="field">Name<input name="name" required></label>
  <div class="small muted">Slots</div><div class="chip-row">${P.SLOTS.map((s) => `<label class="chip"><input type="checkbox" name="slot" value="${s}" hidden>${s}</label>`).join('')}</div>
  <div class="row"><label class="field grow">Fridge days<input name="fridgeDays" type="number" min="0" max="7" value="3"></label><label class="field grow">Batch cook minutes<input name="cookMinutes" type="number" min="0" value="30"></label></div>
  <div class="chip-row"><label class="chip"><input type="checkbox" name="cold" hidden>ok cold</label><label class="chip on"><input type="checkbox" name="freezer" hidden checked>freezes</label></div>
  <label class="field">Reheat<select name="reheat"><option value="microwave">Microwave</option><option value="none">Eat cold</option><option value="hob">Hob</option><option value="air-fryer">Air-fryer</option></select></label>
  <div class="small muted" style="margin-top:8px">Ingredients per portion</div><div id="ing-rows"></div>
  <button type="button" class="btn ghost small" data-action="add-ing-row">+ ingredient</button>
  <button type="button" class="btn ghost small" data-action="new-ingredient">+ new ingredient (no price yet)</button>
  <label class="field">Method, one step per line<textarea name="method"></textarea></label>
  <label class="field">Source link (optional)<input name="source"></label>
  <button class="btn block" type="submit" style="margin-top:8px">Save recipe</button></form>
  <template id="ing-row-t"><div class="ing-row"><select name="ing">${opts}</select><input name="qty" type="number" step="any" placeholder="qty" required><button type="button" data-action="rm-row">×</button></div></template>`;
}
function newIngredientForm() {
  return `<h3>New ingredient</h3><form id="ing-form">
  <label class="field">Name<input name="name" required></label>
  <label class="field">Unit<select name="unit"><option value="g">grams</option><option value="ml">ml</option><option value="each">each</option></select></label>
  <label class="field">Protein per 100g/ml (or per each)<input name="protein" type="number" step="any" value="0"></label>
  <label class="field">Category<select name="category"><option>protein</option><option>carb</option><option>veg</option><option>fruit</option><option>dairy</option><option>tin</option><option>sauce</option><option>spice</option><option>cupboard</option></select></label>
  <label class="field">Kept in<select name="store"><option>fridge</option><option>freezer</option><option>cupboard</option></select></label>
  <p class="small muted">It'll show as "no price on file" on the Shop tab until Claude adds a price.</p>
  <button class="btn block" type="submit">Save ingredient</button></form>`;
}

// ----- Pantry -----
// Live preview for Settings: at this calorie target, what portion size results, what the week averages, and what the shop costs.
function macroPreview(kTarget, pTarget) {
  const w = W(); const ing = ING();
  const f = weekFactor(w, kTarget);
  const recipes = RAW().map((r) => (r.slots.includes('snack') ? r : { ...r, ingredients: r.ingredients.map((x) => ({ id: x.id, qty: Math.round(x.qty * f * 100) / 100 })) }));
  const rec = Object.fromEntries(recipes.map((r) => [r.id, r]));
  const active = w.days.filter(Boolean).length || 1;
  let sp = 0, sk = 0;
  for (const [id, n] of Object.entries(w.snacks || {})) { const r = rec[id]; if (r && n) { sp += P.proteinPerPortion(r, ing) * n; sk += P.kcalPerPortion(r, ing) * n; } }
  const st = P.gridStats(w.grid, recipes, ing, { protein: sp / active, kcal: sk / active }, w.days);
  const empty = !st.filled && !Object.keys(w.snacks || {}).length;
  let shop = null;
  if (!empty) { const { needs } = shopNeeds(w, recipes); const ranked = P.compareShops(needs, ing).filter((b) => !b.missing.some((m) => !(ingById(m.id)?.unavailable || []).includes(b.shop))); shop = ranked.sort((a, b) => a.total - b.total)[0] || null; }
  const pPct = Math.min(100, Math.round((st.avg / (pTarget || 1)) * 100));
  const kPct = Math.min(100, Math.round((st.avgKcal / (kTarget || 1)) * 100));
  const gapP = Math.round(pTarget - st.avg), gapK = Math.round(kTarget - st.avgKcal);
  const budget = S.settings.budget || 0;
  const capped = f >= 1.6 ? 'Meals are at their biggest (1.6×); the rest has to come from snacks.' : f <= 0.6 ? 'Meals are at their smallest (0.6×); drop a snack or a meal to go lower.' : '';
  return `<div class="macro"><div class="row"><span class="grow">${empty ? 'Nothing picked this week yet' : `Meals sized at <b>${f}×</b> to hit ${(kTarget || 0).toLocaleString()} kcal`}</span></div>
    <div class="row" style="margin-top:6px"><span class="lbl">Calories</span><div class="budget grow kcal ${kPct < 90 ? 'low' : ''}" style="margin:0"><i style="width:${kPct}%"></i></div><b class="val">${st.avgKcal.toLocaleString()}</b><span class="small muted">/ ${(kTarget || 0).toLocaleString()}</span></div>
    <div class="row" style="margin-top:6px"><span class="lbl">Protein</span><div class="budget grow ${pPct < 90 ? 'low' : ''}" style="margin:0"><i style="width:${pPct}%"></i></div><b class="val">${st.avg}g</b><span class="small muted">/ ${pTarget}g</span></div>
    ${shop ? `<div class="row" style="margin-top:6px"><span class="lbl">Shop</span><div class="budget grow ${shop.total > budget ? 'over' : ''}" style="margin:0"><i style="width:${Math.min(100, Math.round((shop.total / (budget || 1)) * 100))}%"></i></div><b class="val">${P.gbp(shop.total)}</b><span class="small muted">at ${P.SHOP_NAMES[shop.shop]} / £${budget}</span></div>` : ''}
    <p class="small muted" style="margin:6px 0 0">${empty ? 'Pick meals on Plan and come back; the bars fill from what you pick.' : `${capped ? capped + ' ' : ''}${gapP > 0 ? `${gapP}g protein short: swap in a higher-protein meal or add a protein snack.` : `Protein covered (${-gapP}g over).`}`}</p></div>`;
}
function accountCard() {
  if (!cloud.enabled) return `<p class="small muted">Everything is saved on this phone only. Sign-in and sync switch on once the app is connected to its cloud project.</p>`;
  if (cloud.status === 'error') return `<div class="bad-box">Cloud problem: ${esc(cloud.error || 'unknown')}. The app keeps working on this phone.</div>`;
  if (!cloud.user) return `<p class="small muted">Sign in to keep your plans safe and sync them between devices. No password: you get a link by email.</p>
    <form id="signin-form"><label class="field">Email<input name="email" type="email" required placeholder="you@uni.ac.uk" autocomplete="email"></label><button class="btn block" type="submit">Send me a sign-in link</button></form>`;
  const pro = isPro();
  const until = cloud.planExpires ? ` until ${fmtDate(cloud.planExpires.slice(0, 10))}` : '';
  return `<div class="row"><span class="grow"><b>${esc(cloud.user.email)}</b><span class="sub muted">${pro ? `Full access${until}` : 'Free plan'}${cloud.lastSync ? ` · synced ${new Date(cloud.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span></span><button class="btn ghost small" data-action="signout">Sign out</button></div>
    ${pro ? '' : `<button class="btn block" data-action="upgrade" data-why="account" style="margin-top:10px">Unlock everything</button>`}`;
}
function openUpgrade(why) {
  const reasons = { next: 'Planning next week is part of the full app.', shops: 'Comparing all five shops is part of the full app.', recipes: `The free plan holds ${FREE_LIBRARY_LIMIT} recipes. The full app has the whole catalogue.`, account: '' };
  const url = CONFIG.CHECKOUT_URL ? `${CONFIG.CHECKOUT_URL}${CONFIG.CHECKOUT_URL.includes('?') ? '&' : '?'}checkout[custom][user_id]=${encodeURIComponent(cloud.user?.id || '')}` : '';
  openSheet(`<h3>Unlock everything</h3><p class="small muted">${reasons[why] || ''}</p>
    <ul class="clean"><li>All ${RAW().filter((r) => !r.slots.includes('snack')).length} recipes and every new one added</li><li>This week and next week, with freezer tubs carrying over</li><li>Prices at all five shops, item by item</li><li>Sync between your phone, laptop and a new phone</li></ul>
    ${!cloud.user ? '<p class="small">Sign in first (Pantry → Account) so the pass attaches to your account.</p>' : url ? `<a class="btn block" href="${esc(url)}" target="_blank" rel="noopener" style="margin-top:10px">Buy a pass</a>` : '<p class="small muted">Passes aren\'t on sale yet. Ask for access and it can be switched on for your account.</p>'}`);
}
function renderPantry() {
  const groups = {};
  for (const it of ING()) if (!it.hidden) (groups[it.category] ||= []).push(it);
  const order = ['protein', 'dairy', 'carb', 'veg', 'fruit', 'tin', 'sauce', 'spice', 'cupboard'];
  const w = W();
  const row = (it) => { const v = w.pantry[it.id]; const on = v === true || typeof v === 'number';
    return `<div class="check"><input type="checkbox" data-pantry="${it.id}" ${on ? 'checked' : ''}><span class="grow">${esc(it.name)}${(it.packs || []).length ? '' : '<span class="sub">no price on file</span>'}</span>${on && !it.staple ? `<input class="qty" type="number" step="any" placeholder="plenty" data-pantry-qty="${it.id}" value="${typeof v === 'number' ? v : ''}"><span class="small muted">${it.unit === 'each' ? '' : it.unit}</span>` : ''}</div>`; };
  const html = order.filter((g) => groups[g]).map((g) => `<h2>${g}</h2><div class="card">${groups[g].map(row).join('')}</div>`).join('');
  const ticked = Object.keys(w.pantry).length;
  return `<h1>Pantry</h1>${weekSwitch()}<p class="small muted">What's in the cupboard for <b>${weekLabel(S.activeWeek).toLowerCase()}</b>. Every week starts blank so the shop list shows everything; tick what you already have before you shop. Leave the amount blank for "plenty", or type how much and the list buys only the difference. ${ticked} ticked.</p>
  <div class="row" style="margin-bottom:12px; flex-wrap:wrap"><button class="btn ghost" data-action="clear-pantry">Untick all</button></div>${html}
  <h2>Settings</h2><div class="card">
    <label class="field">Bodyweight (kg)<input type="number" data-setting="weight" value="${S.settings.weight}"></label>
    <label class="field">Goal<select data-setting-str="goal"><option value="build" ${S.settings.goal === 'build' ? 'selected' : ''}>Build muscle</option><option value="lean" ${S.settings.goal === 'lean' ? 'selected' : ''}>Stay lean and strong</option><option value="lose" ${S.settings.goal === 'lose' ? 'selected' : ''}>Lose fat, keep muscle</option><option value="eatwell" ${S.settings.goal === 'eatwell' ? 'selected' : ''}>Just eat well</option></select></label>
    <h3 style="margin-top:14px">Daily targets</h3>
    <p class="small muted">Calories set the portion size: the week's meals are scaled so they land on this number, and the shop list scales with them. Snacks stay their normal size and count towards it.</p>
    <label class="field">Calorie target: <b data-val="kcalTarget">${(S.settings.kcalTarget || 0).toLocaleString()}</b> kcal a day<input class="range" type="range" min="1200" max="4500" step="50" data-setting="kcalTarget" value="${S.settings.kcalTarget || 2500}"></label>
    <label class="field">Protein target: <b data-val="proteinTarget">${S.settings.proteinTarget}g</b> a day <span class="muted">(what you're aiming for; hit it with higher-protein meals and snacks)</span><input class="range" type="range" min="80" max="260" step="5" data-setting="proteinTarget" value="${S.settings.proteinTarget}"></label>
    <div id="macro-preview">${macroPreview(S.settings.kcalTarget, S.settings.proteinTarget)}</div>
    <button class="btn ghost small" data-action="suggest-targets">Suggest targets from my weight and goal</button>
    <label class="field">Weekly food budget (£)<input type="number" data-setting="budget" value="${S.settings.budget}"></label>
    <div class="small muted" style="margin-top:8px">Things you don't eat (recipes with these are hidden)</div>
    <div class="chip-row">${Object.entries(AVOID).map(([k, v]) => `<button class="chip ${S.settings.avoid.includes(k) ? 'on' : ''}" data-action="avoid" data-id="${k}">${v.label}</button>`).join('')}</div>
    <button class="btn ghost small" data-action="intro">Show the intro again</button>
    <label class="check"><input type="checkbox" data-setting-bool="preferThigh" ${S.settings.preferThigh ? 'checked' : ''}><span>Buy boneless thigh fillets instead of breast<span class="sub">Swaps every breast line on the shop list for thigh fillets. Breast is currently the cheaper per kilo at all four shops.</span></span></label></div>
  <h2>Account</h2><div class="card">${accountCard()}</div>
  <h2>Backup</h2><div class="card"><div class="row"><button class="btn ghost grow" data-action="export">Copy backup</button><button class="btn ghost grow" data-action="import">Paste backup</button></div>
  <button class="btn danger block" data-action="reset" style="margin-top:10px">Reset everything</button></div>
  <p class="small muted" style="text-align:center">${esc(CONFIG.APP_NAME)} ${APP_VERSION} · prices checked ${DATA.priceDate || ''} · <a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a></p>`;
}

// ---------- sheet ----------
// In-app replacements for confirm/alert/prompt: iOS standalone web apps often don't show the built-in ones at all.
function ask(text, okLabel = 'Yes', danger = false) {
  return new Promise((resolve) => {
    openSheet(`<h3>${esc(text)}</h3><div class="row" style="margin-top:14px"><button class="btn ghost grow" data-dlg="0">Cancel</button><button class="btn grow ${danger ? 'danger' : ''}" data-dlg="1">${esc(okLabel)}</button></div>`);
    document.getElementById('sheet-inner').onclick = (e) => { const b = e.target.closest('[data-dlg]'); if (!b) return; document.getElementById('sheet-inner').onclick = null; closeSheet(); resolve(b.dataset.dlg === '1'); };
  });
}
function toast(text) { showHint(text); clearTimeout(toast.t); toast.t = setTimeout(hideHint, 2200); }
function showText(title, txt) { openSheet(`<h3>${esc(title)}</h3><textarea class="field" style="width:100%;min-height:140px" readonly>${esc(txt)}</textarea><button class="btn block" data-action="close-sheet" style="margin-top:10px">Done</button>`); }
function askText(title, placeholder) {
  return new Promise((resolve) => {
    openSheet(`<h3>${esc(title)}</h3><textarea id="ask-text" class="field" style="width:100%;min-height:140px" placeholder="${esc(placeholder)}"></textarea><div class="row" style="margin-top:10px"><button class="btn ghost grow" data-dlg="0">Cancel</button><button class="btn grow" data-dlg="1">OK</button></div>`);
    document.getElementById('sheet-inner').onclick = (e) => { const b = e.target.closest('[data-dlg]'); if (!b) return; const v = document.getElementById('ask-text').value; document.getElementById('sheet-inner').onclick = null; closeSheet(); resolve(b.dataset.dlg === '1' ? v : null); };
  });
}
// First-open questionnaire, full screen: goal → weight → budget → dislikes → summary.
const INTRO = { step: 1, goal: null };
function openIntro() { INTRO.step = 1; INTRO.goal = S.settings.goal || null; introStep(1); }
function introStep(n) {
  INTRO.step = n;
  const el = document.getElementById('intro');
  const dots = `<div class="dots">${[1, 2, 3, 4, 5].map((k) => `<i class="${k <= n ? 'on' : ''}"></i>`).join('')}</div>`;
  const goals = [['build', 'Build muscle', 'Rugby, lifting, bulking. 2g protein per kilo, calories up.'], ['lean', 'Stay lean and strong', 'Training most days, not bulking.'], ['lose', 'Lose fat, keep muscle', 'Calories down, protein high so you stay full.'], ['eatwell', 'Just eat well', 'Healthy, cheap, sorted. No targets to chase.']];
  const wt = S.settings.weight || 85; const g = INTRO.goal || 'build';
  const budgets = [30, 40, 50, 60];
  const step = {
    1: `<div class="logo">Fuel</div><h1>What's the goal?</h1><p>This sets your daily protein and calorie targets. You can change them any time.</p>${goals.map(([k, t, d]) => `<button class="opt ${g === k ? 'on' : ''}" data-action="intro-goal" data-goal="${k}">${t}<small>${d}</small></button>`).join('')}`,
    2: `<h1>How much do you weigh?</h1><p>Kilos, roughly. Your daily protein and calorie targets come from this and your goal. Meals stay the same size; you hit the targets by what you pick.</p><input class="big" type="number" id="intro-weight" inputmode="numeric" value="${wt}" min="40" max="160"><div class="stat-row"><div><b id="iw-p">${P.proteinTargetFor(wt, g)}g</b><span>protein a day</span></div><div><b id="iw-f">${P.kcalTargetFor(wt, g).toLocaleString()}</b><span>kcal a day</span></div></div><button class="go" data-action="intro-weight">Next</button><button class="back" data-action="intro-back">Back</button>`,
    3: `<h1>Weekly food budget?</h1><p>The shop list always shows what's left against it.</p><div class="chips">${budgets.map((b) => `<button class="opt ${S.settings.budget === b ? 'on' : ''}" data-action="intro-budget" data-budget="${b}">£${b}</button>`).join('')}</div><p style="margin-bottom:6px">Or type your own</p><input class="big" type="number" id="intro-budget" inputmode="numeric" placeholder="£" min="10" max="300"><button class="go" data-action="intro-budget-custom">Next</button><button class="back" data-action="intro-back">Back</button>`,
    4: `<h1>Anything you don't eat?</h1><p>Recipes with these are hidden. Tap all that apply.</p><div class="chips">${Object.entries(AVOID).map(([k, v]) => `<button class="opt ${S.settings.avoid.includes(k) ? 'on' : ''}" data-action="intro-avoid" data-id="${k}">${v.label}</button>`).join('')}</div><button class="go" data-action="intro-next">Next</button><button class="back" data-action="intro-back">Back</button>`,
    5: `<h1>You're set.</h1><p>Here's your setup. Snacks get picked on the Plan tab and count towards these numbers.</p><div class="stat-row"><div><b>${S.settings.proteinTarget}g</b><span>protein a day</span></div><div><b>${(S.settings.kcalTarget || 0).toLocaleString()}</b><span>kcal a day</span></div><div><b>£${S.settings.budget}</b><span>a week</span></div></div><p>Start by ticking meals. The week grid, the Sunday cook list and the cheapest shop fill themselves in.</p><button class="go" data-action="intro-done">Let's plan a week</button><button class="back" data-action="intro-back">Back</button>`,
  }[n];
  el.innerHTML = `<div class="wrap">${dots}${step}</div>`; el.hidden = false;
  const wIn = document.getElementById('intro-weight');
  if (wIn) wIn.addEventListener('input', () => { const v = +wIn.value || wt; document.getElementById('iw-p').textContent = P.proteinTargetFor(v, g) + 'g'; document.getElementById('iw-f').textContent = P.kcalTargetFor(v, g).toLocaleString(); });
}
function closeIntro() { const el = document.getElementById('intro'); el.hidden = true; el.innerHTML = ''; }
document.getElementById('intro').addEventListener('click', onAction);
function openSheet(html) { const s = document.getElementById('sheet'); document.getElementById('sheet-inner').innerHTML = html; s.hidden = false; }
function closeSheet() { document.getElementById('sheet').hidden = true; }
document.getElementById('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); else onAction(e); });
document.getElementById('sheet').addEventListener('submit', onSubmit);
document.getElementById('sheet').addEventListener('change', (e) => { const chip = e.target.closest('.chip'); if (chip && e.target.type === 'checkbox') chip.classList.toggle('on', e.target.checked); });

// ---------- drag and drop between grid cells ----------
const drag = { src: null, ghost: null, over: null, active: false, x: 0, y: 0, timer: null };
let picked = null; // { d, s } after a press-and-hold on touch
function cellAt(d, s) { return document.querySelector(`.cell[data-day="${d}"][data-slot="${s}"]`); }
function pickUp(cell) {
  picked = { d: +cell.dataset.day, s: cell.dataset.slot };
  document.querySelectorAll('.cell.lifted').forEach((c) => c.classList.remove('lifted'));
  cell.classList.add('lifted');
  navigator.vibrate?.(15);
  showHint('Tap another cell to swap, or tap this one to cancel.');
}
function dropPicked(target) {
  const from = picked; picked = null; hideHint();
  document.querySelectorAll('.cell.lifted').forEach((c) => c.classList.remove('lifted'));
  if (!target || target.classList.contains('off')) return;
  const to = { d: +target.dataset.day, s: target.dataset.slot };
  if (to.d === from.d && to.s === from.s) return;
  const w = W();
  const tmp = w.grid[from.d][from.s]; w.grid[from.d][from.s] = w.grid[to.d][to.s]; w.grid[to.d][to.s] = tmp;
  portionsFromGrid(); refreshPlan();
}
function showHint(text) { let h = document.getElementById('hint'); if (!h) { h = document.createElement('div'); h.id = 'hint'; document.body.appendChild(h); } h.textContent = text; h.classList.add('on'); }
function hideHint() { document.getElementById('hint')?.classList.remove('on'); }
function onDragStart(e) {
  const cell = e.target.closest('.cell'); if (!cell || cell.classList.contains('empty') || cell.classList.contains('off') || e.button > 0 || drag.src) return;
  if (picked) return; // a tap while holding something is handled by the click handler
  drag.src = cell; drag.x = e.clientX; drag.y = e.clientY; drag.active = false;
  if (e.pointerType === 'mouse') { try { cell.setPointerCapture(e.pointerId); } catch {} }
  else { clearTimeout(drag.timer); drag.timer = setTimeout(() => { if (drag.src === cell && !drag.active) { pickUp(cell); drag.src = null; suppressClick(); } }, 350); }
  cell.addEventListener('pointermove', onDragMove); cell.addEventListener('pointerup', onDragEnd); cell.addEventListener('pointercancel', onDragEnd);
}
function onDragMove(e) {
  if (!drag.src) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (e.pointerType !== 'mouse') { if (Math.hypot(dx, dy) > 10) { clearTimeout(drag.timer); cleanupDrag(drag.src); } return; } // finger moved: it's a scroll
  if (!drag.active) { if (Math.hypot(dx, dy) < 8) return; drag.active = true; startGhost(e); }
  drag.ghost.style.transform = `translate(${e.clientX - drag.ghost.offsetWidth / 2}px, ${e.clientY - drag.ghost.offsetHeight / 2}px)`;
  drag.ghost.style.display = 'none';
  const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
  drag.ghost.style.display = '';
  if (drag.over && drag.over !== under) drag.over.classList.remove('over');
  if (under && under !== drag.src) { under.classList.add('over'); drag.over = under; } else drag.over = null;
  e.preventDefault();
}
function startGhost(e) {
  document.querySelectorAll('.ghost').forEach((x) => x.remove());
  const g = drag.src.cloneNode(true); g.classList.add('ghost'); g.style.width = drag.src.offsetWidth + 'px'; g.style.height = drag.src.offsetHeight + 'px';
  document.body.appendChild(g); drag.ghost = g; drag.src.classList.add('lifted');
}
function cleanupDrag(src) {
  src.removeEventListener('pointermove', onDragMove); src.removeEventListener('pointerup', onDragEnd); src.removeEventListener('pointercancel', onDragEnd);
  document.querySelectorAll('.ghost').forEach((x) => x.remove()); drag.over?.classList.remove('over'); if (!picked) src.classList.remove('lifted');
  drag.src = null; drag.ghost = null; drag.over = null; drag.active = false;
}
function onDragEnd(e) {
  clearTimeout(drag.timer);
  const src = drag.src; if (!src) return;
  const target = drag.over; const wasActive = drag.active;
  cleanupDrag(src);
  if (!wasActive) return; // a plain tap: the click handler opens the sheet
  suppressClick();
  if (!target || e.type === 'pointercancel') return;
  const w = W();
  const a = { d: +src.dataset.day, s: src.dataset.slot }, b = { d: +target.dataset.day, s: target.dataset.slot };
  const tmp = w.grid[a.d][a.s]; w.grid[a.d][a.s] = w.grid[b.d][b.s]; w.grid[b.d][b.s] = tmp;
  portionsFromGrid(); render();
}
function suppressClick() { const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; document.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => document.removeEventListener('click', stop, { capture: true }), 400); }

// ---------- events ----------
function onAction(e) {
  const el = e.target.closest('[data-action]');
  if (picked && !(el && el.dataset.action === 'cell')) { dropPicked(null); }
  if (!el) return;
  const a = el.dataset.action, id = el.dataset.id; const w = W();
  if (a === 'inc' || a === 'dec') {
    if (a === 'inc' && P.roomFor(recById(id), P.freeSlots(w.grid, w.days)) <= 0) return;
    w.portions[id] = Math.max(0, (w.portions[id] || 0) + (a === 'inc' ? 1 : -1));
    if (!w.portions[id]) delete w.portions[id];
    relayout(); refreshPlan();
  } else if (a === 'week') { S.activeWeek = el.dataset.week; save(); render(); }
  else if (a === 'cookday') { w.cookDay = +el.dataset.day; relayout(); refreshPlan(); }
  else if (a === 'quick-pick') { const r = recById(id); const room = P.roomFor(r, P.freeSlots(w.grid, w.days)); if (r && room > 0) { w.portions[r.id] = Math.min(defaultPortions(r), room); relayout(); render(); } }
  else if (a === 'relayout') { relayout(); refreshPlan(); }
  else if (a === 'dayx') { const i = +el.dataset.day; w.days[i] = !w.days[i]; relayout(w); refreshPlan(); }
  else if (a === 'need') { delete w.pantry[id]; save(); render(); }
  else if (a === 'avoid') { const i = S.settings.avoid.indexOf(id); if (i >= 0) S.settings.avoid.splice(i, 1); else S.settings.avoid.push(id); save(); render(); }
  else if (a === 'intro') openIntro();
  else if (a === 'intro-goal') { INTRO.goal = el.dataset.goal; S.settings.goal = INTRO.goal; save(); introStep(2); }
  else if (a === 'intro-weight') { const v = +document.getElementById('intro-weight').value; if (!(v >= 30 && v <= 200)) { toast('Enter a weight between 30 and 200 kg'); return; } S.settings.weight = v; S.settings.proteinTarget = P.proteinTargetFor(v, INTRO.goal || S.settings.goal); S.settings.kcalTarget = P.kcalTargetFor(v, INTRO.goal || S.settings.goal); save(); introStep(3); }
  else if (a === 'intro-budget') { S.settings.budget = +el.dataset.budget; save(); introStep(4); }
  else if (a === 'intro-budget-custom') { const v = +document.getElementById('intro-budget').value; if (!(v >= 10 && v <= 300)) { toast('Type a budget between £10 and £300, or tap one above'); return; } S.settings.budget = v; save(); introStep(4); }
  else if (a === 'intro-avoid') { const i = S.settings.avoid.indexOf(id); if (i >= 0) S.settings.avoid.splice(i, 1); else S.settings.avoid.push(id); save(); el.classList.toggle('on'); }
  else if (a === 'intro-next') { introStep(INTRO.step + 1); }
  else if (a === 'intro-back') { introStep(Math.max(1, INTRO.step - 1)); }
  else if (a === 'intro-done') { S.settings.onboarded = true; save(); closeIntro(); S.tab = 'plan'; for (const wk of Object.values(S.weeks)) relayout(wk); render({ top: true }); }
  else if (a === 'suggest-targets') { S.settings.proteinTarget = P.proteinTargetFor(S.settings.weight, S.settings.goal); S.settings.kcalTarget = P.kcalTargetFor(S.settings.weight, S.settings.goal); save(); render(); toast(`${S.settings.proteinTarget}g protein, ${S.settings.kcalTarget.toLocaleString()} kcal a day`); }
  else if (a === 'sinc' || a === 'sdec') { w.snacks[id] = Math.max(0, (w.snacks[id] || 0) + (a === 'sinc' ? 1 : -1)); if (!w.snacks[id]) delete w.snacks[id]; save(); refreshPlan(); }
  else if (a === 'fresh-default') { if (el.dataset.on === '1') S.freshDefault[id] = true; else delete S.freshDefault[id]; save(); render(); toast(el.dataset.on === '1' ? 'Made fresh each time, not batched' : 'Back on the batch list'); }
  else if (a === 'signout') { signOut().then(() => { render(); toast('Signed out. Your data stays on this phone.'); }); }
  else if (a === 'upgrade') { openUpgrade(el.dataset.why); }
  else if (a === 'ideas-toggle') { S.ideasOpen = !S.ideasOpen; save(); render(); }
  else if (a === 'idea-tag') { S.ideaTag = el.dataset.tag; save(); render(); }
  else if (a === 'lib-add') { if (!isPro() && !S.library.includes(id) && S.library.filter((x) => !recById(x)?.slots.includes('snack')).length >= FREE_LIBRARY_LIMIT) { openUpgrade('recipes'); return; } if (!S.library.includes(id)) S.library.push(id); save(); closeSheet(); render(); toast('Added to your recipes'); }
  else if (a === 'lib-remove') { S.library = S.library.filter((x) => x !== id); for (const wk of Object.values(S.weeks)) { delete wk.portions[id]; delete wk.snacks?.[id]; relayout(wk); } save(); closeSheet(); render(); toast('Removed from your recipes'); }
  else if (a === 'clear-pantry') { ask(`Untick everything for ${weekLabel(S.activeWeek).toLowerCase()}? The shop list will then include every ingredient.`, 'Untick all').then((ok) => { if (ok) { w.pantry = {}; save(); render(); toast('Pantry cleared'); } }); }
  else if (a === 'clear-week') { ask(`Clear every meal from ${weekLabel(S.activeWeek).toLowerCase()}?`, 'Clear week', true).then((ok) => { if (ok) { w.portions = {}; w.ticks = {}; relayout(); render(); } }); }
  else if (a === 'close-sheet') closeSheet();
  else if (a === 'cell' && picked) { dropPicked(el); }
  else if (a === 'cell') {
    const day = +el.dataset.day, slot = el.dataset.slot;
    const cur = w.grid[day][slot];
    const planned = Object.keys(w.portions).map(recById).filter(Boolean);
    const others = REC().filter((r) => !w.portions[r.id] && !isAvoided(r));
    const opt = (r) => `<option value="${r.id}" ${cur === r.id ? 'selected' : ''}>${esc(r.name)}</option>`;
    const tubs = Object.entries(S.tubs).filter(([, n]) => n > 0);
    const tubOpts = tubs.map(([id, n]) => `<option value="tub:${id}" ${cur === 'tub:' + id ? 'selected' : ''}>${esc(recById(id)?.name || id)} · freezer tub (${n} left)</option>`).join('');
    const r = P.isRecipeCell(cur) ? recById(cur) : null;
    const freshRow = r && r.cookMinutes > 0 ? `<label class="check"><input type="checkbox" id="cell-fresh" ${w.fresh[`${day}-${slot}`] ? 'checked' : ''}><span>Make this one fresh on the day<span class="sub">Left out of the batch cook; still on the shop list.</span></span></label>` : '';
    openSheet(`<h3>${P.DAYS[day]} ${slot}</h3><label class="field">Meal<select id="cell-pick"><option value="" ${!cur ? 'selected' : ''}>— empty —</option><option value="out" ${P.isOut(cur) ? 'selected' : ''}>Eating out / skip this meal</option>${tubOpts ? `<optgroup label="From the freezer">${tubOpts}</optgroup>` : ''}<optgroup label="Picked this week">${planned.map(opt).join('')}</optgroup><optgroup label="Everything else">${others.map(opt).join('')}</optgroup></select></label>${freshRow}<button class="btn block" data-action="cell-set" data-day="${day}" data-slot="${slot}">Set</button>`);
  } else if (a === 'cell-set') {
    const day = +el.dataset.day, slot = el.dataset.slot, val = document.getElementById('cell-pick').value || null;
    const key = `${day}-${slot}`; const cur = w.grid[day][slot];
    const freshBox = document.getElementById('cell-fresh');
    const apply = () => {
      if (P.isTub(cur) && val !== cur) S.tubs[P.tubRecipe(cur)] = (S.tubs[P.tubRecipe(cur)] || 0) + 1; // putting a tub back
      if (P.isTub(val) && val !== cur) { const rid = P.tubRecipe(val); if (!(S.tubs[rid] > 0)) { toast('No tubs of that left'); return; } S.tubs[rid] -= 1; }
      w.grid[day][slot] = val;
      if (freshBox && val === cur) { if (freshBox.checked) w.fresh[key] = true; else delete w.fresh[key]; } else delete w.fresh[key];
      portionsFromGrid(); closeSheet(); refreshPlan();
    };
    if (P.isOut(val) && P.isRecipeCell(cur) && recById(cur)?.cookMinutes > 0) {
      closeSheet();
      ask(`Have you already cooked that ${shortName(recById(cur)).toLowerCase()}? Yes puts the spare portion in your freezer for another week.`, 'Yes, it\'s cooked').then((cooked) => { if (cooked) { S.tubs[cur] = (S.tubs[cur] || 0) + 1; w.grid[day][slot] = 'out'; delete w.fresh[key]; portionsFromGrid(); refreshPlan(); } else apply(); });
      return;
    }
    apply();
  } else if (a === 'open-recipe') { const r = recById(id); if (r) openSheet(recipeDetail(r)); }
  else if (a === 'add-portion') { w.portions[id] = (w.portions[id] || 0) + 1; relayout(); closeSheet(); S.tab = 'plan'; render({ top: true }); }
  else if (a === 'delete-recipe') { ask('Delete this recipe?', 'Delete', true).then((ok) => { if (ok) { S.customRecipes = S.customRecipes.filter((r) => r.id !== id); META.clear(); for (const wk of Object.values(S.weeks)) { delete wk.portions[id]; relayout(wk); } closeSheet(); render(); } }); }
  else if (a === 'add-recipe') { openSheet(recipeForm()); addIngRow(); }
  else if (a === 'add-link') openSheet(linkForm());
  else if (a === 'inbox-rm') { S.inbox.splice(+el.dataset.i, 1); save(); render(); }
  else if (a === 'inbox-copy') {
    const txt = 'Please add these to Fuel as priced recipes:\n' + S.inbox.map((x) => `- ${x.url}${x.note ? ` (${x.note})` : ''}`).join('\n');
    (navigator.clipboard?.writeText(txt) || Promise.reject()).then(() => toast('Copied. Paste it to Claude.'), () => showText('Copy this and paste it to Claude', txt));
  }
  else if (a === 'add-ing-row') addIngRow();
  else if (a === 'rm-row') el.closest('.ing-row').remove();
  else if (a === 'new-ingredient') openSheet(newIngredientForm());
  else if (a === 'export') {
    const txt = JSON.stringify({ weeks: S.weeks, activeWeek: S.activeWeek, customRecipes: S.customRecipes, customIngredients: S.customIngredients, settings: S.settings, inbox: S.inbox });
    (navigator.clipboard?.writeText(txt) || Promise.reject()).then(() => toast('Backup copied. Paste it somewhere safe.'), () => showText('Copy this backup', txt));
  } else if (a === 'import') {
    askText('Paste your backup', 'Paste the backup text here').then((txt) => { if (!txt) return; try { Object.assign(S, JSON.parse(txt)); setupWeeks(); render(); toast('Backup restored'); } catch { toast('That did not look like a backup.'); } });
  } else if (a === 'reset') { ask('Wipe plans, pantry and your own recipes on this phone?', 'Wipe', true).then((ok) => { if (ok) { localStorage.removeItem(KEY); location.reload(); } }); }
}
function addIngRow() { const t = document.getElementById('ing-row-t'); document.getElementById('ing-rows').appendChild(t.content.cloneNode(true)); }
function onChange(e) {
  const t = e.target; const w = W();
  if (t.dataset.pick) {
    const r = recById(t.dataset.pick);
    const room = P.roomFor(r, P.freeSlots(w.grid, w.days));
    if (t.checked) { if (room <= 0) { t.checked = false; return; } w.portions[r.id] = Math.min(defaultPortions(r), room); } else delete w.portions[r.id];
    relayout(); refreshPlan();
  }
  else if (t.dataset.snackPick) { const r = recById(t.dataset.snackPick); if (t.checked) w.snacks[r.id] = 7; else delete w.snacks[r.id]; save(); refreshPlan(); }
  else if (t.dataset.settingStr) { S.settings[t.dataset.settingStr] = t.value; save(); }
  else if (t.dataset.tick) { w.ticks[t.dataset.tick] = t.checked; save(); t.closest('.line').classList.toggle('done', t.checked); }
  else if (t.dataset.choice) { w.choices[t.dataset.choice] = t.value; save(); render(); }
  else if (t.dataset.settingBool) { S.settings[t.dataset.settingBool] = t.checked; save(); render(); }
  else if (t.dataset.pantry) {
    const id = t.dataset.pantry; if (t.checked) w.pantry[id] = true; else delete w.pantry[id]; save();
    const it = ingById(id); const rowEl = t.closest('.check'); const q = rowEl.querySelector('[data-pantry-qty]');
    if (t.checked && !it.staple && !q) rowEl.insertAdjacentHTML('beforeend', `<input class="qty" type="number" step="any" placeholder="plenty" data-pantry-qty="${id}"><span class="small muted">${it.unit === 'each' ? '' : it.unit}</span>`);
    if (!t.checked) { q?.nextElementSibling?.remove(); q?.remove(); }
  }
  else if (t.dataset.pantryQty !== undefined) { const v = parseFloat(t.value); w.pantry[t.dataset.pantryQty] = Number.isFinite(v) && v > 0 ? v : true; save(); }
  else if (t.dataset.setting) { S.settings[t.dataset.setting] = +t.value || 0; save(); META.clear(); const mp = document.getElementById('macro-preview'); if (mp) mp.innerHTML = macroPreview(S.settings.kcalTarget, S.settings.proteinTarget); }
}
function onInput(e) {
  if (['proteinTarget', 'kcalTarget'].includes(e.target.dataset.setting)) {
    const k = e.target.dataset.setting, v = +e.target.value; const b = e.target.closest('label').querySelector('b'); if (b) b.textContent = k === 'kcalTarget' ? v.toLocaleString() : v + 'g';
    const p = k === 'proteinTarget' ? v : S.settings.proteinTarget, c = k === 'kcalTarget' ? v : S.settings.kcalTarget;
    const mp = document.getElementById('macro-preview'); if (mp) mp.innerHTML = macroPreview(c, p); return;
  }
  const t = e.target;
  if (t.dataset.search !== undefined) { S.search = t.value; refreshCard(renderRecipes); }
  else if (t.dataset.planSearch !== undefined) { S.planSearch = t.value; render(); const inp = document.querySelector('[data-plan-search]'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
}
function refreshCard(fn) { const v = document.getElementById('view'); const card = v.querySelector('.card'); if (card) { const tmp = document.createElement('div'); tmp.innerHTML = fn(); card.innerHTML = tmp.querySelector('.card').innerHTML; } }
function onSubmit(e) {
  e.preventDefault();
  const f = e.target; const fd = new FormData(f);
  if (f.id === 'signin-form') {
    const email = String(fd.get('email')).trim();
    signIn(email).then(() => { closeSheet(); toast('Check your email for the sign-in link'); f.querySelector('button').disabled = true; }).catch((err) => toast(err.message || 'Could not send the link'));
    return;
  }
  if (f.id === 'link-form') {
    S.inbox = (S.inbox || []).concat([{ url: String(fd.get('url')).trim(), note: String(fd.get('note') || '').trim(), added: new Date().toISOString().slice(0, 10) }]);
    save(); closeSheet(); render(); return;
  }
  if (f.id === 'ing-form') {
    const name = fd.get('name').trim(); const id = 'c_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    S.customIngredients = S.customIngredients.filter((i) => i.id !== id).concat([{ id, name, unit: fd.get('unit'), protein: +fd.get('protein') || 0, category: fd.get('category'), store: fd.get('store'), packs: [] }]);
    save(); openSheet(recipeForm()); addIngRow(); return;
  }
  if (f.id === 'recipe-form') {
    const name = fd.get('name').trim(); const id = 'c_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const slots = fd.getAll('slot'); if (!slots.length) { toast('Pick at least one slot.'); return; }
    const ings = [...f.querySelectorAll('.ing-row')].map((r) => ({ id: r.querySelector('[name=ing]').value, qty: +r.querySelector('[name=qty]').value })).filter((x) => x.qty > 0);
    if (!ings.length) { toast('Add at least one ingredient.'); return; }
    const method = String(fd.get('method')).split('\n').map((s) => s.trim()).filter(Boolean);
    const r = { id, name, slots, cold: !!fd.get('cold'), reheat: fd.get('reheat'), fridgeDays: +fd.get('fridgeDays') || 0, freezer: !!fd.get('freezer'), cookMinutes: +fd.get('cookMinutes') || 0, equipment: [], source: fd.get('source') || 'yours', ingredients: ings, method, notes: '' };
    S.customRecipes = S.customRecipes.filter((x) => x.id !== id).concat([r]); META.clear(); save(); closeSheet(); render();
  }
}

boot();
