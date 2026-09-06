import * as P from './planner.js';

const KEY = 'fuel:v1';
const APP_VERSION = 'v8';
const DATA = { ingredients: [], recipes: [] };
const S = load();

function load() {
  const base = { tab: 'plan', activeWeek: null, weeks: {}, pantry: null, customRecipes: [], customIngredients: [], inbox: [], settings: { proteinTarget: 180, snackProtein: 24, budget: 50 } };
  try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return base; }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }

const ING = () => DATA.ingredients.concat(S.customIngredients);
const REC = () => DATA.recipes.concat(S.customRecipes);
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
function blankWeek() { return { portions: {}, grid: null, overflow: [], cookDay: 0, ticks: {}, days: [true, true, true, true, true, true, true], choices: {} }; }
function setupWeeks() {
  const thisSun = sundayOf(new Date()), nextSun = addDays(thisSun, 7);
  // migrate v1 single-week state
  if (S.portions) { S.weeks[thisSun] = { portions: S.portions, grid: S.grid, overflow: S.overflow || [], cookDay: S.cookDay || 0, ticks: S.ticks || {} }; delete S.portions; delete S.grid; delete S.overflow; delete S.cookDay; delete S.ticks; }
  for (const k of Object.keys(S.weeks)) if (k < thisSun) delete S.weeks[k];
  S.weeks[thisSun] ||= blankWeek(); S.weeks[nextSun] ||= blankWeek();
  if (!S.weeks[S.activeWeek]) S.activeWeek = thisSun;
  S.thisSun = thisSun; S.nextSun = nextSun;
  for (const w of Object.values(S.weeks)) { w.days ||= [true, true, true, true, true, true, true]; w.choices ||= {}; if (!w.grid) relayout(w); }
  save();
}
function relayout(w = W()) {
  let { grid, overflow } = P.autoLayout(w.portions, REC(), w.cookDay, w.days);
  // The week can't hold more than its slots: trim portions to what fits rather than carrying phantom extras.
  if (overflow.length) { w.portions = P.gridCounts(grid); ({ grid, overflow } = P.autoLayout(w.portions, REC(), w.cookDay, w.days)); }
  w.grid = grid; w.overflow = overflow; save();
}
function portionsFromGrid(w = W()) {
  const counts = {};
  for (const d of w.grid) for (const s of P.SLOTS) if (d[s]) counts[d[s]] = (counts[d[s]] || 0) + 1;
  w.portions = counts; w.overflow = []; save();
}
function weekLabel(k) { return k === S.thisSun ? 'This week' : k === S.nextSun ? 'Next week' : `Week of ${fmtDate(k)}`; }
function weekSwitch() {
  return `<div class="chip-row week-switch">${[S.thisSun, S.nextSun].map((k) => `<button class="chip ${S.activeWeek === k ? 'on' : ''}" data-action="week" data-week="${k}">${weekLabel(k)} <span class="muted small">${fmtDate(k)}</span></button>`).join('')}</div>`;
}

// ---------- boot ----------
async function boot() {
  try {
    const [i, r, st] = await Promise.all([fetch('data/ingredients.json').then((x) => x.json()), fetch('data/recipes.json').then((x) => x.json()), fetch('data/stock.json').then((x) => x.json()).catch(() => null)]);
    DATA.ingredients = i.items; DATA.recipes = r.items; DATA.priceNote = i.checkedNote; DATA.stock = st?.items || null; DATA.stockDate = st?.checked ? fmtDate(st.checked) : null; DATA.priceDate = (i.items.flatMap((x) => x.packs || []).map((p) => p.checked).sort().pop()) || '';
  } catch (e) {
    document.getElementById('view').innerHTML = `<div class="bad-box">Couldn't load the recipe data. ${esc(e.message)}</div>`;
    return;
  }
  if (!S.pantry) { S.pantry = {}; for (const it of ING()) if (it.staple) S.pantry[it.id] = true; }
  if (S.pantry.peppers_frozen !== undefined) { S.pantry.pepper = S.pantry.peppers_frozen; delete S.pantry.peppers_frozen; }
  setupWeeks();
  document.getElementById('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.tab; save(); render({ top: true }); } });
  const v = document.getElementById('view');
  v.addEventListener('click', onAction); v.addEventListener('change', onChange); v.addEventListener('input', onInput);
  v.addEventListener('pointerdown', onDragStart);
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function render(opts = {}) {
  const y = window.scrollY;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  document.getElementById('view').innerHTML = ({ plan: renderPlan, cook: renderCook, shop: renderShop, recipes: renderRecipes, pantry: renderPantry })[S.tab]();
  window.scrollTo(0, opts.top ? 0 : y);
}

// ----- Plan -----
function mealMeta(r, ing) {
  const pp = P.proteinPerPortion(r, ing);
  const c = P.costPerPortion(r, ing);
  const cost = c.cost ? `~£${c.cost.toFixed(2)}` : '';
  const flex = '';
  const cold = r.cold ? '<span class="badge ok">cold ok</span>' : '';
  const fz = r.freezer ? '<span class="badge">freezes</span>' : (r.fridgeDays ? `<span class="badge warn">fridge ${r.fridgeDays}d</span>` : '<span class="badge">made fresh</span>');
  return `${pp}g protein${cost ? ` · ${cost} a portion` : ''} ${flex}${cold}${fz}`;
}
function renderPlan() {
  const w = W(); const recipes = REC(), ing = ING();
  const st = P.gridStats(w.grid, recipes, ing, S.settings.snackProtein, w.days);
  const target = S.settings.proteinTarget;
  const max = Math.max(target * 1.2, ...st.perDay);
  const bars = st.perDay.map((p) => `<div class="bar ${p < target ? 'low' : ''}"><b>${p}</b><i style="height:${Math.round((p / max) * 100)}%"></i></div>`).join('');
  const q = (S.planSearch || '').toLowerCase();
  const chosen = Object.keys(w.portions).filter((id) => w.portions[id] > 0);
  const free = P.freeSlots(w.grid, w.days);
  const row = (r) => {
    const n = w.portions[r.id] || 0;
    const room = P.roomFor(r, free);
    const full = room <= 0;
    return `<div class="recipe-row pick ${n ? 'on' : ''} ${full && !n ? 'full' : ''}"><input type="checkbox" class="tick" data-pick="${r.id}" ${n ? 'checked' : ''} ${full && !n ? 'disabled' : ''} aria-label="Include ${esc(r.name)}"><div class="grow"><div class="name">${esc(r.name)}</div><div class="meta">${mealMeta(r, ing)}${full && !n ? ' <span class="badge">week full</span>' : ''}</div></div>
      ${n ? `<div class="stepper"><button data-action="dec" data-id="${r.id}">−</button><b>${n}</b><button data-action="inc" data-id="${r.id}" ${full ? 'disabled' : ''}>+</button></div>` : ''}</div>`;
  };
  const group = (slot, title) => {
    const list = recipes.filter((r) => (slot === 'breakfast' ? r.slots[0] === 'breakfast' : r.slots[0] !== 'breakfast') && (!q || r.name.toLowerCase().includes(q)));
    return list.length ? `<h2>${title}</h2><div class="card">${list.map(row).join('')}</div>` : '';
  };
  const overflow = (w.overflow || []).map((o) => `<div class="warn-box">${esc(recById(o.id)?.name)}: ${o.unplaced} portion${o.unplaced > 1 ? 's' : ''} won't fit in the week. Drop the count or move something.</div>`).join('');
  const gridHtml = `<div class="grid"><div></div>${P.DAYS.map((d, i) => `<div class="hd ${w.days[i] ? '' : 'off'}"><span>${d}</span><button class="dayx" data-action="dayx" data-day="${i}" title="${w.days[i] ? 'Skip this day' : 'Put this day back'}">${w.days[i] ? '×' : '+'}</button></div>`).join('')}
    ${P.SLOTS.map((s) => `<div class="lbl">${({ breakfast: 'Bfast', lunch: 'Lunch', dinner: 'Dinner' })[s]}</div>` + w.grid.map((d, i) => {
      const id = d[s]; const r = id && recById(id);
      if (!w.days[i]) return `<div class="cell off"></div>`;
      if (!r) return `<button class="cell empty" data-action="cell" data-day="${i}" data-slot="${s}">+</button>`;
      const tp = P.tubPlan(r, w.grid, w.cookDay);
      const cls = tp.fresh ? '' : tp.freezer.includes(i) ? 'frozen' : tp.late.includes(i) ? 'late' : '';
      const c = P.costPerPortion(r, ing);
      const mark = cls === 'frozen' ? '❄ freezer' : cls === 'late' ? '⚠ fridge' : tp.fresh ? 'fresh' : 'fridge';
      const markShort = cls === 'frozen' ? '❄' : cls === 'late' ? '⚠' : '';
      return `<button class="cell ${cls}" style="${cellStyle(id)}" data-action="cell" data-day="${i}" data-slot="${s}" draggable="false"><span class="cname"><span class="full">${esc(r.name)}</span><span class="shortn">${esc(shortName(r))}</span></span><span class="cmeta"><span class="full">${P.proteinPerPortion(r, ing)}g protein</span><span class="shortn">${P.proteinPerPortion(r, ing)}g ${markShort}</span></span><span class="cmark full">${mark}</span></button>`;
    }).join('')).join('')}</div>`;
  const summary = chosen.length
    ? `<div class="chip-row">${chosen.map((id) => `<span class="chip meal" style="${cellStyle(id)}">${esc(shortName(recById(id)))} × ${w.portions[id]}</span>`).join('')}</div>`
    : `<p class="muted">Nothing picked yet. Tick meals below and they land in the grid.</p>`;
  return `<h1>Plan</h1>${weekSwitch()}
  <div class="card"><h3>${weekLabel(S.activeWeek)} <span class="muted small">from Sun ${fmtDate(S.activeWeek)}</span></h3>${summary}
    <div class="stat-grid" style="margin-top:10px"><div class="stat"><b>${st.filled}<span>/${st.slots}</span></b><span>meal slots filled</span></div><div class="stat"><b>${st.distinct}</b><span>different meals</span></div><div class="stat"><b>${st.avg}g</b><span>avg protein/day</span></div></div>
    <div class="bars" style="margin-top:26px">${bars}</div><div class="bars-labels">${P.DAYS.map((d) => `<div>${d}</div>`).join('')}</div>
    <p class="small muted">Target ${target}g a day including a ${S.settings.snackProtein}g snack. Amber days are under.</p></div>
  ${chosen.length ? `<div class="card">${gridHtml}
    <p class="small muted" style="margin-top:10px">Drag a meal to move it; drop it on another to swap. Tap to pick from a list or clear. ❄ from the freezer that day, thaw the night before. ⚠ past its fridge life and can't be frozen.</p>
    <p class="small muted" style="margin:8px 0 2px">Cook day</p>
    <div class="day-pick">${P.DAYS.map((d, i) => `<button data-action="cookday" data-day="${i}" class="${w.cookDay === i ? 'on' : ''}">${d}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px"><button class="btn ghost small" data-action="relayout">Re-lay out</button><button class="btn ghost small" data-action="clear-week">Clear week</button></div></div>` : ''}
  ${overflow}${lateWarnings(w)}
  <h2 style="margin-top:26px">Pick meals</h2>
  <input class="search" placeholder="Search meals" value="${esc(S.planSearch || '')}" data-plan-search>
  ${group('breakfast', 'Breakfasts')}${group('mains', 'Mains (lunch or dinner)')}`;
}
function shortName(r) { if (!r) return ''; if (r.short) return r.short; const w = r.name.split(' '); let out = w[0]; if (w[1] && (out + ' ' + w[1]).length <= 11) out += ' ' + w[1]; return out; }
function lateWarnings(w) {
  const out = [];
  for (const [rid, n] of Object.entries(w.portions)) {
    const r = recById(rid); if (!r || !n || r.cookMinutes === 0) continue;
    const tp = P.tubPlan(r, w.grid, w.cookDay);
    if (tp.late.length) out.push(`<div class="warn-box"><b>${esc(r.name)}</b> keeps ${r.fridgeDays} day${r.fridgeDays === 1 ? '' : 's'} and can't be frozen, so the ${tp.late.map((d) => P.DAYS[d]).join(', ')} portion${tp.late.length > 1 ? 's need' : ' needs'} a second cook midweek. Move ${tp.late.length > 1 ? 'them' : 'it'} earlier or swap for a freezer recipe.</div>`);
  }
  return out.join('');
}
function defaultPortions(r) { return r.slots[0] === 'breakfast' ? 4 : 3; }

// ----- Cook -----
function renderCook() {
  const w = W(); const recipes = REC(), ing = ING();
  const counts = P.gridCounts(w.grid);
  const rs = P.runSheet(counts, recipes);
  const fresh = Object.entries(counts).filter(([rid, n]) => n > 0 && recById(rid)?.cookMinutes === 0).map(([rid, n]) => ({ recipe: recById(rid), portions: n }));
  const head = `<h1>Cook</h1>${weekSwitch()}`;
  if (!rs.list.length && !fresh.length) return `${head}<div class="card"><p>Nothing picked for ${weekLabel(S.activeWeek).toLowerCase()} yet. Tick meals on the Plan tab.</p></div>`;
  const cookDay = P.DAYS[w.cookDay];
  const sheet = rs.list.map((x) => `<li><b>${esc(x.recipe.name)}</b> × ${x.portions} <span class="muted small">· ${x.recipe.cookMinutes} min · ${x.recipe.equipment.join(', ')}</span></li>`).join('');
  const freshList = fresh.map((x) => `<li><b>${esc(x.recipe.name)}</b> × ${x.portions} <span class="muted small">· made fresh, ${x.recipe.slots[0]}</span></li>`).join('');
  const cards = rs.list.map(({ recipe: r, portions: n }) => {
    const scaled = P.scaleIngredients(r, n, ing);
    const tp = P.tubPlan(r, w.grid, w.cookDay);
    const reheat = { none: 'Eat cold', microwave: 'Microwave 2–3 min, stir halfway', hob: 'Reheat in a pan', 'air-fryer': 'Air-fryer 6 min at 180°C' }[r.reheat] || '';
    return `<div class="card"><h3>${esc(r.name)} <span class="muted">× ${n}</span></h3>
      <p class="small muted">${P.proteinPerPortion(r, ing)}g protein a portion · ${r.cookMinutes} min · ${r.equipment.join(', ')}</p>
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
  ${fresh.length ? `<hr><p class="small muted">Made on the day, not batched:</p><ul class="clean">${freshList}</ul>` : ''}
  <p class="small muted" style="margin-top:8px">Rice rule: cooked rice goes in the freezer the same day unless it's eaten within 24 hours.</p></div>
  ${cards}`;
}

// ----- Shop -----
function renderShop() {
  const w = W(); const ing = ING(), recipes = REC();
  const counts = P.gridCounts(w.grid);
  const resolve = resolveFor(w);
  const rawNeeds = P.aggregateNeeds(counts, recipes);
  const needsAll = P.aggregateNeeds(counts, recipes, resolve);
  // pantry keys may be the generic id (e.g. frozen_fruit) or the resolved one
  const pantryFor = {}; for (const id of Object.keys(needsAll)) { const generic = Object.keys(rawNeeds).find((g) => resolve(g) === id); pantryFor[id] = S.pantry[id] !== undefined ? S.pantry[id] : (generic ? S.pantry[generic] : undefined); }
  const needs = P.netPantry(needsAll, pantryFor);
  const usedBy = {};
  for (const [rid, n] of Object.entries(counts)) { const r = recById(rid); if (!r) continue; for (const x of r.ingredients) (usedBy[resolve(x.id)] ||= []).push(`${r.short || r.name} ×${n}`); }
  const choiceHtml = Object.keys(rawNeeds).map(ingById).filter((it) => it?.choices?.length).map((it) => `<label class="field">${esc(it.name)}<select data-choice="${it.id}">${it.choices.map((c) => `<option value="${c}" ${resolve(it.id) === c ? 'selected' : ''}>${esc(ingById(c)?.name || c)}</option>`).join('')}</select></label>`).join('');
  const fullWeek = P.compareShops(needsAll, ing)[0];
  const head = `<h1>Shop</h1>${weekSwitch()}`;
  if (!Object.keys(needsAll).length) return `${head}<div class="card"><p>Nothing picked for ${weekLabel(S.activeWeek).toLowerCase()} yet. Tick meals on the Plan tab.</p></div>`;
  const ranked = P.compareShops(needs, ing);
  const byShop = Object.fromEntries(ranked.map((b) => [b.shop, b]));
  const split = P.cheapestSplit(needs, ing);
  const best = ranked[0];
  const budget = S.settings.budget;
  const pct = Math.min(100, Math.round((best.total / budget) * 100));
  // per-shop totals table
  const totals = `<table class="tbl"><thead><tr><th>Shop</th><th class="r">Total</th><th class="r">Priced</th><th class="r">Missing</th></tr></thead><tbody>${ranked.map((b) => `<tr class="${b === best ? 'best' : ''}"><td>${P.SHOP_NAMES[b.shop]}${b === best ? ' <span class="badge ok">cheapest</span>' : ''}</td><td class="r"><b>${P.gbp(b.total)}</b></td><td class="r">${b.lines.length}</td><td class="r">${b.missing.length ? `<span class="badge warn">${b.missing.length}</span>` : '0'}</td></tr>`).join('')}</tbody></table>
    <p class="small muted">Totals only count items that shop has a price for, so a shop with missing prices looks cheaper than it is.</p>`;
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
    ${haveRows ? `<p class="small"><b>${Object.keys(needsAll).filter((id) => pantryFor[id] !== undefined).length} ingredients are left off because they're ticked in Pantry</b> (see the bottom of this page, or Pantry → Untick all).</p>` : ''}
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
function renderRecipes() {
  const q = (S.search || '').toLowerCase();
  const ing = ING();
  const list = REC().filter((r) => !q || r.name.toLowerCase().includes(q)).map((r) => `<div class="recipe-row" data-action="open-recipe" data-id="${r.id}"><div class="grow"><div class="name">${esc(r.name)}</div><div class="meta">${mealMeta(r, ing)}${S.customRecipes.some((c) => c.id === r.id) ? ' <span class="badge">yours</span>' : ''}</div></div><span class="muted">›</span></div>`).join('');
  const inbox = (S.inbox || []);
  const inboxHtml = inbox.length ? `<div class="card"><h3>Waiting for Claude <span class="badge warn">${inbox.length}</span></h3>
    <ul class="clean">${inbox.map((x, i) => `<li class="row"><span class="grow small" style="word-break:break-all">${esc(x.url)}${x.note ? `<span class="sub muted">${esc(x.note)}</span>` : ''}</span><button class="btn ghost small" data-action="inbox-rm" data-i="${i}">×</button></li>`).join('')}</ul>
    <button class="btn block" data-action="inbox-copy" style="margin-top:10px">Copy the list for Claude</button>
    <p class="small muted">Paste it into a Claude chat. The recipes get priced, added here and pushed to your phone.</p></div>` : '';
  return `<h1>Recipes</h1>
  <div class="row" style="margin-bottom:12px"><button class="btn grow" data-action="add-link">+ From an Instagram link</button><button class="btn ghost" data-action="add-recipe">Type one in</button></div>
  ${inboxHtml}
  <input class="search" placeholder="Search ${REC().length} recipes" value="${esc(S.search || '')}" data-search>
  <div class="card">${list || '<p class="muted">No matches.</p>'}</div>`;
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
  return `<h3>${esc(r.name)}</h3><p class="small muted">${P.proteinPerPortion(r, ing)}g protein · ~£${c.cost.toFixed(2)} a portion${c.unpriced.length ? ` (excl. ${c.unpriced.join(', ')})` : ''} · ${r.slots.join(' or ')} · ${r.cookMinutes ? r.cookMinutes + ' min' : 'no batch cook'} · ${r.cold ? 'cold ok' : 'eat hot'} · ${r.freezer ? 'freezes' : r.fridgeDays ? `fridge ${r.fridgeDays} days, no freezer` : 'make fresh'}</p>
  <h2>Per portion</h2><div class="ing-list">${ings}</div>
  <h2>Method</h2><ol class="steps">${r.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
  ${r.notes ? `<p class="small muted">${esc(r.notes)}</p>` : ''}
  ${r.source && r.source.startsWith('http') ? `<p class="small"><a href="${esc(r.source)}" target="_blank" rel="noopener">Source reel</a></p>` : ''}
  <div class="row" style="margin-top:12px"><button class="btn grow" data-action="add-portion" data-id="${r.id}">Add to ${weekLabel(S.activeWeek).toLowerCase()}</button>${custom ? `<button class="btn danger" data-action="delete-recipe" data-id="${r.id}">Delete</button>` : ''}</div>`;
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
function renderPantry() {
  const groups = {};
  for (const it of ING()) if (!it.hidden) (groups[it.category] ||= []).push(it);
  const order = ['protein', 'dairy', 'carb', 'veg', 'fruit', 'tin', 'sauce', 'spice', 'cupboard'];
  const row = (it) => { const v = S.pantry[it.id]; const on = v === true || typeof v === 'number';
    return `<div class="check"><input type="checkbox" data-pantry="${it.id}" ${on ? 'checked' : ''}><span class="grow">${esc(it.name)}${(it.packs || []).length ? '' : '<span class="sub">no price on file</span>'}</span>${on && !it.staple ? `<input class="qty" type="number" step="any" placeholder="plenty" data-pantry-qty="${it.id}" value="${typeof v === 'number' ? v : ''}"><span class="small muted">${it.unit === 'each' ? '' : it.unit}</span>` : ''}</div>`; };
  const html = order.filter((g) => groups[g]).map((g) => `<h2>${g}</h2><div class="card">${groups[g].map(row).join('')}</div>`).join('');
  return `<h1>Pantry</h1><p class="small muted">Tick what you already have. Leave the amount blank for "plenty", or type how much (grams, ml or a count) and the shop list buys only the difference.</p>
  <div class="row" style="margin-bottom:12px"><button class="btn grow" data-action="load-stock">Load my stock (${DATA.stockDate || 'last check'})</button><button class="btn ghost" data-action="clear-pantry">Untick all</button></div>${html}
  <h2>Settings</h2><div class="card">
    <label class="field">Protein target per day (g)<input type="number" data-setting="proteinTarget" value="${S.settings.proteinTarget}"></label>
    <label class="field">Daily snack protein counted (g), e.g. one scoop<input type="number" data-setting="snackProtein" value="${S.settings.snackProtein}"></label>
    <label class="field">Weekly food budget (£)<input type="number" data-setting="budget" value="${S.settings.budget}"></label>
    <label class="check"><input type="checkbox" data-setting-bool="preferThigh" ${S.settings.preferThigh ? 'checked' : ''}><span>Buy boneless thigh fillets instead of breast<span class="sub">Swaps every breast line on the shop list for thigh fillets. Breast is currently the cheaper per kilo at all four shops.</span></span></label></div>
  <h2>Backup</h2><div class="card"><div class="row"><button class="btn ghost grow" data-action="export">Copy backup</button><button class="btn ghost grow" data-action="import">Paste backup</button></div>
  <button class="btn danger block" data-action="reset" style="margin-top:10px">Reset everything</button></div>
  <p class="small muted" style="text-align:center">Fuel ${APP_VERSION} · prices checked ${DATA.priceDate || ''}</p>`;
}

// ---------- sheet ----------
function openSheet(html) { const s = document.getElementById('sheet'); document.getElementById('sheet-inner').innerHTML = html; s.hidden = false; }
function closeSheet() { document.getElementById('sheet').hidden = true; }
document.getElementById('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); else onAction(e); });
document.getElementById('sheet').addEventListener('submit', onSubmit);
document.getElementById('sheet').addEventListener('change', (e) => { const chip = e.target.closest('.chip'); if (chip && e.target.type === 'checkbox') chip.classList.toggle('on', e.target.checked); });

// ---------- drag and drop between grid cells ----------
const drag = { src: null, ghost: null, over: null, active: false, x: 0, y: 0, moved: false };
function onDragStart(e) {
  const cell = e.target.closest('.cell'); if (!cell || cell.classList.contains('empty') || e.button > 0 || drag.src) return;
  drag.src = cell; drag.x = e.clientX; drag.y = e.clientY; drag.active = false; drag.moved = false;
  try { cell.setPointerCapture(e.pointerId); } catch {}
  cell.addEventListener('pointermove', onDragMove); cell.addEventListener('pointerup', onDragEnd); cell.addEventListener('pointercancel', onDragEnd);
}
function onDragMove(e) {
  if (!drag.src) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.active) { if (Math.hypot(dx, dy) < 8) return; drag.active = true; drag.moved = true; startGhost(e); }
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
function onDragEnd(e) {
  const src = drag.src; if (!src) return;
  src.removeEventListener('pointermove', onDragMove); src.removeEventListener('pointerup', onDragEnd); src.removeEventListener('pointercancel', onDragEnd);
  const target = drag.over; const wasActive = drag.active;
  document.querySelectorAll('.ghost').forEach((x) => x.remove()); drag.over?.classList.remove('over'); src.classList.remove('lifted');
  drag.src = null; drag.ghost = null; drag.over = null; drag.active = false;
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
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action, id = el.dataset.id; const w = W();
  if (a === 'inc' || a === 'dec') {
    if (a === 'inc' && P.roomFor(recById(id), P.freeSlots(w.grid, w.days)) <= 0) return;
    w.portions[id] = Math.max(0, (w.portions[id] || 0) + (a === 'inc' ? 1 : -1));
    if (!w.portions[id]) delete w.portions[id];
    relayout(); render();
  } else if (a === 'week') { S.activeWeek = el.dataset.week; save(); render(); }
  else if (a === 'cookday') { w.cookDay = +el.dataset.day; relayout(); render(); }
  else if (a === 'relayout') { relayout(); render(); }
  else if (a === 'dayx') { const i = +el.dataset.day; w.days[i] = !w.days[i]; relayout(w); render(); }
  else if (a === 'need') { delete S.pantry[id]; save(); render(); }
  else if (a === 'clear-pantry') { if (confirm('Untick everything in the pantry? The shop list will then include every ingredient for the week.')) { S.pantry = {}; save(); render(); } }
  else if (a === 'load-stock') { if (!DATA.stock) { alert('No stock file loaded.'); return; } if (confirm(`Tick everything from the ${DATA.stockDate} stock check? Items you have already ticked are kept.`)) { for (const [id, v] of Object.entries(DATA.stock)) if (S.pantry[id] === undefined) S.pantry[id] = v; save(); render(); } }
  else if (a === 'clear-week') { if (confirm(`Clear every meal from ${weekLabel(S.activeWeek).toLowerCase()}?`)) { w.portions = {}; w.ticks = {}; relayout(); render(); } }
  else if (a === 'cell') {
    const day = +el.dataset.day, slot = el.dataset.slot;
    const planned = Object.keys(w.portions).map(recById).filter(Boolean);
    const others = REC().filter((r) => !w.portions[r.id]);
    const opt = (r) => `<option value="${r.id}" ${w.grid[day][slot] === r.id ? 'selected' : ''}>${esc(r.name)}</option>`;
    openSheet(`<h3>${P.DAYS[day]} ${slot}</h3><label class="field">Meal<select id="cell-pick"><option value="">— empty —</option><optgroup label="Picked this week">${planned.map(opt).join('')}</optgroup><optgroup label="Everything else">${others.map(opt).join('')}</optgroup></select></label><button class="btn block" data-action="cell-set" data-day="${day}" data-slot="${slot}">Set</button>`);
  } else if (a === 'cell-set') {
    const day = +el.dataset.day, slot = el.dataset.slot, val = document.getElementById('cell-pick').value || null;
    w.grid[day][slot] = val; portionsFromGrid(); closeSheet(); render();
  } else if (a === 'open-recipe') { const r = recById(id); if (r) openSheet(recipeDetail(r)); }
  else if (a === 'add-portion') { w.portions[id] = (w.portions[id] || 0) + 1; relayout(); closeSheet(); S.tab = 'plan'; render({ top: true }); }
  else if (a === 'delete-recipe') { if (confirm('Delete this recipe?')) { S.customRecipes = S.customRecipes.filter((r) => r.id !== id); for (const wk of Object.values(S.weeks)) { delete wk.portions[id]; relayout(wk); } closeSheet(); render(); } }
  else if (a === 'add-recipe') { openSheet(recipeForm()); addIngRow(); }
  else if (a === 'add-link') openSheet(linkForm());
  else if (a === 'inbox-rm') { S.inbox.splice(+el.dataset.i, 1); save(); render(); }
  else if (a === 'inbox-copy') {
    const txt = 'Please add these to Fuel as priced recipes:\n' + S.inbox.map((x) => `- ${x.url}${x.note ? ` (${x.note})` : ''}`).join('\n');
    (navigator.clipboard?.writeText(txt) || Promise.reject()).then(() => alert('Copied. Paste it to Claude.'), () => prompt('Copy this:', txt));
  }
  else if (a === 'add-ing-row') addIngRow();
  else if (a === 'rm-row') el.closest('.ing-row').remove();
  else if (a === 'new-ingredient') openSheet(newIngredientForm());
  else if (a === 'export') {
    const txt = JSON.stringify({ weeks: S.weeks, activeWeek: S.activeWeek, pantry: S.pantry, customRecipes: S.customRecipes, customIngredients: S.customIngredients, settings: S.settings, inbox: S.inbox });
    (navigator.clipboard?.writeText(txt) || Promise.reject()).then(() => alert('Backup copied to the clipboard. Paste it somewhere safe.'), () => prompt('Copy this:', txt));
  } else if (a === 'import') {
    const txt = prompt('Paste your backup'); if (!txt) return;
    try { Object.assign(S, JSON.parse(txt)); setupWeeks(); render(); } catch { alert('That did not look like a backup.'); }
  } else if (a === 'reset') { if (confirm('Wipe plans, pantry and your own recipes on this phone?')) { localStorage.removeItem(KEY); location.reload(); } }
}
function addIngRow() { const t = document.getElementById('ing-row-t'); document.getElementById('ing-rows').appendChild(t.content.cloneNode(true)); }
function onChange(e) {
  const t = e.target; const w = W();
  if (t.dataset.pick) {
    const r = recById(t.dataset.pick);
    const room = P.roomFor(r, P.freeSlots(w.grid, w.days));
    if (t.checked) { if (room <= 0) { t.checked = false; return; } w.portions[r.id] = Math.min(defaultPortions(r), room); } else delete w.portions[r.id];
    relayout(); render();
  }
  else if (t.dataset.tick) { w.ticks[t.dataset.tick] = t.checked; save(); t.closest('.line').classList.toggle('done', t.checked); }
  else if (t.dataset.choice) { w.choices[t.dataset.choice] = t.value; save(); render(); }
  else if (t.dataset.settingBool) { S.settings[t.dataset.settingBool] = t.checked; save(); render(); }
  else if (t.dataset.pantry) { if (t.checked) S.pantry[t.dataset.pantry] = true; else delete S.pantry[t.dataset.pantry]; save(); render(); }
  else if (t.dataset.pantryQty !== undefined) { const v = parseFloat(t.value); S.pantry[t.dataset.pantryQty] = Number.isFinite(v) && v > 0 ? v : true; save(); }
  else if (t.dataset.setting) { S.settings[t.dataset.setting] = +t.value || 0; save(); }
}
function onInput(e) {
  const t = e.target;
  if (t.dataset.search !== undefined) { S.search = t.value; refreshCard(renderRecipes); }
  else if (t.dataset.planSearch !== undefined) { S.planSearch = t.value; render(); const inp = document.querySelector('[data-plan-search]'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
}
function refreshCard(fn) { const v = document.getElementById('view'); const card = v.querySelector('.card'); if (card) { const tmp = document.createElement('div'); tmp.innerHTML = fn(); card.innerHTML = tmp.querySelector('.card').innerHTML; } }
function onSubmit(e) {
  e.preventDefault();
  const f = e.target; const fd = new FormData(f);
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
    const slots = fd.getAll('slot'); if (!slots.length) { alert('Pick at least one slot.'); return; }
    const ings = [...f.querySelectorAll('.ing-row')].map((r) => ({ id: r.querySelector('[name=ing]').value, qty: +r.querySelector('[name=qty]').value })).filter((x) => x.qty > 0);
    if (!ings.length) { alert('Add at least one ingredient.'); return; }
    const method = String(fd.get('method')).split('\n').map((s) => s.trim()).filter(Boolean);
    const r = { id, name, slots, cold: !!fd.get('cold'), reheat: fd.get('reheat'), fridgeDays: +fd.get('fridgeDays') || 0, freezer: !!fd.get('freezer'), cookMinutes: +fd.get('cookMinutes') || 0, equipment: [], source: fd.get('source') || 'yours', ingredients: ings, method, notes: '' };
    S.customRecipes = S.customRecipes.filter((x) => x.id !== id).concat([r]); save(); closeSheet(); render();
  }
}

boot();
