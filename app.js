import * as P from './planner.js';

const KEY = 'fuel:v1';
const DATA = { ingredients: [], recipes: [] };
const S = load();

function load() {
  const base = { tab: 'plan', cookDay: 0, portions: {}, grid: null, pantry: null, customRecipes: [], customIngredients: [], ticks: {}, settings: { proteinTarget: 180, snackProtein: 24, budget: 50 } };
  try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return base; }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }

const ING = () => DATA.ingredients.concat(S.customIngredients);
const REC = () => DATA.recipes.concat(S.customRecipes);
const ingById = (id) => ING().find((i) => i.id === id);
const recById = (id) => REC().find((r) => r.id === id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const cellStyle = (id) => `background:hsl(${hue(id)} 45% 24%);`;

// ---------- boot ----------
async function boot() {
  try {
    const [i, r] = await Promise.all([fetch('data/ingredients.json').then((x) => x.json()), fetch('data/recipes.json').then((x) => x.json())]);
    DATA.ingredients = i.items; DATA.recipes = r.items; DATA.priceNote = i.checkedNote;
  } catch (e) {
    document.getElementById('view').innerHTML = `<div class="bad-box">Couldn't load the recipe data. ${esc(e.message)}</div>`;
    return;
  }
  if (!S.pantry) { S.pantry = {}; for (const it of ING()) if (it.staple) S.pantry[it.id] = true; }
  ensureGrid();
  document.getElementById('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.tab; save(); render(); } });
  document.getElementById('view').addEventListener('click', onAction);
  document.getElementById('view').addEventListener('change', onChange);
  document.getElementById('view').addEventListener('input', onInput);
  document.getElementById('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function ensureGrid() {
  if (!S.grid) relayout();
}
function relayout() {
  const { grid, overflow } = P.autoLayout(S.portions, REC(), S.cookDay);
  S.grid = grid; S.overflow = overflow; save();
}
function portionsFromGrid() {
  const counts = {};
  for (const d of S.grid) for (const s of P.SLOTS) if (d[s]) counts[d[s]] = (counts[d[s]] || 0) + 1;
  S.portions = counts; S.overflow = []; save();
}

// ---------- render ----------
function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  const v = document.getElementById('view');
  v.innerHTML = ({ plan: renderPlan, cook: renderCook, shop: renderShop, recipes: renderRecipes, pantry: renderPantry })[S.tab]();
  window.scrollTo(0, 0);
}

// ----- Plan -----
function renderPlan() {
  const recipes = REC(), ing = ING();
  const st = P.gridStats(S.grid, recipes, ing, S.settings.snackProtein);
  const target = S.settings.proteinTarget;
  const max = Math.max(target * 1.2, ...st.perDay);
  const bars = st.perDay.map((p, i) => `<div class="bar ${p < target ? 'low' : ''}"><b>${p}</b><i style="height:${Math.round((p / max) * 100)}%"></i></div>`).join('');
  const bySlot = (slot) => recipes.filter((r) => r.slots[0] === slot);
  const row = (r) => {
    const n = S.portions[r.id] || 0;
    const pp = P.proteinPerPortion(r, ing);
    const flex = r.slots.length > 1 ? `<span class="badge">${r.slots.join(' or ')}</span>` : '';
    const cold = r.cold ? '<span class="badge ok">cold ok</span>' : '';
    const fz = r.freezer ? '<span class="badge">freezes</span>' : (r.fridgeDays ? `<span class="badge warn">fridge ${r.fridgeDays}d</span>` : '<span class="badge">cook fresh</span>');
    return `<div class="recipe-row"><div class="grow"><div class="name">${esc(r.name)}</div><div class="meta">${pp}g protein ${flex}${cold}${fz}</div></div>
      <div class="stepper ${n ? '' : 'zero'}"><button data-action="dec" data-id="${r.id}">−</button><b>${n}</b><button data-action="inc" data-id="${r.id}">+</button></div></div>`;
  };
  const late = lateWarnings();
  const overflow = (S.overflow || []).map((o) => `<div class="warn-box">${esc(recById(o.id)?.name)}: ${o.unplaced} portion${o.unplaced > 1 ? 's' : ''} won't fit in the week. Drop the count or move something.</div>`).join('');
  const gridHtml = `<div class="grid"><div></div>${P.DAYS.map((d) => `<div class="hd">${d}</div>`).join('')}
    ${P.SLOTS.map((s) => `<div class="lbl">${({ breakfast: 'Bfast', lunch: 'Lunch', dinner: 'Dinner' })[s]}</div>` + S.grid.map((d, i) => {
      const id = d[s]; const r = id && recById(id);
      if (!r) return `<button class="cell empty" data-action="cell" data-day="${i}" data-slot="${s}">+</button>`;
      const tp = P.tubPlan(r, S.grid, S.cookDay);
      const cls = tp.fresh ? '' : tp.freezer.includes(i) ? 'frozen' : tp.late.includes(i) ? 'late' : '';
      return `<button class="cell ${cls}" style="${cellStyle(id)}" data-action="cell" data-day="${i}" data-slot="${s}">${esc(shortName(r.name))}</button>`;
    }).join('')).join('')}</div>`;
  return `<h1>This week</h1>
  <div class="card"><div class="stat-grid"><div class="stat"><b>${st.filled}<span style="font-size:13px;color:var(--muted)">/21</span></b><span>meal slots filled</span></div><div class="stat"><b>${st.distinct}</b><span>different meals</span></div><div class="stat"><b>${st.avg}g</b><span>avg protein/day</span></div></div>
    <div class="bars" style="margin-top:26px">${bars}</div><div class="bars-labels">${P.DAYS.map((d) => `<div>${d}</div>`).join('')}</div>
    <p class="small muted">Target ${target}g a day, including a ${S.settings.snackProtein}g snack. Amber days are under.</p></div>
  <h2>Week grid</h2>
  <div class="card">${gridHtml}
    <p class="small muted" style="margin-top:10px">Tap a cell to swap or clear it. ❄ = from the freezer that day, thaw the night before. Amber outline = past its fridge life and it can't be frozen.</p>
    <div class="row" style="margin-top:8px"><span class="small muted grow">Cook day</span></div>
    <div class="day-pick">${P.DAYS.map((d, i) => `<button data-action="cookday" data-day="${i}" class="${S.cookDay === i ? 'on' : ''}">${d}</button>`).join('')}</div>
    <button class="btn ghost small" data-action="relayout">Re-lay out the week</button></div>
  ${overflow}${late}
  <h2>Breakfasts</h2><div class="card">${bySlot('breakfast').map(row).join('')}</div>
  <h2>Lunches</h2><div class="card">${bySlot('lunch').map(row).join('')}</div>
  <h2>Dinners</h2><div class="card">${bySlot('dinner').map(row).join('')}</div>`;
}
function shortName(n) { return n.length > 26 ? n.slice(0, 24) + '…' : n; }
function lateWarnings() {
  const out = [];
  for (const [rid, n] of Object.entries(S.portions)) {
    const r = recById(rid); if (!r || !n || r.cookMinutes === 0) continue;
    const tp = P.tubPlan(r, S.grid, S.cookDay);
    if (tp.late.length) out.push(`<div class="warn-box"><b>${esc(r.name)}</b> keeps ${r.fridgeDays} day${r.fridgeDays === 1 ? '' : 's'} and can't be frozen, so the ${tp.late.map((d) => P.DAYS[d]).join(', ')} portion${tp.late.length > 1 ? 's need' : ' needs'} a second cook midweek. Move ${tp.late.length > 1 ? 'them' : 'it'} earlier or swap for a freezer recipe.</div>`);
  }
  return out.join('');
}

// ----- Cook -----
function renderCook() {
  const recipes = REC(), ing = ING();
  const rs = P.runSheet(S.portions, recipes);
  const fresh = Object.entries(S.portions).filter(([rid, n]) => n > 0 && recById(rid)?.cookMinutes === 0).map(([rid, n]) => ({ recipe: recById(rid), portions: n }));
  if (!rs.list.length && !fresh.length) return `<h1>Cook</h1><div class="card"><p>Nothing planned yet. Add portions on the Plan tab.</p></div>`;
  const cookDay = P.DAYS[S.cookDay];
  const sheet = rs.list.map((x, i) => `<li><b>${i + 1}. ${esc(x.recipe.name)}</b> × ${x.portions} <span class="muted small">· ${x.recipe.cookMinutes} min · ${x.recipe.equipment.join(', ')}</span></li>`).join('');
  const freshList = fresh.map((x) => `<li><b>${esc(x.recipe.name)}</b> × ${x.portions} <span class="muted small">· made fresh, ${x.recipe.slots[0]}</span></li>`).join('');
  const cards = rs.list.map(({ recipe: r, portions: n }) => {
    const scaled = P.scaleIngredients(r, n, ing);
    const tp = P.tubPlan(r, S.grid, S.cookDay);
    const fridgeDays = tp.fridge.map((d) => P.DAYS[d]).join(', ');
    const freezerDays = tp.freezer.map((d) => P.DAYS[d]).join(', ');
    const lateDays = tp.late.map((d) => P.DAYS[d]).join(', ');
    const reheat = { none: 'Eat cold', microwave: 'Microwave 2–3 min, stir halfway', hob: 'Reheat in a pan', 'air-fryer': 'Air-fryer 6 min at 180°C' }[r.reheat] || '';
    return `<div class="card"><h3>${esc(r.name)} <span class="muted">× ${n}</span></h3>
      <p class="small muted">${P.proteinPerPortion(r, ing)}g protein a portion · ${r.cookMinutes} min · ${r.equipment.join(', ')}</p>
      <div class="ing-list">${scaled.map((s) => `<span>${esc(s.name)}</span><b>${P.fmtQty(s.qty, s.unit)}</b>`).join('')}</div>
      <ol class="steps">${r.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
      ${r.notes ? `<p class="small muted">${esc(r.notes)}</p>` : ''}
      <div class="tub"><div><b>${tp.total}</b><span>tubs</span></div><div><b>${tp.fridge.length}</b><span>fridge${tp.fridge.length ? `<br>eat by ${tp.eatBy}` : ''}</span></div><div><b>${tp.freezer.length}</b><span>freezer${tp.freezer.length ? '<br>thaw night before' : ''}</span></div></div>
      <p class="small" style="margin-top:8px">${tp.fridge.length ? `Fridge tubs for ${fridgeDays}. ` : ''}${tp.freezer.length ? `Freezer tubs for ${freezerDays}. ` : ''}${reheat}.</p>
      ${tp.late.length ? `<div class="warn-box">${lateDays}: past fridge life and not freezable. Cook ${tp.late.length} portion${tp.late.length > 1 ? 's' : ''} fresh that week, or move ${tp.late.length > 1 ? 'them' : 'it'} earlier on the Plan tab.</div>` : ''}
      ${tp.total < n ? `<p class="small muted">${n - tp.total} portion${n - tp.total > 1 ? 's' : ''} not on the grid.</p>` : ''}
    </div>`;
  }).join('');
  return `<h1>Cook on ${cookDay}</h1>
  <div class="card"><h3>Run sheet</h3><p class="small muted">Longest cook first. Start the oven or air-fryer items, then run the hob ones alongside. About ${rs.minutes} minutes of cooking if done back to back; less when they overlap.</p><ol class="steps">${sheet}</ol>
  ${fresh.length ? `<hr><p class="small muted">Made on the day, not batched:</p><ul class="clean">${freshList}</ul>` : ''}
  <p class="small muted" style="margin-top:8px">Rice rule: cooked rice goes in the freezer the same day unless it's eaten within 24 hours.</p></div>
  ${cards}`;
}

// ----- Shop -----
function renderShop() {
  const ing = ING(), recipes = REC();
  const needsAll = P.aggregateNeeds(S.portions, recipes);
  const needs = P.netPantry(needsAll, S.pantry);
  if (!Object.keys(needsAll).length) return `<h1>Shop</h1><div class="card"><p>Nothing planned yet. Add portions on the Plan tab.</p></div>`;
  const ranked = P.compareShops(needs, ing);
  const split = P.cheapestSplit(needs, ing);
  const best = ranked[0];
  const budget = S.settings.budget;
  const pct = Math.min(100, Math.round((best.total / budget) * 100));
  const shopCard = (b, open) => {
    const lines = b.lines.map((l) => {
      const k = `${b.shop}:${l.id}`; const done = !!S.ticks[k];
      return `<label class="line ${done ? 'done' : ''}"><input type="checkbox" data-tick="${k}" ${done ? 'checked' : ''}><span class="grow"><span class="name">${l.n > 1 ? `${l.n} × ` : ''}${esc(l.pack.name)}</span><span class="sub">need ${P.fmtQty(P.round1(l.need), l.unit)} of ${esc(l.name)}</span></span><span class="cost">${P.gbp(l.cost)}</span></label>`;
    }).join('');
    const missing = b.missing.length ? `<div class="warn-box">No ${P.SHOP_NAMES[b.shop]} price on file for: ${b.missing.map((m) => esc(m.name)).join(', ')}. ${b.shop === 'lidl' ? 'Lidl publishes nothing online; a shelf photo fixes this.' : 'Tell Claude and it gets added.'}</div>` : '';
    return `<details class="shop-card ${b === best ? 'best' : ''}" ${open ? 'open' : ''}><summary><span><b>${P.SHOP_NAMES[b.shop]}</b>${b === best ? ' <span class="badge ok">cheapest</span>' : ''}${b.missing.length ? ` <span class="badge warn">${b.missing.length} unpriced</span>` : ''}</span><span class="total">${P.gbp(b.total)}</span></summary>${missing}<div>${lines}</div></details>`;
  };
  const splitHtml = split ? `<div class="card"><h3>Two shops saves ${P.gbp(split.saving)}</h3><p class="small muted">${P.SHOP_NAMES[split.shops[0]]} + ${P.SHOP_NAMES[split.shops[1]]} = ${P.gbp(split.total)} against ${P.gbp(best.total)} at ${P.SHOP_NAMES[best.shop]}. Only worth it if you're passing both.</p>
    ${split.baskets.map((b) => `<p class="small"><b>${P.SHOP_NAMES[b.shop]}</b> ${P.gbp(b.total)}: ${b.lines.map((l) => esc(l.name)).join(', ')}</p>`).join('')}</div>` : '';
  const unpricedAll = Object.keys(needs).filter((id) => !(ingById(id)?.packs || []).length).map((id) => ingById(id)?.name);
  const have = Object.keys(needsAll).filter((id) => S.pantry[id]).map((id) => esc(ingById(id)?.name || id));
  const oldest = ranked.map((b) => b.oldest).filter(Boolean).sort()[0];
  return `<h1>Shop</h1>
  <div class="card"><div class="row"><span class="grow"><b>${P.gbp(best.total)}</b> at ${P.SHOP_NAMES[best.shop]}</span><span class="muted small">budget ${P.gbp(budget)}</span></div>
    <div class="budget ${best.total > budget ? 'over' : ''}"><i style="width:${pct}%"></i></div>
    <p class="small muted">${best.total > budget ? `Over budget by ${P.gbp(best.total - budget)}. Drop a portion or two of the priciest recipe.` : `${P.gbp(budget - best.total)} left for coffees.`} Prices checked ${oldest || 'n/a'}.</p></div>
  ${splitHtml}
  <h2>By shop</h2><div class="shop-rank">${ranked.map((b, i) => shopCard(b, i === 0)).join('')}</div>
  ${unpricedAll.length ? `<div class="card" style="margin-top:10px"><h3>No price anywhere yet</h3><p class="small muted">${unpricedAll.map(esc).join(', ')}. These are excluded from the totals until priced. Sesame oil, sriracha, honey and the pastes are tiny per-portion costs; they're in the pantry list to tick off.</p></div>` : ''}
  ${have.length ? `<div class="card flat"><p class="small muted">Already in the pantry, not on the list: ${have.join(', ')}.</p></div>` : ''}
  <p class="small muted">${esc(DATA.priceNote || '')}</p>`;
}

// ----- Recipes -----
function renderRecipes() {
  const q = (S.search || '').toLowerCase();
  const ing = ING();
  const list = REC().filter((r) => !q || r.name.toLowerCase().includes(q)).map((r) => `<div class="recipe-row" data-action="open-recipe" data-id="${r.id}"><div class="grow"><div class="name">${esc(r.name)}</div><div class="meta">${P.proteinPerPortion(r, ing)}g protein · ${r.slots.join(' / ')}${r.cold ? ' · cold ok' : ''}${r.freezer ? ' · freezes' : ''}${S.customRecipes.some((c) => c.id === r.id) ? ' · yours' : ''}</div></div><span class="muted">›</span></div>`).join('');
  return `<h1>Recipes</h1><input class="search" placeholder="Search" value="${esc(S.search || '')}" data-search>
  <button class="btn block" data-action="add-recipe" style="margin-bottom:12px">+ Add a recipe</button>
  <div class="card">${list || '<p class="muted">No matches.</p>'}</div>`;
}
function recipeDetail(r) {
  const ing = ING();
  const custom = S.customRecipes.some((c) => c.id === r.id);
  const ings = P.scaleIngredients(r, 1, ing).map((s) => `<span>${esc(s.name)}</span><b>${P.fmtQty(s.qty, s.unit)}</b>`).join('');
  return `<h3>${esc(r.name)}</h3><p class="small muted">${P.proteinPerPortion(r, ing)}g protein a portion · ${r.slots.join(' or ')} · ${r.cookMinutes ? r.cookMinutes + ' min' : 'no batch cook'} · ${r.cold ? 'cold ok' : 'eat hot'} · ${r.freezer ? 'freezes' : r.fridgeDays ? `fridge ${r.fridgeDays} days, no freezer` : 'make fresh'}</p>
  <h2>Per portion</h2><div class="ing-list">${ings}</div>
  <h2>Method</h2><ol class="steps">${r.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
  ${r.notes ? `<p class="small muted">${esc(r.notes)}</p>` : ''}
  ${r.source && r.source.startsWith('http') ? `<p class="small"><a href="${esc(r.source)}" target="_blank" rel="noopener" style="color:var(--accent)">Source reel</a></p>` : ''}
  <div class="row" style="margin-top:12px"><button class="btn grow" data-action="add-portion" data-id="${r.id}">Add to this week</button>${custom ? `<button class="btn danger" data-action="delete-recipe" data-id="${r.id}">Delete</button>` : ''}</div>`;
}
function recipeForm() {
  const opts = ING().map((i) => `<option value="${i.id}">${esc(i.name)} (${i.unit})</option>`).join('');
  return `<h3>Add a recipe</h3><form id="recipe-form">
  <label class="field">Name<input name="name" required></label>
  <div class="small muted">Slots</div><div class="chip-row">${P.SLOTS.map((s) => `<label class="chip"><input type="checkbox" name="slot" value="${s}" hidden>${s}</label>`).join('')}</div>
  <div class="row"><label class="field grow">Fridge days<input name="fridgeDays" type="number" min="0" max="7" value="3"></label><label class="field grow">Batch cook minutes<input name="cookMinutes" type="number" min="0" value="30"></label></div>
  <div class="chip-row"><label class="chip"><input type="checkbox" name="cold" hidden>ok cold</label><label class="chip"><input type="checkbox" name="freezer" hidden checked>freezes</label></div>
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
  for (const it of ING()) (groups[it.category] ||= []).push(it);
  const order = ['protein', 'dairy', 'carb', 'veg', 'fruit', 'tin', 'sauce', 'spice', 'cupboard'];
  const html = order.filter((g) => groups[g]).map((g) => `<h2>${g}</h2><div class="card">${groups[g].map((it) => `<label class="check"><input type="checkbox" data-pantry="${it.id}" ${S.pantry[it.id] ? 'checked' : ''}><span>${esc(it.name)}${(it.packs || []).length ? '' : '<span class="sub">no price on file</span>'}</span></label>`).join('')}</div>`).join('');
  return `<h1>Pantry</h1><p class="small muted">Tick what you already have. Ticked items are left off the shopping list. Staples come pre-ticked.</p>${html}
  <h2>Settings</h2><div class="card">
    <label class="field">Protein target per day (g)<input type="number" data-setting="proteinTarget" value="${S.settings.proteinTarget}"></label>
    <label class="field">Daily snack protein counted (g), e.g. one scoop<input type="number" data-setting="snackProtein" value="${S.settings.snackProtein}"></label>
    <label class="field">Weekly food budget (£)<input type="number" data-setting="budget" value="${S.settings.budget}"></label></div>
  <h2>Backup</h2><div class="card"><div class="row"><button class="btn ghost grow" data-action="export">Copy backup</button><button class="btn ghost grow" data-action="import">Paste backup</button></div>
  <button class="btn danger block" data-action="reset" style="margin-top:10px">Reset everything</button></div>`;
}

// ---------- sheet ----------
function openSheet(html) { const s = document.getElementById('sheet'); document.getElementById('sheet-inner').innerHTML = html; s.hidden = false; }
function closeSheet() { document.getElementById('sheet').hidden = true; }
document.getElementById('sheet').addEventListener('click', onAction);
document.getElementById('sheet').addEventListener('submit', onSubmit);
document.getElementById('sheet').addEventListener('change', (e) => { const chip = e.target.closest('.chip'); if (chip && e.target.type === 'checkbox') chip.classList.toggle('on', e.target.checked); });

// ---------- events ----------
function onAction(e) {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action, id = el.dataset.id;
  if (a === 'inc' || a === 'dec') {
    S.portions[id] = Math.max(0, (S.portions[id] || 0) + (a === 'inc' ? 1 : -1));
    if (!S.portions[id]) delete S.portions[id];
    relayout(); render();
  } else if (a === 'cookday') { S.cookDay = +el.dataset.day; relayout(); render(); }
  else if (a === 'relayout') { relayout(); render(); }
  else if (a === 'cell') {
    const day = +el.dataset.day, slot = el.dataset.slot;
    const planned = Object.keys(S.portions).map(recById).filter(Boolean);
    const others = REC().filter((r) => !S.portions[r.id]);
    const opt = (r) => `<option value="${r.id}" ${S.grid[day][slot] === r.id ? 'selected' : ''}>${esc(r.name)}</option>`;
    openSheet(`<h3>${P.DAYS[day]} ${slot}</h3><label class="field">Meal<select id="cell-pick"><option value="">— empty —</option><optgroup label="Planned this week">${planned.map(opt).join('')}</optgroup><optgroup label="Everything else">${others.map(opt).join('')}</optgroup></select></label><button class="btn block" data-action="cell-set" data-day="${day}" data-slot="${slot}">Set</button>`);
  } else if (a === 'cell-set') {
    const day = +el.dataset.day, slot = el.dataset.slot, val = document.getElementById('cell-pick').value || null;
    S.grid[day][slot] = val; portionsFromGrid(); closeSheet(); render();
  } else if (a === 'open-recipe') { const r = recById(id); if (r) openSheet(recipeDetail(r)); }
  else if (a === 'add-portion') { S.portions[id] = (S.portions[id] || 0) + 1; relayout(); closeSheet(); S.tab = 'plan'; render(); }
  else if (a === 'delete-recipe') { if (confirm('Delete this recipe?')) { S.customRecipes = S.customRecipes.filter((r) => r.id !== id); delete S.portions[id]; relayout(); closeSheet(); render(); } }
  else if (a === 'add-recipe') { openSheet(recipeForm()); addIngRow(); }
  else if (a === 'add-ing-row') addIngRow();
  else if (a === 'rm-row') el.closest('.ing-row').remove();
  else if (a === 'new-ingredient') openSheet(newIngredientForm());
  else if (a === 'export') {
    const txt = JSON.stringify({ portions: S.portions, grid: S.grid, pantry: S.pantry, customRecipes: S.customRecipes, customIngredients: S.customIngredients, settings: S.settings, cookDay: S.cookDay });
    (navigator.clipboard?.writeText(txt) || Promise.reject()).then(() => alert('Backup copied to the clipboard. Paste it somewhere safe.'), () => prompt('Copy this:', txt));
  } else if (a === 'import') {
    const txt = prompt('Paste your backup'); if (!txt) return;
    try { Object.assign(S, JSON.parse(txt)); save(); render(); } catch { alert('That did not look like a backup.'); }
  } else if (a === 'reset') { if (confirm('Wipe plan, pantry and your own recipes on this phone?')) { localStorage.removeItem(KEY); location.reload(); } }
}
function addIngRow() { const t = document.getElementById('ing-row-t'); document.getElementById('ing-rows').appendChild(t.content.cloneNode(true)); }
function onChange(e) {
  const t = e.target;
  if (t.dataset.tick) { S.ticks[t.dataset.tick] = t.checked; save(); t.closest('.line').classList.toggle('done', t.checked); }
  else if (t.dataset.pantry) { if (t.checked) S.pantry[t.dataset.pantry] = true; else delete S.pantry[t.dataset.pantry]; save(); }
  else if (t.dataset.setting) { S.settings[t.dataset.setting] = +t.value || 0; save(); }
}
function onInput(e) { if (e.target.dataset.search !== undefined) { S.search = e.target.value; const v = document.getElementById('view'); const card = v.querySelector('.card'); if (card) { const tmp = document.createElement('div'); tmp.innerHTML = renderRecipes(); card.innerHTML = tmp.querySelector('.card').innerHTML; } } }
function onSubmit(e) {
  e.preventDefault();
  const f = e.target; const fd = new FormData(f);
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
