// Pure planning logic. No DOM, no storage. Unit-tested in tests/planner.test.mjs.

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const SLOTS = ['breakfast', 'lunch', 'dinner'];
export const SHOPS = ['aldi', 'lidl', 'asda', 'tesco', 'sainsburys'];
export const SHOP_NAMES = { aldi: 'Aldi', lidl: 'Lidl', asda: 'ASDA', tesco: 'Tesco', sainsburys: "Sainsbury's", any: 'Any shop' };

const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));

// ---------- nutrition ----------
export function proteinPerPortion(recipe, ingredients) {
  const ing = byId(ingredients);
  let p = 0;
  for (const { id, qty } of recipe.ingredients) {
    const it = ing[id];
    if (!it) continue;
    p += it.unit === 'each' ? it.protein * qty : (it.protein * qty) / 100;
  }
  return Math.round(p);
}

// Cheapest per-unit price across all packs at any shop; null if unpriced.
export function unitPrice(item) {
  let best = null;
  for (const p of item.packs || []) { const u = p.price / p.size; if (best === null || u < best) best = u; }
  return best;
}

// Estimated ingredient cost of one portion at the cheapest listed prices. `unpriced` lists ingredients with no price.
export function costPerPortion(recipe, ingredients) {
  const ing = byId(ingredients);
  let cost = 0; const unpriced = [];
  for (const { id, qty } of recipe.ingredients) {
    const it = ing[id]; if (!it) continue;
    const u = unitPrice(it);
    if (u === null) unpriced.push(it.name); else cost += u * qty;
  }
  return { cost: round2(cost), unpriced };
}

// ---------- needs ----------
// `resolve` maps an ingredient id to what will actually be bought (a chosen fruit, thighs for breast).
export function aggregateNeeds(portions, recipes, resolve = (id) => id) {
  const rec = byId(recipes);
  const needs = {};
  for (const [rid, n] of Object.entries(portions)) {
    const r = rec[rid];
    if (!r || n <= 0) continue;
    for (const { id, qty } of r.ingredients) { const t = resolve(id); needs[t] = (needs[t] || 0) + qty * n; }
  }
  return needs;
}

// Empty cells per slot on enabled days.
export function freeSlots(grid, days = [true, true, true, true, true, true, true]) {
  const free = { breakfast: 0, lunch: 0, dinner: 0 };
  grid.forEach((d, i) => { if (days[i]) for (const s of SLOTS) if (!d[s]) free[s] += 1; });
  return free;
}
export const roomFor = (recipe, free) => recipe.slots.reduce((n, s) => n + free[s], 0);

// pantry[id] === true means "plenty"; a number means that much on hand (in the ingredient's unit).
export function netPantry(needs, pantry) {
  const out = {};
  for (const [id, q] of Object.entries(needs)) {
    const have = pantry[id];
    if (have === true) continue;
    const left = typeof have === 'number' ? q - have : q;
    if (left > 1e-9) out[id] = round1(left);
  }
  return out;
}

// Portions actually on the grid (what will be eaten), per recipe.
export function gridCounts(grid) {
  const counts = {};
  for (const d of grid) for (const s of SLOTS) if (d[s]) counts[d[s]] = (counts[d[s]] || 0) + 1;
  return counts;
}

export const packsFor = (need, size) => Math.max(1, Math.ceil(need / size - 1e-9));

function packsAvailable(item, shop) {
  return (item.packs || []).filter((p) => p.shop === shop || p.shop === 'any');
}

// Cheapest way to cover `need` at one shop: pick the pack with the lowest total cost.
function bestPack(item, shop, need) {
  let best = null;
  for (const p of packsAvailable(item, shop)) {
    const n = packsFor(need, p.size);
    const cost = n * p.price;
    if (!best || cost < best.cost - 1e-9) best = { pack: p, n, cost };
  }
  return best;
}

export function basketAt(shop, needs, ingredients) {
  const ing = byId(ingredients);
  const lines = [];
  const missing = [];
  let total = 0;
  let oldest = null;
  for (const [id, need] of Object.entries(needs)) {
    const item = ing[id];
    if (!item) continue;
    const b = bestPack(item, shop, need);
    if (!b) { missing.push({ id, name: item.name, need, unit: item.unit }); continue; }
    lines.push({ id, name: item.name, need, unit: item.unit, pack: b.pack, n: b.n, cost: round2(b.cost) });
    total += b.cost;
    if (b.pack.checked && (!oldest || b.pack.checked < oldest)) oldest = b.pack.checked;
  }
  lines.sort((a, b) => b.cost - a.cost);
  return { shop, lines, missing, total: round2(total), oldest };
}

export function compareShops(needs, ingredients, shops = SHOPS) {
  const baskets = shops.map((s) => basketAt(s, needs, ingredients));
  // Rank: full coverage first, then total.
  baskets.sort((a, b) => (a.missing.length - b.missing.length) || (a.total - b.total));
  return baskets;
}

export function cheapestSplit(needs, ingredients, shops = SHOPS, threshold = 1) {
  const ing = byId(ingredients);
  const single = compareShops(needs, ingredients, shops)[0];
  if (!single) return null;
  let best = null;
  for (let i = 0; i < shops.length; i++) {
    for (let j = i + 1; j < shops.length; j++) {
      const a = shops[i], b = shops[j];
      const alloc = { [a]: {}, [b]: {} };
      const missing = [];
      let total = 0;
      for (const [id, need] of Object.entries(needs)) {
        const item = ing[id];
        if (!item) continue;
        const pa = bestPack(item, a, need), pb = bestPack(item, b, need);
        if (!pa && !pb) { missing.push(id); continue; }
        if (!pb || (pa && pa.cost <= pb.cost)) { alloc[a][id] = need; total += pa.cost; }
        else { alloc[b][id] = need; total += pb.cost; }
      }
      if (!best || (missing.length < best.missing.length) || (missing.length === best.missing.length && total < best.total)) {
        best = { shops: [a, b], total: round2(total), missing, baskets: [basketAt(a, alloc[a], ingredients), basketAt(b, alloc[b], ingredients)] };
      }
    }
  }
  if (!best) return null;
  const saving = round2(single.total - best.total);
  if (best.missing.length > single.missing.length) return null;
  if (best.missing.length === single.missing.length && saving < threshold) return null;
  return { ...best, saving, versus: single.shop };
}

// ---------- layout ----------
// 1. Fixed-slot recipes claim their slot. 2. Flexible recipes go, portion by portion, to the slot
// where they break up the most repetition. 3. Each slot is filled day by day from the cook day:
// a recipe that can't be frozen and would otherwise run out of fridge life is placed first;
// after that, avoid repeating yesterday's meal and lead with whatever has most portions left.
export function autoLayout(portions, recipes, cookDay = 0, days = [true, true, true, true, true, true, true]) {
  const rec = byId(recipes);
  const grid = DAYS.map(() => ({ breakfast: null, lunch: null, dinner: null }));
  const targets = Array.from({ length: 7 }, (_, k) => (cookDay + k) % 7).filter((d) => days[d]);
  const cap = targets.length;
  const entries = Object.entries(portions).filter(([rid, n]) => rec[rid] && n > 0).sort((a, b) => b[1] - a[1]);
  const counts = { breakfast: {}, lunch: {}, dinner: {} };
  const load = { breakfast: 0, lunch: 0, dinner: 0 };
  const overflow = [];
  const add = (slot, rid) => { counts[slot][rid] = (counts[slot][rid] || 0) + 1; load[slot] += 1; };
  for (const [rid, n] of entries) if (rec[rid].slots.length === 1) for (let i = 0; i < n; i++) add(rec[rid].slots[0], rid);
  for (const [rid, n] of entries) {
    if (rec[rid].slots.length === 1) continue;
    let unplaced = 0;
    for (let i = 0; i < n; i++) {
      const open = rec[rid].slots.filter((s) => load[s] < cap);
      if (!open.length) { unplaced++; continue; }
      const score = (s) => Math.max(0, ...Object.entries(counts[s]).filter(([r]) => r !== rid).map(([, c]) => c)) - (counts[s][rid] || 0);
      const slot = open.reduce((best, s) => (score(s) >= score(best) ? s : best), open[0]);
      add(slot, rid);
    }
    if (unplaced) overflow.push({ id: rid, unplaced });
  }
  for (const slot of SLOTS) {
    const seq = sequence(counts[slot], rec, cap);
    seq.forEach((rid, k) => { grid[targets[k]][slot] = rid; });
    const left = { ...counts[slot] };
    for (const rid of seq) left[rid] -= 1;
    for (const [rid, unplaced] of Object.entries(left)) {
      if (unplaced <= 0) continue;
      const o = overflow.find((x) => x.id === rid);
      if (o) o.unplaced += unplaced; else overflow.push({ id: rid, unplaced });
    }
  }
  return { grid, overflow };
}

// Day-by-day pick for one slot. k = days after the cook day.
export function sequence(countMap, rec, cap = 7) {
  const left = { ...countMap };
  const out = [];
  let prev = null;
  const isFresh = (rid) => rec[rid].cookMinutes === 0; // made on the day: no shelf-life constraint
  const deadline = (rid) => (rec[rid].freezer || isFresh(rid) ? Infinity : Math.max(0, rec[rid].fridgeDays - 1));
  for (let k = 0; k < cap; k++) {
    let pool = Object.keys(left).filter((rid) => left[rid] > 0);
    if (!pool.length) break;
    // Must go now or it spoils: non-freezable recipes whose remaining portions need every day left in their window.
    const must = pool.filter((rid) => deadline(rid) !== Infinity && k <= deadline(rid) && left[rid] >= deadline(rid) - k + 1);
    if (must.length) pool = must;
    const notPrev = pool.filter((rid) => rid !== prev);
    if (notPrev.length) pool = notPrev;
    const notLate = pool.filter((rid) => k <= deadline(rid));
    if (notLate.length) pool = notLate;
    pool.sort((a, b) => (deadline(a) - deadline(b)) || (left[b] - left[a]));
    const pick = pool[0];
    out.push(pick); left[pick] -= 1; prev = pick;
  }
  return out;
}

export function gridStats(grid, recipes, ingredients, snackProtein = 0, days = [true, true, true, true, true, true, true]) {
  const rec = byId(recipes);
  const perDay = grid.map((d, i) => {
    if (!days[i]) return 0;
    let p = snackProtein;
    for (const s of SLOTS) if (d[s] && rec[d[s]]) p += proteinPerPortion(rec[d[s]], ingredients);
    return Math.round(p);
  });
  const filled = grid.reduce((n, d) => n + SLOTS.filter((s) => d[s]).length, 0);
  const distinct = new Set(grid.flatMap((d) => SLOTS.map((s) => d[s]).filter(Boolean))).size;
  const active = days.filter(Boolean).length || 1;
  return { perDay, filled, distinct, slots: active * 3, activeDays: active, avg: Math.round(perDay.reduce((a, b) => a + b, 0) / active) };
}

// ---------- storage ----------
// cookDay: index into DAYS (0 = Sunday). Portions eaten within fridgeDays of cooking go in the fridge.
export function tubPlan(recipe, grid, cookDay = 0) {
  const days = [];
  if (recipe.cookMinutes === 0) return { total: 0, fridge: [], freezer: [], late: [], eatBy: null, fresh: true };
  grid.forEach((d, i) => { for (const s of SLOTS) if (d[s] === recipe.id) days.push(i); });
  const fridge = [], freezer = [], late = [];
  for (const d of days) {
    const age = (d - cookDay + 7) % 7; // days after cooking
    if (age < recipe.fridgeDays) fridge.push(d);
    else if (recipe.freezer) freezer.push(d);
    else late.push(d);
  }
  const eatBy = DAYS[(cookDay + recipe.fridgeDays - 1) % 7];
  return { total: days.length, fridge, freezer, late, eatBy };
}

export function runSheet(portions, recipes) {
  const rec = byId(recipes);
  const list = Object.entries(portions)
    .filter(([rid, n]) => rec[rid] && n > 0 && rec[rid].cookMinutes > 0)
    .map(([rid, n]) => ({ recipe: rec[rid], portions: n }))
    .sort((a, b) => b.recipe.cookMinutes - a.recipe.cookMinutes);
  const minutes = list.reduce((m, x) => m + x.recipe.cookMinutes, 0);
  return { list, minutes };
}

export function scaleIngredients(recipe, portions, ingredients) {
  const ing = byId(ingredients);
  return recipe.ingredients.map(({ id, qty }) => {
    const it = ing[id] || { name: id, unit: 'g' };
    return { id, name: it.name, unit: it.unit, qty: it.unit === 'each' ? Math.ceil(qty * portions * 2) / 2 : round1(qty * portions) };
  });
}

export const round2 = (x) => Math.round(x * 100) / 100;
export const round1 = (x) => Math.round(x * 10) / 10;
export const fmtQty = (qty, unit) => (unit === 'each' ? `${qty}` : qty >= 1000 ? `${round2(qty / 1000)}k${unit}` : `${qty}${unit}`);
export const gbp = (x) => `£${x.toFixed(2)}`;
