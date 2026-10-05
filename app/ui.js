/* からだミッション：画面 */
(function(){
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const yen = v => v == null ? '価格不明' : `${Math.round(v).toLocaleString()}円`;
  const n1 = v => v == null ? '不明' : (Math.round(v*10)/10);
  const PREFS = { '北海道':['北海道'], '東北':['青森県','岩手県','宮城県','秋田県','山形県','福島県'], '関東':['茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県'], '甲信越':['新潟県','山梨県','長野県'], '北陸':['富山県','石川県','福井県'], '東海':['岐阜県','静岡県','愛知県','三重県'], '近畿':['滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県'], '中国':['鳥取県','島根県','岡山県','広島県','山口県'], '四国':['徳島県','香川県','愛媛県','高知県'], '九州':['福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県'], '沖縄':['沖縄県'] };
  const prefArea = pref => Object.keys(PREFS).find(a => PREFS[a].includes(pref));

  const App = { data:{ products:[], chains:[], convenience:[] }, prof:null, settings:{}, game:null, tmp:{} };
  window.App = App;

  /* ---------------- データ読み込み ---------------- */
  async function loadData(){
    const [p, c] = await Promise.all([fetch('products.json').then(r => r.json()), fetch('chains.json').then(r => r.json())]);
    const custom = await DB.get('customProducts', []);      // 追加・更新した商品（同じidは上書き）
    const map = new Map(p.products.map(x => [x.id, x]));
    App.data.builtInProducts = Object.fromEntries(p.products.map(x => [x.id, x]));
    for (const x of custom) map.set(x.id, { ...map.get(x.id), ...x });
    App.data.products = [...map.values()];
    App.data.productsVersion = p.version;
    // 同梱チェーン ＋ 取り込んだ店舗（同じidは上書き・メニューはidごとに追加/更新）
    const stores = await DB.get('customStores', {});
    const legacy = await DB.get('customChainItems', {});
    App.data.builtInStores = Object.fromEntries(c.chains.map(ch => [ch.id, { ...ch, itemsById: Object.fromEntries(ch.items.map(i => [i.id, i])) }]));
    const merged = c.chains.map(ch => {
      const cs = stores[ch.id];
      const items = new Map(ch.items.map(i => [i.id, i]));
      for (const i of (legacy[ch.id] || [])) items.set(i.id, i);
      if (cs) for (const i of Object.values(cs.items || {})) items.set(i.id, i);
      const meta = cs ? Object.fromEntries(Object.entries(cs).filter(([k, v]) => k !== 'items' && v != null)) : {};
      return { type:'chain', ...ch, ...meta, items: [...items.values()] };
    });
    for (const [id, cs] of Object.entries(stores)) if (!App.data.builtInStores[id]) merged.push({ ...cs, items: Object.values(cs.items || {}) });
    for (const f of await DB.get('favorites', [])) merged.push(favAsChain(f));
    App.data.chains = merged;
    App.data.convenience = c.convenience;
    App.data.chainsVersion = c.version;
  }
  async function loadState(){
    App.prof = await DB.get('profile', null);
    App.settings = await DB.get('settings', { locationOn:false, share:{ weight:false, photos:false, meals:false, progress:false }, notify:{} });
    const g = await DB.get('game', {});
    App.game = { xp:0, badges:[], activeDays:[], xpByDay:{}, dayPct:{}, bestStreak:0, bestRank:null, ...g,
      counts:{ meal:0, drink:0, weight:0, training:0, steps:0, snackLog:0, homeMeal:0, bodyPhoto:0, ...(g.counts || {}) } };
  }
  const dayKey = d => 'day:' + d;
  async function getDay(d = E.today()){ return await DB.get(dayKey(d), { date:d, schedule:null, meals:{}, drinks:null, snacks:[], training:[], steps:null, caffeine:[], alcohol:[] }); }
  async function saveDay(day){ await DB.set(dayKey(day.date), day); }
  App.getDay = getDay;

  function targets(day){ const base = E.calcTargets(App.prof); return E.dayTargets(base, day?.schedule); }
  /* 過去7日＋今日のほかの食事から、重複防止用の履歴を作る（クリアしたミッションを重視） */
  async function buildHist(day, slot){
    const days = [];
    for (let i = 1; i <= 7; i++) {
      const d = await DB.get(dayKey(E.addDays(day.date, -i))); if (!d) continue;
      for (const m of Object.values(d.meals || {})) if (m.mission?.items?.length && m.status === 'cleared') days.push({ ago:i, items:m.mission.items.filter(x => x.role !== 'drink'), chain: m.mission.chain });
    }
    for (const [s, m] of Object.entries(day.meals || {})) if (s !== slot && m.mission?.items?.length) days.push({ ago:0, items:m.mission.items.filter(x => x.role !== 'drink'), chain: m.mission.chain });
    return E.makeHistory(days);
  }
  async function vendingList(){ return await DB.get('vending', []); }
  async function favList(){ return await DB.get('favorites', []); }

  /* ---------------- ゲーム ---------------- */
  const nowHM = () => E.hm();   // 端末のローカル時刻（24時間表記）を毎回取得
  async function scoreOfDate(date){
    const d = await DB.get(dayKey(date)); if (!d) return null;
    return G.dayScore(d, targets(d));
  }
  /* 行動に対してXPを付与し、その日のボーナス・連続・バッジを判定。体重の増減では評価しない */
  async function award(kind, label, opts = {}){
    const g = App.game; const before = G.level(g.xp).lv;
    const t = E.today();
    const gained = [];
    const add = (xp, lab, key) => { if (!xp) return; g.xp += xp; g.xpByDay[t] = (g.xpByDay[t] || 0) + xp; gained.push({ xp, label: lab, key }); };
    const base = opts.xp ?? G.XP[kind] ?? 0;
    g.counts[kind] = (g.counts[kind] || 0) + 1;
    add(base, label, kind);
    for (const b of (opts.bonus || [])) { g.counts[b] = (g.counts[b] || 0) + 1; add(G.BONUS[b].xp, G.BONUS[b].label, b); }
    if (!g.activeDays.includes(t)) {
      const last = g.activeDays[g.activeDays.length - 1];
      if (last && E.daysBetween(last, t) >= 3) g.comeback = true;
      g.activeDays.push(t); if (g.activeDays.length > 400) g.activeDays.shift();
    }
    // その日のボーナス判定
    const day = await getDay(); day.flags = day.flags || {};
    const tg = targets(day);
    const sc = G.dayScore(day, tg);
    g.dayPct[t] = sc.pct;
    const once = (flag, key, cond) => { if (cond && !day.flags[flag]) { day.flags[flag] = true; g.counts[key] = (g.counts[key] || 0) + 1; add(G.BONUS[key].xp, G.BONUS[key].label, key); } };
    once('perfect', 'perfect', sc.perfect);
    const type = day.schedule?.type;
    once('golfDay', 'golfDay', type === 'golf' && day.exerciseDone && sc.drinkDone >= 5);
    once('softDay', 'softDay', type === 'softball' && day.exerciseDone && sc.drinkDone >= 3);
    once('travelDay', 'travelDay', type === 'travel' && sc.mealsDone >= 2);
    once('replanBack', 'replanBack', !!day.replanned && Object.values(day.meals).some(m => m.status === 'cleared' && E.tsOf(m.clearedTs ?? m.clearedAt) > E.tsOf(day.replanned.ts ?? day.replanned.at)));
    if (day.recovery) { const rp = G.recoveryProgress(day, tg); once('recovery', 'recovery', rp.water && rp.lunch && rp.move); }
    // 連続達成
    const pctOf = d => d === t ? sc.pct : (g.dayPct[d] ?? 0);
    const st = G.streak(pctOf, t);
    g.streak = st; g.bestStreak = Math.max(g.bestStreak || 0, st);
    for (const n of [3, 7, 14, 30]) once('streak' + n, 'streak' + n, st >= n && sc.pct >= G.ACHIEVED);
    // 週間ランク（最高記録）
    const wk = G.weekRank([...Array(7)].map((_, i) => pctOf(E.addDays(t, -i))));
    const order = ['D','C','B','A','S'];
    if (!g.bestRank || order.indexOf(wk.r) > order.indexOf(g.bestRank)) g.bestRank = wk.r;
    await saveDay(day);
    const newB = G.BADGES.filter(b => !g.badges.includes(b.id) && b.test(g));
    newB.forEach(b => g.badges.push(b.id));
    await DB.set('game', g);
    const lv = G.level(g.xp).lv;
    const res = { gained, total: gained.reduce((a, x) => a + x.xp, 0), levelUp: lv > before ? lv : null, badges: newB, perfect: gained.some(x => x.key === 'perfect'), missing: sc.missing };
    if (opts.silent) return res;
    if (opts.big || res.levelUp || res.perfect || newB.length || gained.length > 1) await celebrate(res, opts);
    else xpPop(res.total, label);
    return res;
  }
  const gain = (kind, label) => award(kind, label);

  function xpPop(xp, label){
    const el = document.createElement('div'); el.className = 'xppop';
    el.innerHTML = `${xp ? `<b>+${xp} XP</b>` : ''}${label ? `<span>${esc(label)}</span>` : ''}`;
    document.body.appendChild(el); setTimeout(() => el.remove(), 1500);
  }
  /* MISSION CLEAR 演出（タップ or 自動で閉じる） */
  function celebrate(res, opts = {}){
    return new Promise(resolve => {
      const title = res.perfect ? 'PERFECT DAY' : opts.title || 'MISSION CLEAR';
      const sub = res.perfect ? '今日の作戦完了！ 全ミッション達成' : opts.sub || '';
      const theme = res.perfect ? 'perfect' : opts.theme || '';
      const bg = document.createElement('div'); bg.className = 'fx ' + theme;
      bg.innerHTML = `<div class="fx-card">
        <div class="fx-burst"></div>
        <div class="fx-title">${esc(title)}</div>${sub ? `<div class="fx-sub">${esc(sub)}</div>` : ''}
        <div class="fx-xp">+<span id="fx-n">0</span> XP</div>
        <div class="fx-list">${res.gained.map(x => `<div><span>${esc(x.label || '')}</span><b>+${x.xp}</b></div>`).join('')}</div>
        ${res.levelUp ? `<div class="fx-lv">LEVEL UP!　Lv.${res.levelUp} ${esc(G.title(res.levelUp))}</div>` : ''}
        ${res.badges.map(b => `<div class="fx-badge">${b.em} バッジ獲得：${esc(b.name)}</div>`).join('')}
        ${!res.perfect && res.missing?.length === 1 ? `<div class="fx-next">あと1つで完全達成：${esc(res.missing[0])}</div>` : ''}
        <div class="tiny" style="margin-top:10px">タップで閉じる</div></div>`;
      document.body.appendChild(bg);
      const n = bg.querySelector('#fx-n'); const T = res.total; const t0 = performance.now();
      const step = now => { const k = Math.min(1, (now - t0) / 700); n.textContent = Math.round(T * (1 - (1 - k) ** 3)); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
      let closed = false;
      const close = () => { if (closed) return; closed = true; bg.classList.add('out'); setTimeout(() => { bg.remove(); resolve(); }, 220); };
      bg.onclick = close;
      setTimeout(close, res.perfect || res.levelUp || res.badges.length ? 3200 : 1700);
    });
  }
  App.celebrate = celebrate;

  /* ---------------- 共通UI ---------------- */
  function toast(msg){ const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
  App.toast = toast;
  function sheet(html, onMount){
    const bg = document.createElement('div'); bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet">${html}</div>`;
    bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
    document.body.appendChild(bg); onMount && onMount(bg);
    return bg;
  }
  function pickPhoto(){
    return new Promise(res => {
      const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.setAttribute('capture', 'environment');
      i.onchange = async () => { if (!i.files[0]) return res(null); res(await DB.compressImage(i.files[0])); };
      i.click();
    });
  }
  function pickFile(accept){ return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); }); }
  async function photoURL(id){ const b = id && await DB.getPhoto(id); return b ? URL.createObjectURL(b) : null; }
  function view(html, dock = ''){
    $('#app').innerHTML = `<div class="wrap">${html}</div>` + (dock ? `<div class="dock"><div class="inner">${dock}</div></div>` : '');
    document.body.classList.toggle('has-dock', !!dock);
    App.tmp.renderedDate = E.today(); App.tmp.renderedHM = E.hm();
    if (App.tmp.keepScroll != null) { const y = App.tmp.keepScroll; App.tmp.keepScroll = null; requestAnimationFrame(() => window.scrollTo(0, y)); }
    else window.scrollTo(0, 0);
  }
  const go = h => { if (location.hash === h) route(); else location.hash = h; };
  App.go = go;
  const back = (to = '#home') => `<button class="back" onclick="App.go('${to}')">‹ 戻る</button>`;

  function itemHTML(it, opts = {}){
    const n = it.nutrition || {};
    const nameLine = esc(it.name) + (it.flavor && !it.name.includes(it.flavor) ? `<span class="pill">${esc(it.flavor)}</span>` : '') + (it.size ? `<span class="pill">${esc(it.size)}</span>` : '') + (it.qty ? `<span class="pill ok">${it.qty}${it.role === 'drink' ? '本' : '個'}</span>` : '');
    const alg = it.allergens?.status === 'confirmed' ? `<span class="pill ok">アレルゲン確認済${it.allergens.contains?.length ? '：' + esc(it.allergens.contains.join('・')) : '（該当なし）'}</span>` : `<span class="pill warn">アレルゲン未確認</span>`;
    const nut = n.kcal == null && n.protein == null ? `<span>栄養成分：公式未掲載（不明）</span>` :
      `<span>${n1(n.kcal)} kcal</span><span>P ${n1(n.protein)}g</span><span>F ${n1(n.fat)}g</span><span>C ${n1(n.carbs)}g</span><span>塩 ${n1(n.salt)}g</span>`;
    return `<div class="item ${opts.soldout ? 'soldout' : ''}">
      <div class="nm">${nameLine}</div>
      <div class="meta">${yen(it.priceYen)}${it.region ? '・販売地域：' + esc(it.region.slice(0, 40)) + (it.region.length > 40 ? '…' : '') : ''}${it.verifiedAt ? '・確認日 ' + it.verifiedAt : ''}</div>
      <div class="nut">${nut}</div><div style="margin-top:4px">${alg}</div>
      ${it.note ? `<div class="tiny" style="margin-top:4px">※${esc(it.note)}</div>` : ''}
      <div style="margin-top:6px">${it.officialUrl ? `<a class="tiny" href="${esc(it.officialUrl)}" target="_blank" rel="noopener">公式ページで写真を見る ›</a>` : ''}
      ${opts.soldoutBtn ? `<button class="btn sm" data-soldout="${esc(it.id)}">売り切れ</button>` : ''}${it.role !== 'drink' && it.id ? `<button class="btn sm star ${(App.prof?.favItems || []).includes(it.id) ? 'on' : ''}" data-fav="${esc(it.id)}">${(App.prof?.favItems || []).includes(it.id) ? '★ お気に入り' : '☆ お気に入り'}</button>` : ''}</div>
    </div>`;
  }

  /* ================= 初期設定 ================= */
  function renderSetup(){
    const p = App.prof || { sex:'male', activity:'low', budget:700, wake:'07:00', sleep:'23:30', allergies:[], pref:'東京都' };
    view(`
      ${App.prof ? back('#settings') : ''}
      <div class="logo" style="font-size:26px;margin-top:10px">からだミッション</div>
      <p class="small">考えなくていい。指令どおりに買って、撮るだけ。まずは基本情報を登録しろ！（端末の中だけに保存されます）</p>
      ${App.prof ? '' : storageNotice() + `<button class="btn" onclick="App.go('#backup')">💾 バックアップから復元して始める</button>`}
      <div class="card">
        <div class="row"><div><label>身長(cm)</label><input id="s-h" type="number" inputmode="decimal" value="${esc(p.heightCm || '')}"></div>
        <div><label>現在体重(kg)</label><input id="s-w" type="number" inputmode="decimal" value="${esc(p.weightKg || '')}"></div></div>
        <div class="row"><div><label>目標体重(kg)</label><input id="s-g" type="number" inputmode="decimal" value="${esc(p.goalKg || '')}"></div>
        <div><label>目標達成日</label><input id="s-gd" type="date" value="${esc(p.goalDate || E.addDays(E.today(), 120))}"></div></div>
        <div class="row"><div><label>年齢</label><input id="s-a" type="number" inputmode="numeric" value="${esc(p.age || '')}"></div>
        <div><label>性別（計算用）</label><select id="s-sex"><option value="male" ${p.sex==='male'?'selected':''}>男性</option><option value="female" ${p.sex==='female'?'selected':''}>女性</option></select></div></div>
        <label>普段の活動量</label><select id="s-act">${Object.entries(E.ACT).map(([k,v]) => `<option value="${k}" ${p.activity===k?'selected':''}>${v.label}</option>`).join('')}</select>
        <label>住んでいる都道府県（販売地域の判定に使用）</label><select id="s-pref">${Object.entries(PREFS).map(([a, ps]) => `<optgroup label="${a}">${ps.map(x => `<option ${p.pref===x?'selected':''}>${x}</option>`).join('')}</optgroup>`).join('')}</select>
      </div>
      <div class="card">
        <label>アレルギー（該当するものをタップ）</label>
        <div class="chips" id="s-alg">${E.ALLERGENS.map(a => `<span class="chip ${p.allergies?.includes(a)?'on':''}" data-a="${a}">${a}</span>`).join('')}</div>
        <div class="warnbox">アレルギーを登録すると、公式のアレルゲン情報が確認できている商品だけをミッションに使います。商品名だけでは安全と判断しません。</div>
        <label>アレルゲン未確認の商品</label><select id="s-unv"><option value="0" ${!p.allowUnverifiedAllergen?'selected':''}>使わない（安全側・おすすめ）</option><option value="1" ${p.allowUnverifiedAllergen?'selected':''}>表示する（毎回自分でラベル確認する）</option></select>
        <label>苦手な食べ物（読点区切り 例：パクチー、レバー）</label><input id="s-dis" value="${esc((p.dislikesList||[]).join('、'))}">
        <label>好きな食べ物（任意）</label><input id="s-like" value="${esc(p.likes || '')}">
        <label>食事を写真で記録した後、内容（パン・ご飯・麺など）をたずねる</label><select id="s-askfood"><option value="1" ${App.settings.askFoodDetail !== false ? 'selected' : ''}>たずねる（おすすめ）</option><option value="0" ${App.settings.askFoodDetail === false ? 'selected' : ''}>たずねない</option></select>
        <label>1食あたりの予算(円)</label><input id="s-b" type="number" inputmode="numeric" value="${esc(p.budget)}">
        <div class="row"><div><label>起床</label><input id="s-wk" type="time" value="${esc(p.wake)}"></div><div><label>就寝</label><input id="s-sl" type="time" value="${esc(p.sleep)}"></div></div>
      </div>
      <div id="s-preview"></div>
    `, `<button class="btn primary" id="s-save">${App.prof ? '保存する' : '目標を計算して始める'}</button>`);
    $('#s-alg').onclick = e => { const c = e.target.closest('.chip'); if (c) c.classList.toggle('on'); };
    $('#s-save').onclick = async () => {
      const np = {
        heightCm:+$('#s-h').value, weightKg:+$('#s-w').value, goalKg:+$('#s-g').value, goalDate:$('#s-gd').value, age:+$('#s-a').value, sex:$('#s-sex').value,
        activity:$('#s-act').value, pref:$('#s-pref').value, area:prefArea($('#s-pref').value),
        allergies:[...document.querySelectorAll('#s-alg .chip.on')].map(c => c.dataset.a),
        dislikesList:$('#s-dis').value.split(/[、,，\s]+/).filter(Boolean), allowUnverifiedAllergen: $('#s-unv').value === '1', likes:$('#s-like').value, budget:+$('#s-b').value || 700, wake:$('#s-wk').value, sleep:$('#s-sl').value
      };
      if (!np.heightCm || !np.weightKg || !np.goalKg) return toast('身長・体重・目標体重を入れてください');
      App.settings.askFoodDetail = $('#s-askfood').value !== '0'; await DB.set('settings', App.settings);
      const t = E.calcTargets(np);
      const first = !App.prof;
      App.prof = np; await DB.set('profile', np);
      if (first) { const ws = await DB.get('weights', []); ws.push({ date:E.today(), kg:np.weightKg }); await DB.set('weights', ws); }
      sheet(`<h2>あなたの基本ミッション</h2>
        <div class="card gold"><div class="cmd" style="font-size:20px;font-weight:800">1日 ${t.kcal} kcal・たんぱく質 ${t.protein}g</div>
        <div class="small">推定消費 ${t.tdee} kcal／減量ペース 約${t.pacePerWeek}kg/週／水分 ${(t.waterMl/1000).toFixed(1)}L</div></div>
        ${t.tooFast ? `<div class="warnbox">希望の日付だと週${t.wantedPace}kgの減量が必要で、急すぎます。無理のないペース（週${t.pacePerWeek}kg）で設定しました。到達目安：<b>${t.suggestDate || '—'}</b></div>` : `<div class="okbox">無理のないペースです。この調子で続けよう。</div>`}
        <p class="tiny">基礎代謝 ${t.bmr} kcal を下回る目標は出しません。体調に不安がある場合は医師に相談してください。</p>
        <button class="btn primary" onclick="this.closest('.sheet-bg').remove();App.go('#home')">ミッション開始！</button>`);
    };
  }

  /* ================= ホーム（表メニュー） ================= */
  /* ---------------- 食事と時間帯 ----------------
     今の時刻と食事状況から、各食事が「いま／これから／記録だけ（時間が過ぎた）」のどれかを決める */
  const MEAL_LATE = { breakfast:'11:00', lunch:'16:30', dinner:'24:00' };
  const MEAL_NOW = { breakfast:['00:00','10:30'], lunch:['10:30','15:30'], dinner:['17:00','24:00'] };
  function mealPhase(day, s, now = nowHM()){
    const m = day.meals?.[s];
    if (m?.status === 'cleared') return 'done';
    if (m?.status === 'skipped') return 'skipped';
    if (now >= MEAL_LATE[s]) return 'late';
    const [a, b] = MEAL_NOW[s];
    return now >= a && now < b ? 'now' : 'later';
  }
  /* 今いちばん優先する食事（朝食を食べずに15時なら昼食・夕食側を出す） */
  function focusMeal(day, now = nowHM()){
    const order = ['breakfast','lunch','dinner'];
    return order.find(s => mealPhase(day, s, now) === 'now') || order.find(s => mealPhase(day, s, now) === 'later') || null;
  }

  /* ---------------- 場所・飲み物の共通処理 ---------------- */
  /* 時間帯（朝 / 日中 / 夜）。手動で切り替えた場所は同じ時間帯の間だけ有効 */
  const period = hm => hm < (App.settings.leaveTime || '08:30') ? 'am' : hm >= (App.settings.backTime || '19:00') ? 'night' : 'day';
  function curPlace(day){
    const p = App.settings.place;
    if (p && p.date === E.today() && p.period === period(nowHM())) return p.id;
    const base = day?.schedule?.place || E.defaultPlace(day?.schedule?.type);
    if (base === 'office' && period(nowHM()) !== 'day') return 'home';   // 仕事の日：出勤前・帰宅後は自宅
    return base;
  }
  async function setPlace(id){ App.settings.place = { id, date:E.today(), at:nowHM(), period: period(nowHM()) }; await DB.set('settings', App.settings); }
  async function drinkCtx(day){
    const vend = (await vendingList()).flatMap(v => v.items.map(i => ({ ...i, place:v.name })));
    const caf = day.caffeine || [];
    return { place: curPlace(day), vending: vend, coffeeCount: caf.filter(c => c.kind === 'coffee').length, caffeineMg: caf.reduce((a, c) => a + (c.mg || 0), 0), meals: day.meals, sched: day.schedule, now: nowHM() };
  }
  async function ensureDay(day){
    let dirty = false;
    if (!day.drinks) { day.drinks = E.drinkSlots(day.schedule, App.prof); dirty = true; }
    else if (day.drinks.length && !day.drinks[0].v) { day.drinks = E.migrateDrinks(day.drinks, day.schedule, App.prof); dirty = true; }
    if (day.date === E.today()) {   // 今日の分だけ、今の時刻で目安を再計算
      const before = JSON.stringify(day.drinks.map(d => [d.due, d.missed]));
      day.drinks = E.reflowDrinks(day.drinks, nowHM(), App.prof);
      if (JSON.stringify(day.drinks.map(d => [d.due, d.missed])) !== before) dirty = true;
    }
    if (day.recovery === undefined) {
      const y = await DB.get(dayKey(E.addDays(day.date, -1)));
      const yt = y ? targets(y) : null;
      day.recovery = y ? G.recoveryFor(y, G.dayScore(y, yt), sumDay(y), yt?.kcal) : null;
      dirty = true;
    }
    if (dirty) await saveDay(day);
    return day;
  }
  /* 位置情報ONで自宅・会社の位置が登録済みなら、開いた時に1回だけ場所を自動判定（追跡はしない） */
  async function autoPlace(){
    const P = App.settings.places || {};
    if (!App.settings.locationOn || !(P.home || P.office)) return;
    const last = App.tmp.autoPlaceAt || 0; if (Date.now() - last < 20 * 60e3) return;
    App.tmp.autoPlaceAt = Date.now();
    try {
      const pos = await S.locateOnce();
      let best = null;
      for (const k of ['home', 'office']) if (P[k]) { const m = S.dist(pos.lat, pos.lon, P[k].lat, P[k].lon); if (m < 250 && (!best || m < best.m)) best = { k, m }; }
      const id = best ? best.k : 'out';
      if (id !== curPlace(await getDay())) { await setPlace(id); xpPop(0, `現在地：${E.PLACES[id].label}に切り替えました`); if ((location.hash || '#home') === '#home') renderHome(); }
    } catch {}
  }
  /* 前回の作戦（予定の種類ごとに記憶） */
  function lastPlan(type){
    const by = App.settings.planByType || {};
    if (type) return by[type] || null;
    return App.settings.lastPlan || null;
  }
  function planSummary(p){
    if (!p) return '';
    const L = { home:'家', 'conv:seven':'セブン', 'conv:lawson':'ローソン', 'conv:famima':'ファミマ', eatout:'外食', undecided:'後で決める', drinking:'飲み会', golf:'ゴルフ場', nearby:'近くで探す' };
    return [`${E.SCHED[p.type]?.em || ''}${E.SCHED[p.type]?.label || ''}`, `朝:${L[p.breakfast] || '—'}`, `昼:${L[p.lunch] || '—'}${p.bulk ? '（朝まとめ買い）' : ''}`, `夜:${L[p.dinner] || '—'}`, p.exercise && p.exercise !== 'none' ? ({ training:'💪トレーニング', walk:'🚶ウォーキング' })[p.exercise] || '' : '', `${E.PLACES[p.place]?.em || ''}${E.PLACES[p.place]?.label || ''}`].filter(Boolean).join('・');
  }

  async function renderHome(){
    let day = await ensureDay(await getDay());
    const t = targets(day);
    const g = App.game;
    const lv = G.level(g.xp);
    const sc = G.dayScore(day, t);
    const eaten = sumDay(day);
    const place = curPlace(day);
    const dctx = await drinkCtx(day);
    const cur = E.currentDrink(day.drinks, nowHM());          // 今の時刻を基準に「今やる指令」か「次の目安」を決める
    const nextDrink = cur?.slot;
    const missedN = day.drinks.filter(d => d.missed).length;
    const slots = ['breakfast','lunch','dinner'];
    const type = day.schedule?.type;
    const wk = G.weekRank([...Array(7)].map((_, i) => { const d = E.addDays(E.today(), -i); return d === E.today() ? sc.pct : (g.dayPct[d] ?? 0); }));
    const streak = G.streak(d => d === E.today() ? sc.pct : (g.dayPct[d] ?? 0), E.today());
    const comeback = g.activeDays.length && E.daysBetween(g.activeDays[g.activeDays.length-1], E.today()) >= 2;
    const lp = lastPlan();
    const theme = type === 'golf' ? 'theme-golf' : type === 'travel' ? 'theme-travel' : type === 'softball' ? 'theme-golf' : '';
    const fm = focusMeal(day);
    const mealState = s => {
      const m = day.meals[s]; const pl = day.schedule?.plan?.[s]; const ph = mealPhase(day, s);
      if (m?.status === 'cleared') return `<span class="done">✓ ${m.clearedHM ? esc(m.clearedHM) + ' 達成' : '達成'}</span>`;
      if (ph === 'skipped') return '<span class="tiny">なし</span>';
      if (ph === 'late') return '<span class="tiny">記録する</span>';
      if (m?.mission && !m.mission.error) return '<span class="hot">指令あり</span>';
      return ({ home:'家ごはん', drinking:'飲み会', golf:'ゴルフ場', eatout:'外食', 'conv:seven':'セブン', 'conv:lawson':'ローソン', 'conv:famima':'ファミマ' })[pl] || '発動する';
    };
    const dow = new Date().getDay();
    const weekend = dow === 0 || dow === 6;
    const rp = day.recovery ? G.recoveryProgress(day, t) : null;
    const coffeeBtns = place === 'office' && dctx.vending.some(v => v.caffeineMg)
      ? dctx.vending.filter(v => v.caffeineMg).slice(0, 3).map((v, i) => `<button class="btn sm" data-vcoffee="${i}">☕ ${esc(v.name)}</button>`).join('')
      : `<button class="btn sm" data-coffee="0">☕ コーヒー飲んだ</button>`;
    view(`
      <header class="topbar"><div class="logo">KARADA<span>MISSION</span></div><div class="spacer"></div>
        <button class="hbtn" onclick="App.go('#log')" aria-label="戦績">${ICON.trophy}<span>戦績</span></button>
        <button class="hbtn icon" onclick="App.go('#settings')" aria-label="設定">${ICON.gear}</button></header>
      ${storageNotice()}
      <div class="lv ${theme}" onclick="App.go('#log')"><div class="badge">${lv.lv}</div><div style="flex:1"><div class="small"><b style="color:var(--text)">${esc(G.title(lv.lv))}</b>　${g.xp} XP　次まで ${lv.toNext}</div><div class="bar"><i style="width:${lv.pct}%"></i></div>
        <div class="tiny" style="margin-top:4px">🔥 連続 ${streak}日　🏅 今週 ${wk.r}ランク</div></div></div>
      ${comeback ? `<div class="okbox">おかえり！ 昨日までのことは気にしない。今日の1ミッションから再開しよう。</div>` : ''}
      ${!day.schedule ? `<div class="card gold brief"><div class="kicker">TODAY'S OPERATION</div><h3>📋 今日の作戦会議</h3>
          ${lp ? `<div class="small">前回の作戦：${esc(planSummary(lp))}</div><button class="btn primary" id="h-same">前回と同じ作戦で開始！</button><button class="btn" onclick="App.go('#morning')">作戦を変えて開始</button>`
               : `<div class="small">予定・食事・場所を1画面で決めて、今日の作戦を開始しよう。</div><button class="btn primary" onclick="App.go('#morning')">作戦会議を開く</button>`}</div>`
        : `<div class="card op ${theme ? theme + ' special' : 'gold'}" ><div onclick="App.go('#morning')"><div class="kicker">${type === 'golf' ? 'ROUND DAY' : type === 'travel' ? 'AWAY MISSION' : type === 'softball' ? 'GAME DAY' : "TODAY'S OPERATION"}</div>
          <h3>${E.SCHED[type].em} ${E.SCHED[type].label}${day.schedule.golf?.course ? '　' + esc(day.schedule.golf.course) : ''}</h3>
          <div class="opstats"><div><span>目標</span><b>${t.kcal}<small>kcal</small></b></div><div><span>記録${eaten.est ? '（推定含む）' : ''}</span><b>${Math.round(eaten.kcal)}<small>kcal${eaten.unknown ? '＋不明' + eaten.unknown : ''}</small></b></div><div><span>たんぱく質</span><b>${Math.round(eaten.protein)}<small>/${t.protein}g</small></b></div></div></div>
          <div class="btnrow"><button class="btn sm ghost" onclick="App.go('#morning')">📋 作戦を確認</button><button class="btn sm" id="h-replan">⚡ 予定が変わった</button></div>
          ${type === 'golf' || type === 'softball' ? `<hr><div class="small">${type === 'golf' ? '⛳ ラウンド完走ミッション：水分補給（茶店・持参の水）を続けて、最後まで回り切れ！' : '🥎 完走ミッション：こまめな水分・塩分補給で最後まで動き切れ！'}</div>${day.exerciseDone ? `<div class="done" style="margin-top:6px">✓ 完走！</div>` : `<button class="btn ok" id="h-ex">${type === 'golf' ? '🏌️ ラウンド完走！' : '🥎 完走した！'}</button>`}` : ''}
          ${type === 'travel' ? `<hr><div class="small">🧳 遠征ミッション：駅や空港のコンビニ・近くの店からでも指令が出せる。2食クリアで遠征ボーナス！</div>` : ''}
        </div>`}
      ${rp && !day.flags?.recovery ? `<div class="card recovery"><div class="kicker">RECOVERY MISSION</div><b>${esc(day.recovery.reason)} 今日はリカバリー作戦。</b>
          ${day.recovery.tasks.map(x => `<div class="li" style="padding:6px 0"><span class="t small">${rp[x.id] ? '✅' : '⬜'} ${esc(x.label)}</span></div>`).join('')}<div class="tiny">3つクリアでボーナス +${G.BONUS.recovery.xp}XP。減点はありません。</div></div>`
        : day.flags?.recovery ? `<div class="okbox">🌅 リカバリー成功！ ちゃんと戻せた。</div>` : ''}
      <div class="sectlabel">現在地</div>
      <div class="placebar">${Object.entries(E.PLACES).map(([k, v]) => `<button class="pchip ${k === place ? 'on' : ''}" data-place="${k}">${v.em}<span>${v.label}</span></button>`).join('')}</div>
      <h2>本日の指令</h2>
      <div class="grid3">${slots.map(s => `<button class="tile ${day.meals[s]?.status === 'cleared' ? 'cleared' : ''} ${mealPhase(day, s) === 'late' || mealPhase(day, s) === 'skipped' ? 'late' : ''} ${s === fm ? 'focus' : ''}" data-meal="${s}">${s === fm ? '<span class="nowtag">いま</span>' : ''}<span class="em">${({breakfast:'🌅',lunch:'🍱',dinner:'🌙'})[s]}</span><b>${E.MEAL_LABEL[s]}</b><span class="small">${mealState(s)}</span></button>`).join('')}</div>
      ${nextDrink ? (() => { const dm = E.drinkMission(nextDrink, dctx); const isNow = cur.state === 'now';
          return `<div class="card drinkcard"><div class="kicker">💧 ${isNow ? '今の飲み物ミッション' : `次の飲み物ミッション・${nextDrink.due || nextDrink.time}ごろ`}</div><div class="dtext">${esc(isNow ? dm.text : '次は ' + (nextDrink.due || nextDrink.time) + ' ごろ：' + dm.text)}</div>
          ${dm.late ? `<div class="tiny" style="margin:-8px 0 12px">予定 ${nextDrink.time} の分。今飲めばOK、次は今から計算し直します。</div>` : ''}
          <button class="btn ok drinkbtn" data-drink="${esc(nextDrink.id)}">${isNow ? '飲んだ！' : '今飲んだ！'}</button>
          <div class="btnrow">${coffeeBtns}<button class="btn sm ghost" onclick="App.go('#drinks')">一覧${missedN ? `（見送り${missedN}）` : ''}</button></div></div>`; })() : `<div class="okbox">💧 今日の飲み物ミッションはすべて完了！</div>`}
      <h2>サポート</h2>
      <div class="grid2">
        <button class="tile" onclick="App.go('#snack')"><span class="em">🆘</span><b>お助け間食</b><span class="small">気分で選ぶ</span></button>
        <button class="tile" onclick="App.go('#train')"><span class="em">💪</span><b>トレーニング</b><span class="small">${day.training.length ? `<span class="done">✓ ${day.training.length}回</span>` : day.schedule?.exercise === 'training' ? '<span class="hot">本日の指令</span>' : lastTrainLabel()}</span></button>
        <button class="tile" id="h-body"><span class="em">⚖️</span><b>体重・歩数</b><span class="small">${day.weightLogged ? '<span class="done">✓ 体重</span>' : '朝の計測'}${day.steps != null ? '・' + day.steps.toLocaleString() + '歩' : ''}</span></button>
        <button class="tile" onclick="App.go('#nearby')"><span class="em">📍</span><b>現在地から探す</b><span class="small">近くのお店</span></button>
      </div>
      <h2>今日の達成状況</h2>
      <div class="card" onclick="App.go('#log')"><div class="progress-wrap">${ring(sc.pct)}<div style="flex:1;min-width:0">
        <div class="small">食事 ${sc.mealsDone}/3・水分 ${sc.drinkDone}/${sc.drinkTotal}・体重 ${day.weightLogged ? '✓' : '—'}・${['golf','softball'].includes(type) ? '完走 ' + (day.exerciseDone ? '✓' : '—') : '歩く/運動 ' + (sc.parts.move >= 1 ? '✓' : day.steps != null ? Math.round(sc.parts.move * 100) + '%' : '—')}</div>
        <div class="small" style="margin-top:4px">${sc.perfect ? '<b class="done">🌟 今日の作戦完了！ PERFECT DAY</b>' : sc.missing.length === 1 ? `<b class="hot">あと1つで完全達成：${esc(sc.missing[0])}</b>` : `完全達成まで あと${sc.missing.length}つ`}</div>
        <div class="tiny" style="margin-top:2px">今日 +${g.xpByDay[E.today()] || 0}XP　7日間の戦績 ›</div></div></div></div>
      ${weekend ? `<div class="card gold" onclick="App.go('#log')"><div class="kicker">WEEKEND REPORT</div><b>週末の戦績：${wk.r}ランク（${esc(wk.name)}）</b><div class="small">${esc(G.weekComments(await weekRows()).join(' '))}</div><div class="tiny">詳しく見る ›</div></div>` : ''}
    `);
    document.querySelectorAll('[data-dismiss-notice]').forEach(b => b.onclick = async () => { App.settings.storageNoticeSeen = true; await DB.set('settings', App.settings); renderHome(); });
    document.querySelectorAll('[data-place]').forEach(b => b.onclick = async () => { await setPlace(b.dataset.place); renderHome(); });
    const same = $('#h-same'); if (same) same.onclick = () => startPlan({ ...lp });
    const rpb = $('#h-replan'); if (rpb) rpb.onclick = () => replanSheet();
    const ex = $('#h-ex'); if (ex) ex.onclick = async () => { const d = await getDay(); d.exerciseDone = true; await saveDay(d); await award('training', type === 'golf' ? 'ラウンド完走' : '完走', { xp:30, big:true, title: type === 'golf' ? 'ROUND COMPLETE' : 'GAME COMPLETE', theme:'golf' }); renderHome(); };
    $('#h-body').onclick = () => quickBody();
    document.querySelectorAll('[data-meal]').forEach(b => b.onclick = () => {
      const s = b.dataset.meal; const m = day.meals[s];
      // 家ごはんの予定でまだ記録していない時は、タイルから直接カメラを起動（画面遷移なし）
      if (mealPhase(day, s) === 'late' && !m?.mission) return go('#late/' + s);
      if (day.schedule?.plan?.[s] === 'home' && !m) {
        const p = pickPhoto();
        return p.then(async blob => { if (!blob) return; await recordHomeMeal(s, blob, ''); });
      }
      go('#meal/' + s);
    });
    document.querySelectorAll('[data-coffee]').forEach(b => b.onclick = () => coffeeSheet());
    document.querySelectorAll('[data-vcoffee]').forEach(b => b.onclick = async () => { const v = dctx.vending.filter(x => x.caffeineMg)[+b.dataset.vcoffee]; await logCoffee(v.name + (v.size ? ' ' + v.size : ''), v.caffeineMg); renderHome(); });
    bindDrinkButtons();
    remindCheck(day);
    autoPlace();
  }
  function lastTrainLabel(){ const o = App.settings.lastTrain; return o ? `前回：${({home:'自宅',office:'会社',gym:'ジム',outdoor:'屋外'})[o.place]}${o.min}分` : '場所と時間で決める'; }
  async function logCoffee(name, mg){
    const d = await getDay(); d.caffeine = d.caffeine || [];
    const kind = /コーヒー|珈琲|ブラック|カフェ|エスプレッソ|BOSS|ジョージア|ワンダ|ルーツ/i.test(name) ? 'coffee' : 'tea';
    d.caffeine.push({ name, mg, kind, at: nowHM() }); await saveDay(d);
    const total = d.caffeine.reduce((a, c) => a + (c.mg || 0), 0);
    const adv = E.caffeineAdvice(total, App.prof.sleep);
    xpPop(0, `☕ ${name}（約${mg}mg）記録。今日 約${total}mg`);
    if (adv.length) setTimeout(() => toast(adv[0]), 900);
  }
  function coffeeSheet(){
    sheet(`<h2>☕ コーヒーを記録</h2><div class="small">ワンタップで記録。カフェインは日本食品標準成分表（コーヒー浸出液 60mg/100ml）からの概算です。</div>
      <div class="list card">${E.COFFEE_PRESETS.map((c, i) => `<div class="li" data-cf="${i}"><span class="t">${c.label}</span><span class="small">約${c.mg ?? E.caffeineEstimate('coffee', c.ml)}mg ›</span></div>`).join('')}</div>`, bg => {
      bg.querySelectorAll('[data-cf]').forEach(el => el.onclick = async () => { const c = E.COFFEE_PRESETS[+el.dataset.cf]; bg.remove(); await logCoffee(c.label, c.mg ?? E.caffeineEstimate('coffee', c.ml)); route(); });
    });
  }
  /* 体重・歩数をホームから直接（画面遷移なし） */
  async function quickBody(){
    const ws = await DB.get('weights', []); const day = await getDay();
    const today = ws.find(w => w.date === day.date); const last = [...ws].sort((a, b) => b.date.localeCompare(a.date))[0];
    let kg = today?.kg ?? last?.kg ?? App.prof.weightKg;
    sheet(`<h2>⚖️ 体重・歩数</h2>
      <div class="card"><b>今朝の体重</b>${today ? '<span class="pill ok">記録済み・修正できます</span>' : ''}
        <div class="stepper"><button class="btn sm" data-kg="-0.1">−</button><input id="qb-kg" type="number" step="0.1" inputmode="decimal" value="${kg}"><button class="btn sm" data-kg="0.1">＋</button></div>
        <div class="row"><button class="btn primary" id="qb-save">この体重で記録</button></div>
        <button class="btn" id="qb-photo">📷 体重計を撮って読み取る</button></div>
      <div class="card"><b>今日の歩数</b><div class="row"><input id="qb-st" type="number" inputmode="numeric" placeholder="例 8000" value="${day.steps ?? ''}"><button class="btn sm" id="qb-stsave" style="flex:none">記録</button></div></div>
      <button class="btn ghost" onclick="this.closest('.sheet-bg').remove();App.go('#body')">グラフ・全身写真 ›</button>`, bg => {
      const inp = bg.querySelector('#qb-kg');
      bg.querySelectorAll('[data-kg]').forEach(b => b.onclick = () => { inp.value = (Math.round((+inp.value + +b.dataset.kg) * 10) / 10).toFixed(1); });
      bg.querySelector('#qb-save').onclick = async () => { const v = +inp.value; if (!(v > 20 && v < 300)) return toast('体重を確認してください'); bg.remove(); await saveWeight(v); route(); };
      bg.querySelector('#qb-photo').onclick = () => { bg.remove(); App.tmp.bodyPhoto = true; go('#body'); };
      bg.querySelector('#qb-stsave').onclick = async () => { const v = Math.round(+bg.querySelector('#qb-st').value); if (!(v >= 0)) return; bg.remove(); await saveSteps(v); route(); };
    });
  }
  async function saveWeight(kg, photoId){
    const list = await DB.get('weights', []); const t = E.today(); const i = list.findIndex(w => w.date === t);
    const rec = { date:t, kg, ...(photoId ? { photoId } : {}) };
    if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push(rec);
    await DB.set('weights', list);
    const d = await getDay(); const first = !d.weightLogged; d.weightLogged = true; await saveDay(d);
    if (first) await award('weight', '体重を記録'); else toast('体重を更新しました');
  }
  async function saveSteps(v){
    const d = await getDay(); const first = d.steps == null; d.steps = v; await saveDay(d);
    if (first) await award('steps', '歩数を記録'); else { await award('check', '', { xp:0, silent:true }); toast('歩数を更新しました'); }
  }
  /* Safari と ホーム画面アプリでは保存場所が別になる案内 */
  const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  function storageNotice(){
    if (isStandalone() && App.settings.storageNoticeSeen) return '';
    if (isStandalone()) return `<div class="okbox notice-ok"><span>ホーム画面のアプリで起動中。記録はこのアプリ内に保存されます（Safariとは別の保存場所）。</span><button class="btn sm" data-dismiss-notice>わかった</button></div>`;
    return `<details class="notice"><summary>⚠️ Safariで開いています（タップで詳細）</summary><div class="small">iPhoneでは、Safariとホーム画面に追加したアプリで保存データが別になります。毎日使う前に、共有ボタン →「ホーム画面に追加」から起動してください。Safariで記録したデータは「設定 → バックアップと復元」で書き出し、アプリ側で復元できます。</div></details>`;
  }
  const ICON = {
    gear: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>'
  };
  function ring(p){ const r = 36, c = 2*Math.PI*r; return `<svg class="ring" viewBox="0 0 84 84"><circle cx="42" cy="42" r="${r}" fill="none" stroke="#2a3042" stroke-width="8"/><circle cx="42" cy="42" r="${r}" fill="none" stroke="url(#g)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c*p/100} ${c}" transform="rotate(-90 42 42)"/><defs><linearGradient id="g"><stop offset="0" stop-color="#d9b46a"/><stop offset="1" stop-color="#f1d9a2"/></linearGradient></defs><text x="42" y="47" text-anchor="middle" fill="#eef0f5" font-size="17" font-weight="800">${p}%</text></svg>`; }
  function sumDay(day){
    const s = { kcal:0, protein:0, unknown:0, est:0 };
    for (const m of Object.values(day.meals || {})) {
      if (m.status !== 'cleared') continue;
      let counted = false;
      if (m.mission?.sum && !m.homeRecord) { s.kcal += m.mission.sum.kcal || 0; s.protein += m.mission.sum.protein || 0; s.unknown += m.mission.sum.unknown || 0; counted = true; }
      if (m.foods?.length) { const fs = F.sumFoods(m.foods); s.kcal += fs.kcal; s.est += fs.estimated; s.unknown += fs.unknown; counted = true; }   // 追加で記録した食べ物（推定分は別に集計）
      if (!counted) s.unknown++;
    }
    for (const sn of (day.snacks || [])) if (sn.sum) { s.kcal += sn.sum.kcal || 0; s.protein += sn.sum.protein || 0; }
    s.kcal = Math.round(s.kcal); s.est = Math.round(s.est);
    s.complete = s.unknown === 0 && s.kcal > 0; return s;
  }
  function bindDrinkButtons(){
    document.querySelectorAll('[data-drink]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      const day = await getDay(); const d = day.drinks.find(x => x.id === b.dataset.drink); if (!d || d.done) return;
      const st = E.stamp();                                   // 押した瞬間の実際の時刻
      const said = E.drinkMission(d, { ...(await drinkCtx(day)), now: st.hm }).text;
      d.done = true; d.doneAt = st.hm; d.doneTs = st.ts; d.doneTz = st.tz; d.at = st.hm; d.said = said; d.place = curPlace(day);
      day.drinks = E.reflowDrinks(day.drinks, st.hm, App.prof);   // 次の目安は今から計算し直す
      await saveDay(day);
      await award('drink', '水分補給');
      route();
    });
  }

  /* アプリを開いている間の通知（完了済みは通知しない） */
  let remindTimer = null;
  function remindCheck(day){
    clearInterval(remindTimer);
    const nf = App.settings.notify || {};
    const tick = async () => {
      const d = await getDay(); const now = nowHM();
      const sent = App.tmp.sent || (App.tmp.sent = {});
      const fire = (k, title, body) => { if (sent[k]) return; sent[k] = 1; S.notify(title, body); };
      if (nf.drink && d.drinks) { const c = E.currentDrink(E.reflowDrinks(d.drinks, now, App.prof), now); if (c?.state === 'now') fire('dr' + c.slot.id + (c.slot.due || ''), '飲み物ミッション', E.drinkMission(c.slot, await drinkCtx(d)).text); }
      if (nf.weight && !d.weightLogged && now >= (App.prof.wake || '07:00')) fire('w' + d.date, '本日の指令', '体重計に乗って記録しろ！');
      if (nf.lunch && d.meals.lunch?.status !== 'cleared' && now >= (nf.lunchTime || '12:00')) fire('l' + d.date, '昼食ミッション', '昼食ミッション発動！');
      if (nf.dinner && d.meals.dinner?.status !== 'cleared' && now >= (nf.dinnerTime || '19:00')) fire('d' + d.date, '夕食ミッション', '夕食を撮影してミッションクリア！');
    };
    tick(); remindTimer = setInterval(tick, 60000);
  }

  /* 7日間の行（戦績・コメント用） */
  async function weekRows(){
    const rows = [];
    const ws = await DB.get('weights', []);
    for (let i = 6; i >= 0; i--) {
      const date = E.addDays(E.today(), -i);
      const d = await DB.get(dayKey(date));
      const t = d ? targets(d) : null;
      const score = d ? G.dayScore(d, t) : G.dayScore(null);
      const foods = d ? ['breakfast','lunch','dinner'].map(s => { const m = d.meals?.[s]; if (!m || m.status !== 'cleared') return null;
        const fl = (m.foods || []).map(f => `${F.title(f)}［${f.estimated ? '推定' : '公式'}${f.kcal}kcal］`).join('・');
        if (m.homeRecord && fl) return { s, txt: (m.photoId && !m.late ? '家ごはん：' : '') + fl };
        if (m.homeRecord) return { s, txt: (m.late ? '記録' : '家ごはん') + (m.dishes ? '（' + m.dishes.slice(0, 2).join('・') + '）' : m.memo ? '（' + m.memo.slice(0, 12) + '）' : '') };
        if (m.mission?.items?.length) return { s, txt: (m.mission.storeName ? E.shortStore(m.mission.storeName) + '：' : '') + m.mission.items.filter(x => x.role !== 'drink').map(x => x.name).join('・') + (fl ? '＋' + fl : '') };
        if (fl) return { s, txt: fl };
        return { s, txt: m.mission?.storeName || '記録' }; }).filter(Boolean) : [];
      rows.push({ date, d, score, foods, weight: ws.find(w => w.date === date)?.kg ?? null, steps: d?.steps ?? null, training: (d?.training || []).length,
        eatout: !!d && Object.values(d.meals || {}).some(m => m.source?.type === 'chain' || m.source?.type === 'manual'), drinking: !!d && ((d.alcohol || []).length > 0 || d.schedule?.plan?.dinner === 'drinking'),
        recovered: !!d?.flags?.recovery, replanBack: !!d?.flags?.replanBack, perfect: !!d?.flags?.perfect, xp: App.game.xpByDay[date] || 0, type: d?.schedule?.type });
    }
    return rows;
  }

  /* ================= 朝の作戦会議（1画面で確認 → 今日の作戦を開始！） ================= */
  const CH = {
    breakfast: [['home','🏠 家で食べる'],['conv:seven','セブン'],['conv:lawson','ローソン'],['conv:famima','ファミマ'],['undecided','後で決める']],
    lunch: [['conv:seven','セブン'],['conv:lawson','ローソン'],['conv:famima','ファミマ'],['eatout','🍽 外食'],['home','🏠 家'],['undecided','後で決める']],
    dinner: [['home','🏠 家ごはん'],['drinking','🍻 飲み会'],['eatout','🍽 外食'],['conv:seven','セブン'],['conv:lawson','ローソン'],['conv:famima','ファミマ'],['undecided','後で決める']],
    exercise: [['none','なし'],['training','💪 トレーニング'],['walk','🚶 ウォーキング']]
  };
  function defaultPlanFor(type){
    const base = { type, breakfast:'home', lunch: type === 'holiday' ? 'home' : 'conv:seven', dinner:'home', exercise:'none', place:E.defaultPlace(type), bulk:false };
    if (type === 'golf') { base.lunch = 'golf'; base.breakfast = 'conv:seven'; }
    if (type === 'travel') { base.lunch = 'undecided'; base.dinner = 'undecided'; }
    return base;
  }
  async function renderMorning(){
    const day = await getDay();
    const cur = day.schedule ? { ...day.schedule.plan, type:day.schedule.type, place:day.schedule.place, exercise:day.schedule.exercise, golf:day.schedule.golf, softball:day.schedule.softball } : null;
    let p = cur || { ...(lastPlan() || defaultPlanFor('work')) };
    const draw = () => {
      const chips = (k, opts) => `<div class="chips" data-k="${k}">${opts.map(([v, l]) => `<span class="chip ${p[k] === v ? 'on' : ''}" data-v="${v}">${l}</span>`).join('')}</div>`;
      const lunchOpts = p.type === 'golf' ? [['golf','⛳ ゴルフ場'], ...CH.lunch] : CH.lunch;
      const canBulk = p.breakfast?.startsWith('conv:') && p.lunch?.startsWith('conv:');
      const g = p.golf || {}, sb = p.softball || {};
      view(`${back()}<div class="kicker" style="margin-top:6px">BRIEFING</div><h1>今日の作戦会議</h1>
        ${day.schedule ? `<div class="okbox">作戦は開始済みです。変更すると、まだクリアしていないミッションだけ組み直します。</div>` : ''}
        <div class="card"><b>今日の予定</b>${chips('type', Object.entries(E.SCHED).map(([k, v]) => [k, v.em + ' ' + v.label]))}
          ${p.type === 'golf' ? `<div class="row"><div><label>ゴルフ場</label><input id="b-gc" value="${esc(g.course || '')}" placeholder="例：○○CC"></div><div><label>スタート</label><input id="b-gs" type="time" value="${esc(g.start || '08:30')}"></div><div><label>最高気温</label><input id="b-gt" type="number" inputmode="numeric" value="${esc(g.temp || '')}" placeholder="℃"></div></div>` : ''}
          ${p.type === 'softball' ? `<div class="row"><div><label>開始</label><input id="b-ss" type="time" value="${esc(sb.start || '09:00')}"></div><div><label>終了</label><input id="b-se" type="time" value="${esc(sb.end || '12:00')}"></div><div><label>最高気温</label><input id="b-st" type="number" inputmode="numeric" value="${esc(sb.temp || '')}" placeholder="℃"></div></div><label>内容</label><select id="b-si"><option value="game" ${sb.intensity !== 'practice' ? 'selected' : ''}>試合</option><option value="practice" ${sb.intensity === 'practice' ? 'selected' : ''}>練習</option></select>` : ''}
        </div>
        <div class="card"><b>朝食</b>${chips('breakfast', CH.breakfast)}
          <b style="display:block;margin-top:10px">昼食</b>${chips('lunch', lunchOpts)}
          ${canBulk ? `<div style="margin-top:8px">${chips('bulk', [[true,'🛒 朝に昼食まで買う'],[false,'別々に買う']])}</div>${p.bulk ? `<div class="tiny">朝食の店で昼食もまとめて買います。</div>` : ''}` : ''}
          <b style="display:block;margin-top:10px">夕食・飲み会予定</b>${chips('dinner', CH.dinner)}</div>
        <div class="card"><b>運動予定</b>${['golf','softball'].includes(p.type) ? `<div class="small" style="margin-top:6px">${E.SCHED[p.type].em} ${E.SCHED[p.type].label}が今日の運動（歩数ミッションはお休み）</div>` : chips('exercise', CH.exercise)}
          <b style="display:block;margin-top:10px">今日の基本の場所</b>${chips('place', Object.entries(E.PLACES).map(([k, v]) => [k, v.em + ' ' + v.label]))}<div class="tiny">ホーム画面でいつでも1タップで切り替えられます。${p.place === 'office' ? `会社の日は ${esc(App.settings.leaveTime || '08:30')} 前と ${esc(App.settings.backTime || '19:00')} 以降は自動で「自宅」扱い。` : ''}</div>
          ${p.place === 'office' ? `<div class="row"><div><label>家を出る</label><input id="b-lv" type="time" value="${esc(App.settings.leaveTime || '08:30')}"></div><div><label>帰宅</label><input id="b-bk" type="time" value="${esc(App.settings.backTime || '19:00')}"></div></div>` : ''}</div>
        <div class="card gold"><div class="kicker">TODAY'S PLAN</div><div class="small">${esc(planSummary(p))}</div></div>`,
        `<button class="btn primary" id="b-go">${day.schedule ? '作戦を更新！' : '今日の作戦を開始！'}</button>`);
      document.querySelectorAll('[data-k]').forEach(el => el.onclick = e => {
        const c = e.target.closest('.chip'); if (!c) return; readInputs();
        const k = el.dataset.k; let v = c.dataset.v; if (v === 'true') v = true; if (v === 'false') v = false;
        if (k === 'type' && v !== p.type) {
          const remembered = lastPlan(v);
          p = remembered ? { ...remembered } : defaultPlanFor(v);
        } else p[k] = v;
        if (k === 'breakfast' || k === 'lunch') { if (!(p.breakfast?.startsWith('conv:') && p.lunch?.startsWith('conv:'))) p.bulk = false; }
        if (k === 'bulk' && v) p.lunch = p.breakfast;
        if (k === 'lunch' && p.bulk) p.bulk = p.lunch === p.breakfast;
        draw();
      });
      $('#b-go').onclick = () => { readInputs(); startPlan(p); };
    };
    const readInputs = () => {
      if ($('#b-gc')) p.golf = { course:$('#b-gc').value, start:$('#b-gs').value, temp:$('#b-gt').value };
      if ($('#b-ss')) p.softball = { start:$('#b-ss').value, end:$('#b-se').value, temp:$('#b-st').value, intensity:$('#b-si').value };
      if ($('#b-lv')) { App.settings.leaveTime = $('#b-lv').value || '08:30'; App.settings.backTime = $('#b-bk').value || '19:00'; }
    };
    draw();
  }
  /* 作戦開始（既に開始済みなら、クリア済みは残して残りだけ組み直し） */
  async function startPlan(p){
    const day = await getDay();
    const restart = !!day.schedule;
    const now = nowHM();
    if (p.type === 'golf' && !p.lunch) p.lunch = 'golf';
    const ns = { type:p.type, place:p.place || E.defaultPlace(p.type), exercise: ['golf','softball'].includes(p.type) ? p.type : (p.exercise || 'none'),
      plan:{ bulk:!!p.bulk, breakfast:p.breakfast, lunch:p.lunch, dinner:p.dinner }, golf:p.golf, softball:p.softball };
    // 変わった食事だけミッションを外す（クリア済みは残す）
    const prev = day.schedule?.plan || {};
    for (const s of ['breakfast','lunch','dinner']) {
      const m = day.meals[s];
      if (m && m.status !== 'cleared' && prev[s] !== ns.plan[s]) delete day.meals[s];
    }
    day.schedule = ns;
    day.drinks = restart ? E.rebuildDrinks(day.drinks, ns, App.prof, now) : E.drinkSlots(ns, App.prof).map(d => ({ ...d }));
    if (ns.plan.bulk && ns.plan.breakfast.startsWith('conv:')) {
      for (const slot of ['breakfast', 'lunch']) if (day.meals[slot]?.status !== 'cleared') { await issueConv(day, slot, ns.plan.breakfast.slice(5), {}); day.meals[slot].bulk = true; }
    } else if (ns.plan.breakfast?.startsWith('conv:') && !day.meals.breakfast) await issueConv(day, 'breakfast', ns.plan.breakfast.slice(5), {});
    if (restart) day.replanned = { at: E.localISO(), ts: Date.now(), kind:'edit' };
    await saveDay(day);
    // 前回の作戦として記憶（予定の種類ごと）
    const mem = { type:p.type, breakfast:p.breakfast, lunch:p.lunch, dinner:p.dinner, exercise:p.exercise, place:ns.place, bulk:!!p.bulk, golf:p.golf, softball:p.softball };
    App.settings.lastPlan = mem; App.settings.planByType = { ...(App.settings.planByType || {}), [p.type]: mem };
    await DB.set('settings', App.settings);
    if (!restart) await award('planStart', '作戦開始', { xp: G.BONUS.planStart.xp, big:true, title:'OPERATION START', sub: p.type === 'golf' ? '⛳ ラウンドデー！ 水分補給を忘れずに' : p.type === 'travel' ? '🧳 遠征ミッション開始！' : p.type === 'softball' ? '🥎 ゲームデー！ こまめに補給' : '今日の作戦を開始！', theme: ['golf','softball'].includes(p.type) ? 'golf' : p.type === 'travel' ? 'travel' : '' });
    else toast('残りのミッションを組み直しました');
    go(ns.plan.bulk && !restart ? '#bulk' : '#home');
  }

  /* 途中の予定変更：今の時点から残りだけ再構成 */
  function nextSlot(day){
    const now = nowHM();
    const open = ['breakfast','lunch','dinner'].filter(s => day.meals[s]?.status !== 'cleared');
    if (now >= '15:00') return open.includes('dinner') ? 'dinner' : open[0];
    if (now >= '10:30') return open.includes('lunch') ? 'lunch' : open.find(s => s !== 'breakfast') || open[0];
    return open[0];
  }
  function replanSheet(){
    sheet(`<h2>⚡ 予定が変わった</h2><p class="small">1日を作り直さず、今から残りのミッションだけ組み直します。クリア済みはそのまま。</p>
      <div class="list card">
        <div class="li" data-rp="drinking"><span class="t">🍻 急に飲み会になった</span>›</div>
        <div class="li" data-rp="client"><span class="t">🤝 取引先と外食になった</span>›</div>
        <div class="li" data-rp="trip"><span class="t">🧳 出張になった</span>›</div>
        <div class="li" data-rp="forgot"><span class="t">🛒 昼食を買い忘れた</span>›</div>
        <div class="li" data-rp="rainout"><span class="t">☔ ゴルフ・試合が中止になった</span>›</div>
        <div class="li" data-rp="homedinner"><span class="t">🏠 夕食は家で食べることになった</span>›</div>
        <div class="li" data-rp="edit"><span class="t">📋 その他（作戦会議で変更）</span>›</div>
      </div>`, bg => bg.querySelectorAll('[data-rp]').forEach(el => el.onclick = () => { bg.remove(); replan(el.dataset.rp); }));
  }
  async function replan(kind){
    if (kind === 'edit') return go('#morning');
    const day = await getDay(); const now = nowHM();
    if (!day.schedule) { day.schedule = { type:'work', place:curPlace(day), exercise:'none', plan:{ breakfast:'undecided', lunch:'undecided', dinner:'home' } }; }
    const sc = day.schedule; const plan = sc.plan;
    const open = s => day.meals[s]?.status !== 'cleared';
    const drop = s => { if (open(s)) delete day.meals[s]; };
    let goTo = '#home', msg = '';
    if (kind === 'drinking') {
      if (open('dinner')) { plan.dinner = 'drinking'; drop('dinner'); }
      if (open('lunch') && day.meals.lunch?.source?.type === 'conv') { day.meals.lunch.rerollCount = (day.meals.lunch.rerollCount || 0) + 1; await issueConv(day, 'lunch', day.meals.lunch.source.id, { lighter:true }); day.meals.lunch.mission.tip = '夜は飲み会。昼は少し軽めにした。'; }
      msg = '夕食を飲み会ミッションに切り替えました';
    } else if (kind === 'client') {
      const s = nextSlot(day); if (!s) return toast('残りの食事はありません');
      plan[s] = 'eatout'; drop(s);
      const m = day.meals[s] = { status:'pending', moodRerolls:0, rerollCount:0, soldout:[], source:{ type:'manual', name:'取引先との外食' } };
      m.mission = { kind:'guide', storeName:'取引先との外食', meal:s, cmd:'取引先との外食：会話を楽しみつつ、焼き魚・焼き鳥・サラダ・刺身を中心に。ご飯と揚げ物は控えめに！', guide:'メニューが見られればAIに選ばせることもできます（撮影はタイミングが合う時だけでOK）。', needsPhoto:true, drinkLine:'お店の水かお茶（お酒は1〜2杯まで）' };
      goTo = '#meal/' + s; msg = `${E.MEAL_LABEL[s]}を外食ミッションに切り替えました`;
    } else if (kind === 'trip') {
      sc.type = 'travel'; sc.place = 'out'; await setPlace('out');
      for (const s of ['lunch','dinner']) if (open(s)) { plan[s] = 'undecided'; drop(s); }
      msg = '🧳 遠征ミッションに切り替えました';
    } else if (kind === 'forgot') {
      if (!open('lunch')) return toast('昼食はクリア済みです');
      plan.lunch = 'undecided'; plan.bulk = false; drop('lunch');
      goTo = '#meal/lunch'; msg = '近くのお店から昼食ミッションを出そう';
    } else if (kind === 'rainout') {
      const was = sc.type;
      sc.type = 'holiday'; sc.exercise = 'training'; sc.place = 'home'; await setPlace('home');
      if (open('lunch') && (plan.lunch === 'golf')) { plan.lunch = 'undecided'; drop('lunch'); }
      msg = `${was === 'golf' ? 'ゴルフ' : '試合'}は中止。休日モード＋室内トレーニングに切り替えました`;
    } else if (kind === 'homedinner') {
      if (open('dinner')) { plan.dinner = 'home'; drop('dinner'); }
      msg = '夕食は家ごはん（撮影して記録）に切り替えました';
    }
    day.drinks = E.rebuildDrinks(day.drinks, sc, App.prof, now);
    day.replanned = { at: E.localISO(), ts: Date.now(), kind };
    await saveDay(day);
    toast(msg + '。残りのミッションを組み直しました');
    if (goTo.startsWith('#meal/')) App.tmp.forceChoose = !day.meals[goTo.slice(6)];
    go(goTo);
  }

  /* ================= 7日間の戦績 ================= */
  async function renderLog(){
    const rows = await weekRows();
    const g = App.game; const lv = G.level(g.xp);
    const wk = G.weekRank(rows.map(r => r.score.pct));
    const streak = G.streak(d => (rows.find(r => r.date === d)?.score.pct) ?? (g.dayPct[d] ?? 0), E.today());
    const weekXp = rows.reduce((a, r) => a + r.xp, 0);
    const perfect = rows.filter(r => r.perfect).length;
    const ws = rows.filter(r => r.weight != null);
    const wd = ws.length >= 2 ? (ws[ws.length - 1].weight - ws[0].weight) : null;
    const dname = d => { const x = new Date(d + 'T12:00:00'); return `${x.getMonth() + 1}/${x.getDate()}(${'日月火水木金土'[x.getDay()]})`; };
    view(`${back()}<div class="kicker" style="margin-top:6px">WEEKLY REPORT</div><h1>7日間の戦績</h1>
      <div class="card gold"><div class="rankrow"><div class="rank r${wk.r}">${wk.r}</div><div style="flex:1"><b>今週 ${wk.r}ランク（${esc(wk.name)}）</b>
        <div class="small">${wk.nextR ? `あと平均${wk.toNext}%で ${wk.nextR}ランク` : '最高ランク！'}　（良い5日の平均 ${wk.avg}%）</div></div></div>
        <div class="statgrid"><div><b>${weekXp}</b><span>週間XP</span></div><div><b>🔥${streak}</b><span>連続達成</span></div><div><b>🌟${perfect}</b><span>完全達成</span></div><div><b>Lv.${lv.lv}</b><span>${esc(G.title(lv.lv))}</span></div></div>
        <div class="comment">${G.weekComments(rows).map(c => `<div>💬 ${esc(c)}</div>`).join('')}</div></div>
      <div class="card"><b>達成率</b><div class="bars">${rows.map(r => `<div class="bcol"><div class="bval">${r.score.active ? r.score.pct : ''}</div><div class="bbar ${r.perfect ? 'perfect' : r.score.pct >= G.ACHIEVED ? 'ok' : ''}" style="height:${Math.max(3, r.score.pct)}%"></div><div class="blab">${dname(r.date).replace(/\(.*\)/, '')}<br>${'日月火水木金土'[new Date(r.date + 'T12:00:00').getDay()]}</div></div>`).join('')}</div>
        <div class="tiny">60%以上で達成日（連続にカウント）。体重の増減は評価に入りません。</div></div>
      <div class="card"><b>体重</b>${wd != null ? `<span class="small">　7日間で ${wd >= 0 ? '+' : ''}${wd.toFixed(1)}kg（日々の上下は気にしない）</span>` : ''}
        <div class="wrow">${rows.map(r => `<div><span class="tiny">${dname(r.date).replace(/\(.*\)/, '')}</span><b>${r.weight ?? '—'}</b></div>`).join('')}</div></div>
      ${rows.slice().reverse().map(r => `<div class="card dayrow ${r.perfect ? 'perfect' : ''}"><div class="row"><b style="flex:2">${dname(r.date)}${r.type ? ' ' + E.SCHED[r.type].em : ''}${r.perfect ? ' 🌟' : ''}</b><span class="small" style="flex:none">${r.score.active ? r.score.pct + '%' : '記録なし'}${r.xp ? '・+' + r.xp + 'XP' : ''}</span></div>
        ${r.foods.length ? r.foods.map(f => `<div class="small">${({breakfast:'🌅',lunch:'🍱',dinner:'🌙'})[f.s]} ${esc(f.txt)}</div>`).join('') : ''}
        <div class="tiny" style="margin-top:4px">💧 ${r.score.drinkDone}/${r.score.drinkTotal}　👟 ${r.steps != null ? r.steps.toLocaleString() + '歩' : '—'}　💪 ${r.training ? r.training + '回' : '—'}　⚖️ ${r.weight ?? '—'}${r.drinking ? '　🍻' : ''}${r.recovered ? '　🌅リカバリー' : ''}${r.replanBack ? '　⚡立て直し' : ''}</div></div>`).join('')}
      <button class="btn ghost" onclick="App.go('#badges')">🏅 バッジ一覧</button>`);
  }

  /* ================= 食事ミッション ================= */
  /* 店を選び直した時は、前の記録（家の食事・クリア状態）を引き継がない */
  function resetMeal(m){ delete m.homeRecord; delete m.aiOrder; m.status = 'pending'; m.clearNote = null; m.photoId = null; m.clearedAt = null; }
  async function issueConv(day, slot, store, opt){
    const t = targets(day);
    const conv = App.data.convenience.find(c => c.id === store);
    const m = day.meals[slot] || (day.meals[slot] = { status:'pending', moodRerolls:0, rerollCount:0, soldout:[] });
    const mission = E.convMission({ products: App.data.products, store, storeName: conv.name, meal: slot, target: t, prof: App.prof, hist: await buildHist(day, slot),
      seed: day.date + slot + store + (m.rerollCount || 0), soldout: m.soldout, exclude: opt.exclude || [], bigger: opt.bigger, lighter: opt.lighter });
    m.source = { type:'conv', id:store }; m.mission = mission; m.status = 'pending'; resetMeal(m);
    return mission;
  }
  async function issueChain(day, slot, chainId, opt){
    const t = targets(day);
    const chain = App.data.chains.find(c => c.id === chainId);
    if (!chain) throw new Error('店舗が見つかりません（削除された可能性）');
    const m = day.meals[slot] || (day.meals[slot] = { status:'pending', moodRerolls:0, rerollCount:0, soldout:[] });
    m.source = { type:'chain', id:chainId }; resetMeal(m);
    m.mission = E.chainMission({ chain, meal: slot, target: t, prof: App.prof, hist: await buildHist(day, slot), seed: day.date + slot + chainId + (m.rerollCount || 0), appetite: opt.appetite, soldout: m.soldout });
    m.status = 'pending';
    return m.mission;
  }
  function favAsChain(f){ return { id:'fav-' + f.id, name:f.name, type:'local', genre:'行きつけ', aliases:[f.name], lat:f.lat ?? null, lon:f.lon ?? null, address:f.address || null, favorite:true, items:(f.items || []).map((x, i) => ({ id:'fav-' + f.id + '-' + i, ...x, nutrition:{ kcal:x.kcal ?? null, protein:x.protein ?? null, fat:null, carbs:null, salt:x.salt ?? null }, source:'favorite', status:'active', role:'main' })) }; }

  /* 直近30日でよく使った店（コンビニ・チェーン・行きつけ） */
  async function frequentStores(){
    const cnt = {};
    for (let i = 0; i <= 30; i++) {
      const d = await DB.get(dayKey(E.addDays(E.today(), -i))); if (!d) continue;
      for (const m of Object.values(d.meals || {})) { const src = m.source; if (!src || m.status !== 'cleared') continue; if (src.type === 'conv' || src.type === 'chain') { const k = src.type + ':' + src.id; cnt[k] = (cnt[k] || 0) + 1; } }
    }
    return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => {
      const [type, ...rest] = k.split(':'); const id = rest.join(':');
      const name = type === 'conv' ? App.data.convenience.find(c => c.id === id)?.name : App.data.chains.find(c => c.id === id)?.name;
      return name ? { type, id, name, n } : null;
    }).filter(Boolean);
  }
  async function renderMeal(slot){
    const day = await getDay();
    if (slot === 'snack') return go('#snack');
    const m = day.meals[slot];
    const force = App.tmp.forceChoose; App.tmp.forceChoose = false;
    const planned = day.schedule?.plan?.[slot];
    if (!force && planned === 'drinking' && !m?.source) return renderDrinking(slot);
    if (!force && (m?.mission || m?.homeRecord || m?.status === 'cleared')) return renderMission(slot);
    if (!force && planned && planned !== 'undecided' && planned !== 'chain') {
      if (planned.startsWith('conv:')) { await issueConv(day, slot, planned.slice(5), {}); await saveDay(day); return renderMission(slot); }
      if (planned === 'home') return renderHomeMeal(slot);
      if (planned === 'drinking') return renderDrinking(slot);
      if (planned === 'golf') return renderGolfMeal(slot);
      if (planned === 'nearby') return go('#nearby');
    }
    const freq = await frequentStores();
    const order = ['行きつけ','個人店','牛丼・定食','寿司','中華・麺類','ファミレス・カレー','ファストフード・カフェ','居酒屋','その他'];
    const genres = [...new Set(App.data.chains.map(c => c.genre))].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
    view(`${back()}<h1>${E.MEAL_LABEL[slot]}ミッション：店を選べ！</h1>
      <div class="chips" style="margin-bottom:8px">${['breakfast','lunch','dinner'].map(s => `<span class="chip ${s===slot?'on':''}" onclick="App.go('#meal/${s}')">${E.MEAL_LABEL[s]}${day.meals[s]?.status==='cleared'?' ✓':''}</span>`).join('')}</div>
      ${freq.length ? `<h2>よく使う店</h2><div class="grid2">${freq.map(f => `<button class="tile fav" ${f.type === 'conv' ? `data-conv="${f.id}"` : `data-chain="${esc(f.id)}"`}><span class="em">${f.type === 'conv' ? '🏪' : '🍽'}</span><b>${esc(f.name)}</b><span class="small">最近${f.n}回</span></button>`).join('')}</div>` : ''}
      <h2>コンビニ</h2><div class="grid2">${App.data.convenience.map(c => `<button class="tile" data-conv="${c.id}"><span class="em">🏪</span><b>${c.name}</b></button>`).join('')}
        <button class="tile" onclick="App.go('#nearby')"><span class="em">📍</span><b>近くで探す</b></button></div>
      ${slot !== 'breakfast' ? `<h2>その他</h2><div class="grid2"><button class="tile" data-special="home"><span class="em">🏠</span><b>自宅の食事</b><span class="small">撮影して記録</span></button><button class="tile" data-special="drinking"><span class="em">🍻</span><b>飲み会</b></button>${day.schedule?.type==='golf'?`<button class="tile" data-special="golf"><span class="em">⛳</span><b>ゴルフ場</b></button>`:''}</div>` : `<div class="grid2" style="margin-top:10px"><button class="tile" data-special="home"><span class="em">🏠</span><b>自宅の食事</b><span class="small">撮影して記録</span></button></div>`}
      ${genres.map(g => `<h2>${g}</h2><div class="list card">${App.data.chains.filter(c => c.genre === g).map(c => `<div class="li" data-chain="${c.id}"><span class="t">${c.favorite ? '⭐ ' : c.source === 'import' ? '📥 ' : ''}${esc(c.name)}</span><span class="small">${c.items.length ? c.items.length + '品登録' : c.sushi ? '定番ネタで指令' : '写真モード'} ›</span></div>`).join('')}</div>`).join('')}`);
    document.querySelectorAll('[data-conv]').forEach(b => b.onclick = async () => { await issueConv(day, slot, b.dataset.conv, {}); await saveDay(day); renderMission(slot); });
    document.querySelectorAll('[data-chain]').forEach(b => b.onclick = async () => { await issueChain(day, slot, b.dataset.chain, {}); await saveDay(day); renderMission(slot); });
    document.querySelectorAll('[data-special]').forEach(b => b.onclick = () => ({ home: renderHomeMeal, drinking: renderDrinking, golf: renderGolfMeal })[b.dataset.special](slot));
  }

  async function renderMission(slot){
    const day = await getDay(); const m = day.meals[slot];
    if (!m) return renderMeal(slot);
    if (location.hash !== '#meal/' + slot) history.replaceState(null, '', '#meal/' + slot);
    if (m.homeRecord) return renderHomeMeal(slot);
    if (m.drinking) return renderDrinking(slot);
    const ms = m.mission;
    const cleared = m.status === 'cleared';
    const photo = await photoURL(m.photoId);
    const lateNote = !cleared && mealPhase(day, slot) === 'late' ? `<div class="warnbox">いまは ${nowHM()}。${E.MEAL_LABEL[slot]}の時間は過ぎています。食べていたら撮影して記録、まだなら<a href="#late/${slot}">記録だけにする</a>こともできます。</div>` : '';
    let body = '';
    if (ms?.error) body = `<div class="warnbox">${esc(ms.error)}</div>`;
    else if (ms) {
      body = `<div class="card gold mission"><div class="kicker">${cleared ? 'MISSION CLEAR' : 'MISSION'} ・ ${E.MEAL_LABEL[slot]}${m.bulk ? '（朝まとめ買い）' : ''}</div><div class="cmd">${esc(ms.cmd)}</div>
        ${ms.kind === 'sushi' ? `<div class="list">${ms.order.map(o => `<div class="li"><span class="t"><b>${esc(o.name)}</b></span><b>${o.qty}皿</b></div>`).join('')}${ms.side ? `<div class="li"><span class="t">${esc(ms.side)}</span><b>1つ</b></div>` : ''}</div><div class="warnbox">${esc(ms.caution)}</div>
            <div class="chips">${ms.order.map(o => `<span class="chip" data-sushi-out="${esc(o.name)}">${esc(o.name)}が無い</span>`).join('')}</div>`
          : ms.kind === 'guide' ? `<div class="small">${esc(ms.guide)}</div>`
          : ms.items.map(it => itemHTML(it, { soldoutBtn: !cleared })).join('')}
        ${ms.sum ? `<div class="small" style="margin-top:8px">合計 ${yen(ms.sum.price)}${ms.sum.priceUnknown ? '＋価格不明' + ms.sum.priceUnknown + '品' : ''}・${Math.round(ms.sum.kcal)} kcal・たんぱく質 ${n1(ms.sum.protein)}g・塩分 ${n1(ms.sum.salt)}g</div>` : ''}
        ${ms.verdict ? `<div class="${ms.sum?.complete ? 'okbox' : 'warnbox'}">${esc(ms.verdict)}</div>` : ''}
        ${ms.allergyCheck?.length ? `<div class="warnbox">⚠️ アレルゲン未確認：${esc(ms.allergyCheck.join('・'))}。食べる前に必ず商品ラベル・店のアレルゲン表を確認してください。</div>` : ''}
        ${ms.drinkLine && !ms.items?.some(i => i.role === 'drink') ? `<div class="small" style="margin-top:6px">🥤 飲み物：${esc(ms.drinkLine)}</div>` : ''}
        ${ms.tip ? `<div class="okbox">${esc(ms.tip)}</div>` : ''}${ms.note ? `<div class="okbox">${esc(ms.note)}</div>` : ''}
      </div>`;
      if (ms.kind === 'guide') body += `<button class="btn primary" id="ms-menu">📷 メニュー表を撮ってAIに選ばせる</button>${m.aiOrder ? aiOrderHTML(m.aiOrder) : ''}`;
    }
    view(`${back()}
      ${lateNote}${body}
      ${cleared ? `<div class="okbox">✅ ${esc(m.clearedHM || E.fmtLocal(m.clearedAt))} ミッションクリア！${m.clearNote ? '　' + esc(m.clearNote) : ''}</div>${foodListHTML(slot, m)}${photo ? `<img class="photo" src="${photo}">` : ''}` : ''}
      ${!cleared && ms?.alternatives?.length ? `<details class="card"><summary><b>ほかの組み合わせ案（${ms.alternatives.length}）</b></summary><div class="tiny" style="margin:6px 0">選び直しは「気分での変更」1回として数えます。</div>${ms.alternatives.map((a, i) => `<div class="item"><div class="nm">${esc(a.cmd)}</div><div class="meta">${yen(a.sum.price)}・${Math.round(a.sum.kcal)}kcal・P${n1(a.sum.protein)}g${a.sum.complete ? '' : '・栄養不明あり'}</div><button class="btn sm" data-alt="${i}">この案にする</button></div>`).join('')}</details>` : ''}
      ${!cleared && ms && !ms.error ? `<div class="card"><b>指令を変更する</b><div class="small">理由を選んでください。「気分」だけ1日1食につき1回まで（残り${Math.max(0, 1 - (m.moodRerolls || 0))}回）。ほかは何度でもOK。</div>
        <div class="chips" style="margin-top:8px">${[['soldout','売り切れ'],['plan','予定変更'],['more','量が足りない'],['sick','体調'],['allergy','アレルギー'],['mood','気分が変わった'],['other','その他']].map(([k, l]) => `<span class="chip ${k === 'mood' && (m.moodRerolls || 0) >= 1 ? 'off' : ''}" data-re="${k}">${l}</span>`).join('')}</div></div>` : ''}
      <button class="btn ghost" onclick="App.tmp.forceChoose=true;App.go('#mealchoose/${slot}')">別の店にする</button>`,
      cleared ? `<button class="btn" onclick="App.go('#home')">ホームへ</button>` : (ms && !ms.error ? `<button class="btn" id="ms-manual" style="flex:1">手動でクリア</button><button class="btn primary" id="ms-photo" style="flex:1.6">📷 撮影してクリア</button>` : `<button class="btn" onclick="App.tmp.forceChoose=true;App.go('#mealchoose/${slot}')">店を選び直す</button>`));
    document.querySelectorAll('[data-soldout]').forEach(b => b.onclick = async () => {
      const d = await getDay(); const mm = d.meals[slot]; mm.soldout.push(b.dataset.soldout);
      if (mm.mission.kind === 'chain') { mm.rerollCount = (mm.rerollCount || 0) + 1; await issueChain(d, slot, mm.source.id, {}); await saveDay(d); return renderMission(slot); }
      mm.mission = E.replaceItem(mm.mission, b.dataset.soldout, { products: App.data.products, prof: App.prof, soldout: mm.soldout, seed: d.date + slot + mm.soldout.length });
      await saveDay(d); renderMission(slot);
    });
    document.querySelectorAll('[data-sushi-out]').forEach(b => b.onclick = async () => { const d = await getDay(); const mm = d.meals[slot]; mm.soldout.push(b.dataset.sushiOut); mm.rerollCount++; await issueChain(d, slot, mm.source.id, {}); d.meals[slot].soldout = mm.soldout; await saveDay(d); renderMission(slot); });
    document.querySelectorAll('[data-re]').forEach(b => b.onclick = () => reroll(slot, b.dataset.re));
    bindFav(() => renderMission(slot));
    bindFoodList(slot, () => renderMission(slot));
    const mp = $('#ms-photo'); if (mp) mp.onclick = () => clearWithPhoto(slot);
    const mn = $('#ms-manual'); if (mn) mn.onclick = () => clearMeal(slot, null, '手動確認');
    const mm = $('#ms-menu'); if (mm) mm.onclick = () => aiMenuChoose(slot, '通常');
    document.querySelectorAll('[data-alt]').forEach(b => b.onclick = async () => {
      const d = await getDay(); const x = d.meals[slot];
      if ((x.moodRerolls || 0) >= 1) return toast('気分での変更は使い切りました。理由があれば理由を選んでください');
      x.moodRerolls = (x.moodRerolls || 0) + 1;
      const pick = x.mission.alternatives[+b.dataset.alt];
      const rest = [{ items:x.mission.items, sum:x.mission.sum, cmd:x.mission.cmd, verdict:x.mission.verdict, tip:x.mission.tip }, ...x.mission.alternatives.filter((_, i) => i !== +b.dataset.alt)];
      x.mission = { ...x.mission, ...pick, alternatives: rest, note: null };
      await saveDay(d); renderMission(slot);
    });
  }
  function bindFav(after){
    document.querySelectorAll('[data-fav]').forEach(b => b.onclick = async () => {
      const f = new Set(App.prof.favItems || []); const id = b.dataset.fav;
      if (f.has(id)) f.delete(id); else f.add(id);
      App.prof.favItems = [...f]; await DB.set('profile', App.prof);
      toast(f.has(id) ? '★ お気に入りに追加（ときどき優先して出します）' : 'お気に入りを外しました'); after && after();
    });
  }
  function aiOrderHTML(o){
    return `<div class="card gold mission"><div class="small">AIの指令（メニュー写真から）</div><div class="cmd">${o.order.map(x => `「${esc(x.name)}」${x.qty || 1}つ`).join('、')}${o.drinks?.length ? '、飲み物は' + o.drinks.map(x => `「${esc(x.name)}」${x.qty || 1}杯`).join('、') : ''}を注文しろ！</div>
      <div class="small">${o.order.map(x => x.kcal != null ? `${esc(x.name)}：${x.kcal}kcal${x.estimated ? '（AI推定・参考）' : '（メニュー表記）'}` : '').filter(Boolean).join('<br>')}</div>${o.advice ? `<div class="okbox">${esc(o.advice)}</div>` : ''}</div>`;
  }
  async function aiMenuChoose(slot, scene){
    if (!(await S.aiReady())) return sheet(`<h2>AIが未設定です</h2><p class="small">設定 →「APIキー」でGeminiの無料APIキーを設定すると、メニュー写真から料理を選べます。</p><div class="okbox">今はガイドに沿って選び、注文した料理を撮影してクリアしてください。</div><button class="btn" onclick="this.closest('.sheet-bg').remove()">閉じる</button>`);
    const blob = await pickPhoto(); if (!blob) return;
    toast('AIがメニューを読んでいます…');
    const day = await getDay(); const t = targets(day);
    try {
      const o = await S.chooseFromMenu(blob, { kcal: Math.round(t.kcal * (E.mealShare[slot] || 0.3)), protein: Math.round(t.protein * 0.3), budget: App.prof.budget, avoid: [...(App.prof.allergies||[]), ...(App.prof.dislikesList||[])].join('、'), scene });
      const d = await getDay(); const m = d.meals[slot] || (d.meals[slot] = { status:'pending', moodRerolls:0, rerollCount:0, soldout:[] });
      m.aiOrder = o; m.menuPhotoId = await DB.putPhoto(blob, 'menu');
      if (!m.mission) m.mission = { kind:'guide', storeName: scene, cmd: scene + 'でAIの指令どおりに注文しろ！', guide:'' };
      await saveDay(d); renderMission(slot);
    } catch (e) { sheet(`<h2>AIを使えませんでした</h2><p class="small">${esc(e.message)}</p><div class="okbox">ガイドに沿って選び、手動でクリアしてください。</div><button class="btn" onclick="this.closest('.sheet-bg').remove()">閉じる</button>`); }
  }
  async function reroll(slot, reason){
    const day = await getDay(); const m = day.meals[slot];
    const ms = m.mission;
    m.changes = [...(m.changes || []), { reason, at: nowHM() }];
    if (reason === 'mood') {
      if ((m.moodRerolls || 0) >= 1) { await saveDay(day); return toast('気分での変更は使い切りました。ほかの理由なら何度でも変更できます'); }
      m.moodRerolls = (m.moodRerolls || 0) + 1;
    }
    if (reason === 'soldout' || reason === 'allergy') {
      await saveDay(day);
      const list = ms.kind === 'sushi' ? ms.order.map(o => ({ id:'neta:' + o.name, name:o.name })) : (ms.items || []);
      if (!list.length) return toast('入れ替えられる商品がありません。「その他」で選び直せます');
      return sheet(`<h2>${reason === 'soldout' ? 'どれが売り切れ？' : 'どれが合わない？'}</h2><p class="small">同じ店の登録商品から代わりを指定します。</p>${list.map(it => `<button class="btn" data-ex="${esc(it.id)}">${esc(it.name)}</button>`).join('')}${reason === 'allergy' ? '<p class="tiny">設定の「好み・アレルギー・予算」も更新しておくと、次から出ません。</p>' : ''}`, bg => bg.querySelectorAll('[data-ex]').forEach(b => b.onclick = async () => {
        const d = await getDay(); const mm = d.meals[slot]; const id = b.dataset.ex;
        bg.remove();
        if (id.startsWith('neta:')) { mm.soldout.push(id.slice(5)); mm.rerollCount = (mm.rerollCount || 0) + 1; const keep = mm.soldout; await issueChain(d, slot, mm.source.id, {}); d.meals[slot].soldout = keep; }
        else if (mm.mission.kind === 'chain') { mm.soldout.push(id); mm.rerollCount = (mm.rerollCount || 0) + 1; const keep = mm.soldout; await issueChain(d, slot, mm.source.id, {}); d.meals[slot].soldout = keep; }
        else { mm.soldout.push(id); mm.mission = E.replaceItem(mm.mission, id, { products: App.data.products, prof: App.prof, soldout: mm.soldout, seed: d.date + slot + reason + mm.soldout.length }); }
        await saveDay(d); renderMission(slot);
      }));
    }
    if (reason === 'plan') {
      await saveDay(day);
      return sheet(`<h2>予定変更</h2><div class="list card">
          <div class="li" data-pp="store"><span class="t">🏪 別の店にする</span>›</div>
          <div class="li" data-pp="home"><span class="t">🏠 家で食べることになった</span>›</div>
          <div class="li" data-pp="more"><span class="t">⚡ 1日の予定が変わった（飲み会・外食・出張など）</span>›</div></div>`, bg => bg.querySelectorAll('[data-pp]').forEach(el => el.onclick = async () => {
        bg.remove();
        if (el.dataset.pp === 'store') { App.tmp.forceChoose = true; return go('#mealchoose/' + slot); }
        if (el.dataset.pp === 'home') { const d = await getDay(); if (d.schedule?.plan) d.schedule.plan[slot] = 'home'; delete d.meals[slot]; d.replanned = { at:E.localISO(), ts:Date.now(), kind:'home' }; await saveDay(d); return renderHomeMeal(slot); }
        replanSheet();
      }));
    }
    m.rerollCount = (m.rerollCount || 0) + 1;
    const opt = reason === 'more' ? { bigger:true, appetite:'big' } : reason === 'sick' ? { lighter:true, appetite:'light' } : {};
    const keep = { moodRerolls: m.moodRerolls, rerollCount: m.rerollCount, changes: m.changes, soldout: m.soldout };
    if (m.source?.type === 'conv') await issueConv(day, slot, m.source.id, opt);
    else if (m.source?.type === 'chain') await issueChain(day, slot, m.source.id, opt);
    else { await saveDay(day); toast('この店は登録メニューが無いので、メニュー写真かガイドで選んでください'); return renderMission(slot); }
    Object.assign(day.meals[slot], keep);
    if (reason === 'sick') day.meals[slot].mission.tip = '体調が悪い時は無理に食べず、消化の良いもの・水分を優先。つらい時は受診を。';
    if (reason === 'more') day.meals[slot].mission.tip = '量を増やした指令です。ゆっくり食べて満足感を。';
    await saveDay(day); renderMission(slot);
  }
  async function clearWithPhoto(slot){
    const blob = await pickPhoto(); if (!blob) return;
    const day = await getDay(); const m = day.meals[slot];
    const pid = await DB.putPhoto(blob, 'meal');
    let note = '手動確認';
    if (await S.aiReady() && m.mission?.items?.length) {
      toast('AIが写真を確認中…');
      try {
        const r = await S.verifyPurchase(blob, m.mission.items.map(i => i.name));
        note = r.missing?.length ? `AI：${r.missing.join('・')} が見当たりません（${r.comment || ''}）` : `AI確認OK${r.comment ? '：' + r.comment : ''}`;
        if (r.missing?.length) {
          return sheet(`<h2>AIの確認結果</h2><div class="warnbox">${esc(note)}</div><p class="small">写り方の問題かもしれません。実際に買っていればそのままクリアでOK。</p><button class="btn primary" id="okc">買ったのでクリア</button><button class="btn" id="retake">撮り直す</button>`, bg => {
            bg.querySelector('#okc').onclick = () => { bg.remove(); clearMeal(slot, pid, '本人確認（AI一部不一致）'); };
            bg.querySelector('#retake').onclick = () => { bg.remove(); clearWithPhoto(slot); };
          });
        }
      } catch (e) { note = '手動確認（' + e.message + '）'; }
    }
    clearMeal(slot, pid, note);
  }
  async function clearMeal(slot, photoId, note){
    const day = await getDay(); const m = day.meals[slot];
    m.status = 'cleared'; m.photoId = photoId || m.photoId; m.clearNote = note; { const st = E.stamp(); m.clearedAt = st.iso; m.clearedTs = st.ts; m.clearedHM = st.hm; }
    await saveDay(day);
    await award(m.homeRecord ? 'homeMeal' : 'meal', E.MEAL_LABEL[slot] + 'ミッション', { big:true, sub: m.homeRecord ? '家ごはんを記録！' : (m.mission?.storeName ? E.shortStore(m.mission.storeName) + 'の指令を完遂！' : '指令どおり！') });
    go('#home');
  }

  /* 時間が過ぎた食事：指令ではなく「記録する」画面 */
  async function renderLate(slot){
    const day = await getDay();
    view(`${back()}<div class="kicker">RECORD ・ ${E.MEAL_LABEL[slot]}</div><h1>${E.MEAL_LABEL[slot]}を記録する</h1>
      <p class="small">いまは ${nowHM()}。${E.MEAL_LABEL[slot]}の時間は過ぎているので、食べていたら写真で記録だけしておこう。これからの食事は${E.MEAL_LABEL[focusMeal(day) || 'dinner']}を優先します。</p>
      <button class="btn primary" id="lt-photo">📷 撮影して記録</button>
      <button class="btn" onclick="App.tmp.foodDraft=null;App.tmp.foodIdx=null;App.tmp.foodType=null;App.go('#food/${slot}')">🍞 内容（パン・ご飯など）を入れて記録</button>
      <button class="btn" id="lt-nophoto">写真なしで「食べた」と記録</button>
      <button class="btn ghost" id="lt-skip">食べていない</button>
      <button class="btn ghost" onclick="App.tmp.forceChoose=true;App.go('#mealchoose/${slot}')">今から買う・食べに行く（指令を出す）</button>`);
    const rec = async (blob, memo) => {
      const d = await getDay(); const mm = d.meals[slot] || (d.meals[slot] = { soldout:[] });
      const st = E.stamp();
      Object.assign(mm, { homeRecord:true, late:true, memo, status:'cleared', clearNote:'後から記録', clearedAt:st.iso, clearedTs:st.ts, clearedHM:st.hm });
      if (blob) mm.photoId = await DB.putPhoto(blob, 'meal');
      await saveDay(d);
      await award('homeMeal', E.MEAL_LABEL[slot] + 'を記録', { big:true, sub:'記録できた！' });
      askFoodDetail(slot);
    };
    $('#lt-photo').onclick = async () => { const b = await pickPhoto(); if (b) rec(b, '後から記録'); };
    $('#lt-nophoto').onclick = () => rec(null, '後から記録（写真なし）');
    $('#lt-skip').onclick = async () => { const d = await getDay(); d.meals[slot] = { ...(d.meals[slot] || {}), status:'skipped', skippedAt: nowHM(), soldout:[] }; await saveDay(d); toast(`${E.MEAL_LABEL[slot]}は「なし」にしました（減点はありません）`); go('#home'); };
  }

  /* 自宅の食事：撮影して記録だけ（献立は指示しない） */
  async function recordHomeMeal(slot, blob, memo){
    const d = await getDay(); const mm = d.meals[slot] || (d.meals[slot] = { soldout:[] });
    mm.homeRecord = true; mm.photoId = await DB.putPhoto(blob, 'homeMeal'); mm.memo = memo || ''; mm.status = 'cleared'; { const st = E.stamp(); mm.clearedAt = st.iso; mm.clearedTs = st.ts; mm.clearedHM = st.hm; }
    await saveDay(d);
    await award('homeMeal', E.MEAL_LABEL[slot] + '（家ごはん）', { big:true, sub:'作ってくれた料理を記録！' });
    if (await S.aiReady()) { try { const r = await S.describeMeal(blob); const d2 = await getDay(); d2.meals[slot].dishes = r.dishes; await saveDay(d2); } catch {} }
    askFoodDetail(slot);
  }
  /* 写真だけで分からない食品（パン・ご飯・麺・惣菜など）は、必要なら詳しく聞く */
  async function askFoodDetail(slot){
    if (App.settings.askFoodDetail === false) return go('#home');
    const d = await getDay(); const dishes = (d.meals[slot]?.dishes || []).join(' ');
    const guess = /食パン|トースト/.test(dishes) ? 'shokupan' : /パン|サンド/.test(dishes) ? 'bread' : /ご飯|ライス|丼/.test(dishes) ? 'rice' : /うどん|そば|ラーメン|パスタ|麺|焼きそば/.test(dishes) ? 'noodle' : null;
    sheet(`<h2>何を食べた？（任意）</h2>
      <p class="small">パン・ご飯・麺・惣菜は写真だけだと量が分かりません。種類を選ぶと、枚数・量・トッピングを聞いてカロリーの精度を上げます。</p>
      <div class="grid3">${Object.entries(F.TYPES).map(([k, t]) => `<button class="tile ${k === guess ? 'focus' : ''}" data-ft="${k}" style="min-height:84px"><span class="em">${t.em}</span><b>${t.short}</b></button>`).join('')}</div>
      <button class="btn" id="fd-skip">今回はスキップ</button>
      <p class="tiny">毎回聞かないようにするには、設定 →「好み・アレルギー・予算」。</p>`, bg => {
      bg.querySelectorAll('[data-ft]').forEach(b => b.onclick = () => { bg.remove(); App.tmp.foodDraft = null; App.tmp.foodIdx = null; App.tmp.foodType = b.dataset.ft; go('#food/' + slot); });
      bg.querySelector('#fd-skip').onclick = () => { bg.remove(); go('#home'); };
      bg.addEventListener('click', e => { if (e.target === bg) go('#home'); });
    });
  }
  App.askFoodDetail = askFoodDetail;

  /* ================= 食事の詳細記録（公式値を優先・なければ推定） ================= */
  function foodListHTML(slot, m){
    const foods = m?.foods || [];
    const sum = F.sumFoods(foods);
    return `<div class="card"><div class="kicker">FOOD LOG</div><b>食べた物の内容</b>
      ${foods.length ? foods.map((f, i) => `<div class="item"><div class="nm">${F.TYPES[f.type]?.em || '🍽'} ${esc(F.title(f))}</div>
          ${f.where || f.brand ? `<div class="meta">${esc((F.WHERE.find(w => w[0] === f.where) || [])[1] || '')}${f.where && f.brand ? '・' : ''}${esc(f.brand || '')}</div>` : ''}
          <div class="nut"><span class="${f.estimated ? 'est' : 'off'}">${f.estimated ? '推定' : '公式値'}</span><span>${esc(F.kcalLabel(f))}</span></div>
          <div><button class="btn sm" data-fedit="${i}">直す</button> <button class="btn sm ghost" data-fdel="${i}">削除</button></div></div>`).join('')
        : `<p class="small">パン・ご飯・麺・惣菜などは、量や規格を入れるとカロリーの精度が上がります。</p>`}
      ${foods.length ? `<div class="small" style="margin-top:6px">合計 ${sum.kcal}kcal${sum.estimated ? `（うち推定 ${sum.estimated}kcal・公式値 ${sum.official}kcal）` : '（すべて公式値）'}</div>` : ''}
      <button class="btn" data-fadd="${slot}">＋ 食べた物を追加</button></div>`;
  }
  function bindFoodList(slot, after){
    document.querySelectorAll('[data-fadd]').forEach(b => b.onclick = () => { App.tmp.foodDraft = null; App.tmp.foodIdx = null; App.tmp.foodType = null; go('#food/' + slot); });
    document.querySelectorAll('[data-fedit]').forEach(b => b.onclick = async () => { const d = await getDay(); App.tmp.foodIdx = +b.dataset.fedit; App.tmp.foodDraft = JSON.parse(JSON.stringify(d.meals[slot].foods[+b.dataset.fedit])); App.tmp.foodDraft.kcalEdited = true; go('#food/' + slot); });
    document.querySelectorAll('[data-fdel]').forEach(b => b.onclick = async () => { if (!confirm('この記録を削除しますか？')) return; const d = await getDay(); d.meals[slot].foods.splice(+b.dataset.fdel, 1); await saveDay(d); after(); });
  }

  async function renderFood(slot){
    const day = await getDay();
    const m = day.meals[slot] || {};
    if (!App.tmp.foodDraft) App.tmp.foodDraft = { type: App.tmp.foodType || null, count: 1, toppings: {}, where: null, brand: '', product: '' };
    const dr = App.tmp.foodDraft;
    const editing = App.tmp.foodIdx != null;
    const backTo = '#meal/' + slot;
    if (!dr.type) {
      view(`${back(backTo)}<div class="kicker">FOOD LOG ・ ${E.MEAL_LABEL[slot]}</div><h1>何を食べた？</h1>
        <div class="grid3">${Object.entries(F.TYPES).map(([k, t]) => `<button class="tile" data-ft="${k}"><span class="em">${t.em}</span><b>${t.short}</b></button>`).join('')}</div>`);
      document.querySelectorAll('[data-ft]').forEach(b => b.onclick = () => { dr.type = b.dataset.ft; renderFood(slot); });
      return;
    }
    const T = F.TYPES[dr.type];
    if (T.sizes && !dr.size) dr.size = T.kinds ? 'm' : dr.type === 'shokupan' ? '6' : dr.type === 'bread' ? T.sizes[0][0] : (T.sizes[1] || T.sizes[0])[0];
    if (T.kinds && !dr.kind) dr.kind = T.kinds[0][0];
    const chips = (k, opts, cur) => `<div class="chips" data-fk="${k}">${opts.map(([v, l]) => `<span class="chip ${String(cur) === String(v) ? 'on' : ''}" data-v="${esc(v)}">${esc(l)}</span>`).join('')}</div>`;
    const sugg = F.suggestions(App.data);
    const unitWord = T.unit === '枚' ? '枚数' : T.unit === '杯' ? '量（杯）' : T.unit.includes('/') ? '量（個・人前）' : '個数';
    view(`${back(backTo)}<div class="kicker">FOOD LOG ・ ${E.MEAL_LABEL[slot]}</div><h1>${T.em} ${T.label}${editing ? 'を直す' : 'を記録'}</h1>
      <div class="card"><b>どこで買った？</b>${chips('where', F.WHERE, dr.where)}
        ${T.askBrand ? `<label>店名・メーカー・ブランド（分かれば）</label><input id="fd-brand" value="${esc(dr.brand || '')}" placeholder="${dr.type === 'shokupan' ? '例：メーカー名、パン屋の名前' : '例：セブン-イレブン、○○ベーカリー'}">` : ''}
        <label>商品名（分かれば）</label><input id="fd-product" list="fd-sugg" value="${esc(dr.product || '')}" placeholder="登録済みの商品なら公式値を使います">
        <datalist id="fd-sugg">${sugg.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
        <div id="fd-official" class="tiny" style="margin-top:6px"></div></div>
      <div class="card">
        ${T.kinds ? `<b>${T.kindLabel}</b>${chips('kind', T.kinds.map(k => [k[0], k[1]]), dr.kind)}<b style="display:block;margin-top:14px">${T.sizeLabel}</b>${chips('size', T.sizes.map(x => [x[0], x[1]]), dr.size)}`
          : T.sizes ? `<b>${T.sizeLabel}</b>${chips('size', T.sizes.map(x => [x[0], x[1]]), dr.size)}` : ''}
        ${T.manual ? `<label>カロリーが分かれば（パッケージの表示など）</label><input id="fd-manual" type="number" inputmode="numeric" value="${esc(dr.manualKcal ?? '')}" placeholder="例 320">` : ''}
        <b style="display:block;margin-top:14px">食べた${unitWord}</b>
        <div class="stepper"><button class="btn sm" data-cnt="-0.5">−</button><input id="fd-count" type="number" step="0.5" inputmode="decimal" value="${dr.count}"><button class="btn sm" data-cnt="0.5">＋</button></div></div>
      ${T.toppings.length ? `<div class="card"><b>のせた物・つけた物</b><div class="small">タップするたびに1回分ずつ追加（3回の次は0に戻ります）。</div>
        <div class="chips">${T.toppings.map(id => { const tp = F.TOPPINGS[id]; const n = dr.toppings[id] || 0; return `<span class="chip ${n ? 'on' : ''}" data-tp="${id}">${tp.label}${n ? ` ×${n}` : ''}<span class="tiny" style="margin-left:5px">${tp.unit}</span></span>`; }).join('')}</div></div>` : ''}
      <div class="card gold" id="fd-result"></div>
      ${await S.aiReady() ? `<button class="btn" id="fd-ai">🤖 写真と入力内容からAIで推定</button>` : ''}`,
      `<button class="btn primary" id="fd-save">${editing ? '直して保存' : 'この内容で記録'}</button>`);
    const update = () => {
      const off = F.findOfficial(dr.product, App.data);
      const o = $('#fd-official');
      if (o) o.innerHTML = off ? (off.kcal != null ? `✅ 公式データあり：${esc(off.store)}「${esc(off.name)}」1${T.unit}あたり ${off.kcal}kcal（確認日 ${esc(off.verifiedAt || '不明')}）` : `登録データはありますが、公式の栄養成分が未登録です${off.note ? '（' + esc(off.note) + '）' : ''}。量から推定します。`) : (dr.product ? '登録済みの商品には見つかりません。量から推定します。' : '');
      const c = F.calc(dr, off);
      dr._calc = c; dr._off = off;
      if (!dr.kcalEdited) dr.kcal = c.suggested;
      $('#fd-result').innerHTML = `<div class="kicker">${c.onlyOfficial ? 'OFFICIAL' : 'ESTIMATE'}</div>
        ${!c.has ? `<div class="small">カロリーを出すには、${T.manual ? 'カロリーを入力するか、AIで推定してください' : '量を選んでください'}。</div>` :
          c.onlyOfficial ? `<div class="kc"><span class="pill ok">公式値</span><b>${c.official}kcal</b></div>` :
          `${c.official ? `<div class="kc"><span class="pill ok">公式値</span><b>${c.official}kcal</b></div><div class="kc"><span class="pill warn">推定</span><b>＋ ${c.estMin}〜${c.estMax}kcal</b></div>` : `<div class="kc"><span class="pill warn">推定</span><b>${c.min}〜${c.max}kcal</b></div>`}`}
        ${c.has ? `<label>記録値（kcal）${c.onlyOfficial ? '' : '　※推定として保存されます'}</label><input id="fd-kcal" type="number" inputmode="numeric" value="${dr.kcal ?? ''}">` : ''}
        <div class="tiny" style="margin-top:8px">根拠：${esc(c.basis || '—')}${c.onlyOfficial ? '' : '。推定値は公式値ではありません。'}</div>`;
      const k = $('#fd-kcal'); if (k) k.oninput = () => { dr.kcal = k.value === '' ? null : +k.value; dr.kcalEdited = true; };
    };
    update();
    const reset = () => { dr.kcalEdited = false; dr.ai = null; };
    const bindText = (id, key, num) => { const el = $(id); if (el) el.oninput = () => { dr[key] = num ? (el.value === '' ? null : +el.value) : el.value; if (key !== 'brand') reset(); update(); }; };
    bindText('#fd-brand', 'brand'); bindText('#fd-product', 'product'); bindText('#fd-manual', 'manualKcal', true);
    const cnt = $('#fd-count'); cnt.oninput = () => { dr.count = Math.max(0.5, +cnt.value || 1); reset(); update(); };
    document.querySelectorAll('[data-cnt]').forEach(b => b.onclick = () => { dr.count = Math.max(0.5, Math.round(((+dr.count || 1) + +b.dataset.cnt) * 2) / 2); cnt.value = dr.count; reset(); update(); });
    document.querySelectorAll('[data-fk]').forEach(g => g.onclick = e => { const c = e.target.closest('.chip'); if (!c) return; dr[g.dataset.fk] = c.dataset.v; if (g.dataset.fk !== 'where') reset(); App.tmp.keepScroll = window.scrollY; renderFood(slot); });
    document.querySelectorAll('[data-tp]').forEach(c => c.onclick = () => { const id = c.dataset.tp; dr.toppings[id] = ((dr.toppings[id] || 0) + 1) % 4; reset(); App.tmp.keepScroll = window.scrollY; renderFood(slot); });
    const ai = $('#fd-ai'); if (ai) ai.onclick = async () => {
      let blob = m.photoId ? await DB.getPhoto(m.photoId) : null;
      if (!blob) { blob = await pickPhoto(); if (!blob) return; }
      toast('AIが推定しています…');
      try {
        const r = await S.estimateFood(blob, { 種類:T.label, 店:dr.brand, 商品名:dr.product, 規格:(T.sizes?.find(x => x[0] === dr.size) || [])[1], 種類詳細:(T.kinds?.find(x => x[0] === dr.kind) || [])[1], 数量:dr.count + T.unit, トッピング:Object.entries(dr.toppings).filter(([, n]) => n).map(([id, n]) => F.TOPPINGS[id].label + '×' + n) });
        if (r.kcal_min == null || r.kcal_max == null) throw new Error('AIが推定できませんでした');
        dr.ai = { min: Math.round(Math.min(r.kcal_min, r.kcal_max)), max: Math.round(Math.max(r.kcal_min, r.kcal_max)), note: r.note || '' }; dr.kcalEdited = false; update(); toast('AIの推定を反映しました（推定値です）');
      } catch (e) { toast(e.message); }
    };
    $('#fd-save').onclick = async () => {
      update();
      const c = dr._calc, off = dr._off;
      if (!c.has && dr.kcal == null) return toast('量を選ぶか、カロリーを入力してください');
      const st = E.stamp();
      const kcal = dr.kcal != null && dr.kcal !== '' ? Math.round(+dr.kcal) : c.suggested;
      // 公式値をそのまま使った時だけ「公式」。少しでも推定や手直しが入れば推定として保存
      const estimated = !(c.onlyOfficial && kcal === c.official);
      const entry = { type: dr.type, where: dr.where, brand: dr.brand || '', product: dr.product || '', size: dr.size || null, kind: dr.kind || null, count: +dr.count || 1, toppings: { ...dr.toppings },
        manualKcal: dr.manualKcal ?? null, ai: dr.ai || null,
        kcal, estimated, min: c.min, max: c.max, estMin: c.estMin, estMax: c.estMax, officialKcal: c.official || null,
        officialRef: off && off.kcal != null ? { id: off.id, name: off.name, store: off.store, url: off.url || null, verifiedAt: off.verifiedAt || null } : null,
        source: dr.ai ? 'ai' : !estimated ? 'official' : c.official ? 'official+estimate' : T.manual && dr.manualKcal != null ? 'manual' : 'estimate',
        basis: c.basis, at: st.hm, ts: st.ts };
      const d = await getDay(); const mm = d.meals[slot] || (d.meals[slot] = { soldout:[] });
      mm.foods = mm.foods || [];
      if (editing && mm.foods[App.tmp.foodIdx]) mm.foods[App.tmp.foodIdx] = entry; else mm.foods.push(entry);
      const firstRecord = mm.status !== 'cleared';
      if (firstRecord) Object.assign(mm, { homeRecord: !mm.mission, status:'cleared', clearNote:'内容を記録', clearedAt: st.iso, clearedTs: st.ts, clearedHM: st.hm });
      const bonusOnce = !mm.foodXp; mm.foodXp = true;
      await saveDay(d);
      App.tmp.foodDraft = null; App.tmp.foodIdx = null; App.tmp.foodType = null;
      if (firstRecord) await award('homeMeal', E.MEAL_LABEL[slot] + 'を記録', { big:true, sub:'内容まで記録！' });
      else if (bonusOnce && !editing) await award('foodDetail', '食事の内容を記録');
      else toast('保存しました');
      go('#meal/' + slot);
    };
  }

  async function renderHomeMeal(slot){
    const day = await getDay(); const m = day.meals[slot] || {};
    const photo = await photoURL(m.photoId);
    view(`${back()}<div class="kicker" style="margin-top:6px">MISSION ・ ${E.MEAL_LABEL[slot]}</div><h1>🏠 家ごはんを撮影しろ！</h1>
      <p class="small">作ってくれた料理をそのまま楽しもう。写真で記録するだけでOK。おかわりする時は、ご飯よりおかずを。</p>
      ${photo ? `<img class="photo" src="${photo}">` : ''}${m.dishes ? `<div class="card"><b>記録：</b>${esc(m.dishes.join('、'))}</div>` : ''}
      ${m.status === 'cleared' ? `<div class="okbox">✅ ${esc(m.clearedHM || '')} 記録済み</div>${foodListHTML(slot, m)}` : ''}
      <label>メモ（任意）</label><input id="hm-note" value="${esc(m.memo || '')}" placeholder="例：焼き魚、味噌汁、ご飯半分">`,
      m.status === 'cleared' ? `<button class="btn" onclick="App.go('#home')">ホームへ</button>` : `<button class="btn primary" id="hm-photo">📷 撮影して記録</button>`);
    bindFoodList(slot, () => renderHomeMeal(slot));
    const b = $('#hm-photo'); if (!b) return;
    b.onclick = async () => {
      const blob = await pickPhoto(); if (!blob) return;
      await recordHomeMeal(slot, blob, $('#hm-note').value);
    };
  }

  /* 飲み会 */
  async function renderDrinking(slot){
    const day = await getDay(); day.alcohol = day.alcohol || [];
    const g = day.alcohol.reduce((s, a) => s + a.g, 0);
    view(`${back()}<div class="kicker" style="margin-top:6px">MISSION ・ 飲み会</div><h1>🍻 飲み会を乗り切れ！</h1>
      <div class="card gold mission"><div class="cmd">1杯目の前に水をコップ1杯飲め！ お酒は純アルコール20gまで、つまみは${E.IZAKAYA_FOOD.slice(0,4).join('・')}から頼め！</div>
      <div class="small">揚げ物・締めのラーメンは今日は見送り。お酒1杯ごとに水1杯。無糖のお酒でもアルコールの量は同じです。</div></div>
      <button class="btn primary" id="dk-menu">📷 メニュー表を撮ってAIに注文を決めさせる</button>
      ${day.meals[slot]?.aiOrder ? aiOrderHTML(day.meals[slot].aiOrder) : ''}
      <h2>飲んだお酒を記録（今日 ${g.toFixed(1)}g）</h2>
      ${g >= 20 ? `<div class="warnbox">純アルコール${g.toFixed(1)}g。目安の20gを超えました。ここからは水かお茶にしろ！</div>` : ''}
      <div class="list card">${E.DRINKS_ALC.map((d, i) => `<div class="li"><span class="t">${d.name}<div class="tiny">${d.ml}ml・${d.abv}% → 約${E.alcoholG(d.ml, d.abv)}g（一般的な量での概算）</div></span><button class="btn sm" data-alc="${i}">＋1杯</button></div>`).join('')}</div>`,
      (day.meals[slot]?.status === 'cleared' ? `<div class="okbox" style="flex:2;margin:0">✅ 食事はクリア済み</div>` : `<button class="btn primary" id="dk-done" style="flex:2">📷 撮影してクリア</button>`) + (day.flags?.drinkEnd ? '' : `<button class="btn" id="dk-end" style="flex:1">🏁 飲み会終了</button>`));
    if ($('#dk-end')) $('#dk-end').onclick = async () => {
      const d = await getDay(); const gsum = (d.alcohol || []).reduce((a, x) => a + x.g, 0);
      if (d.flags?.drinkEnd) return toast('記録済みです');
      d.flags = { ...(d.flags || {}), drinkEnd: true }; await saveDay(d);
      if (gsum <= 20) await award('check', '飲み会', { xp:0, bonus:['drinkWell'], title:'ナイス乗り切り！', sub:`純アルコール約${gsum.toFixed(0)}g。上手にコントロールできた！`, big:true });
      else { await award('check', '', { xp:0, silent:true }); sheet(`<h2>🍻 おつかれさま！</h2><div class="okbox">楽しめたなら OK。減点はありません。<br>寝る前に水を1杯。明日は「リカバリーミッション」で戻そう。</div><button class="btn primary" onclick="this.closest('.sheet-bg').remove();App.go('#home')">ホームへ</button>`); return; }
      go('#home');
    };
    $('#dk-menu').onclick = () => aiMenuChoose(slot, '飲み会');
    document.querySelectorAll('[data-alc]').forEach(b => b.onclick = async () => { const d = await getDay(); d.alcohol = d.alcohol || []; const x = E.DRINKS_ALC[+b.dataset.alc]; d.alcohol.push({ name:x.name, g:E.alcoholG(x.ml, x.abv), at:new Date().toTimeString().slice(0,5) }); await saveDay(d); renderDrinking(slot); });
    if ($('#dk-done')) $('#dk-done').onclick = async () => { const blob = await pickPhoto(); if (!blob) return; const d = await getDay(); const m = d.meals[slot] || (d.meals[slot] = { soldout:[] }); m.drinking = true; m.mission = m.mission || { kind:'guide', storeName:'飲み会', cmd:'飲み会', guide:'' }; await saveDay(d); clearMeal(slot, await DB.putPhoto(blob, 'meal'), '飲み会'); };
  }

  /* ゴルフ場の昼食 */
  async function renderGolfMeal(slot){
    const day = await getDay(); const g = day.schedule?.golf || {};
    const m = day.meals[slot];
    view(`${back()}<h1>⛳ ゴルフ場の${E.MEAL_LABEL[slot]}</h1>
      <div class="card gold mission"><div class="cmd">${esc(g.course || 'ゴルフ場')}では、そば・うどん系か焼魚の定食を選べ！ ご飯は少なめ、揚げ物とビールは控えろ。</div><div class="small">後半もプレーが続くので、食べすぎず・抜かずに。水分も一緒に。</div></div>
      <button class="btn primary" id="gm-menu">📷 メニューを撮ってAIに選ばせる</button>
      ${m?.aiOrder ? aiOrderHTML(m.aiOrder) : ''}`,
      `<button class="btn" id="gm-done">📷 食べた物を撮影してクリア</button>`);
    $('#gm-menu').onclick = () => aiMenuChoose(slot, 'ゴルフ場のレストラン');
    $('#gm-done').onclick = async () => { const blob = await pickPhoto(); if (!blob) return; const d = await getDay(); const mm = d.meals[slot] || (d.meals[slot] = { soldout:[] }); mm.mission = mm.mission || { kind:'guide', storeName:'ゴルフ場', cmd:'ゴルフ場', guide:'' }; await saveDay(d); clearMeal(slot, await DB.putPhoto(blob, 'meal'), 'ゴルフ場'); };
  }

  /* 朝まとめ買いリスト */
  async function renderBulk(){
    const day = await getDay();
    const ms = ['breakfast','lunch'].map(s => [s, day.meals[s]?.mission]).filter(x => x[1] && !x[1].error);
    if (!ms.length) return go('#home');
    view(`${back()}<h1>🛒 朝のまとめ買いリスト</h1>
      ${ms.map(([s, m]) => `<h2>${E.MEAL_LABEL[s]}</h2><div class="card gold mission"><div class="cmd" style="font-size:16px">${esc(m.cmd)}</div>${m.items.map(it => itemHTML(it)).join('')}</div>`).join('')}
      <p class="small">買ったら「食事ミッション」から各食事を開いて、食べる前に撮影してクリア。</p>`,
      `<button class="btn primary" onclick="App.go('#meal/breakfast')">朝食ミッションへ</button>`);
  }

  /* ================= お助け間食 ================= */
  async function renderSnack(){
    const st = App.settings.snackStore || 'seven';
    view(`${back()}<div class="kicker" style="margin-top:6px">SUPPORT</div><h1>🆘 お助け間食</h1><p class="small">お腹が空いたら我慢しなくていい。ちょうどいい1品を指令します。</p>
      <div class="chips" id="sn-st">${App.data.convenience.map(c => `<span class="chip ${c.id===st?'on':''}" data-s="${c.id}">${E.shortStore(c.name)}</span>`).join('')}</div>
      <div class="grid2" style="margin-top:10px">
        <button class="tile" data-mood="sweet"><span class="em">🍰</span><b>甘いもの</b></button>
        <button class="tile" data-mood="salty"><span class="em">🧂</span><b>しょっぱいもの</b></button>
        <button class="tile" data-mood="hungry"><span class="em">🍙</span><b>しっかり食べたい</b></button>
        <button class="tile" data-mood="light"><span class="em">🌿</span><b>軽くつまみたい</b></button></div>
      <div id="sn-out"></div>`);
    $('#sn-st').onclick = async e => { const c = e.target.closest('.chip'); if (!c) return; App.settings.snackStore = c.dataset.s; await DB.set('settings', App.settings); renderSnack(); };
    document.querySelectorAll('[data-mood]').forEach(b => b.onclick = async () => {
      const conv = App.data.convenience.find(c => c.id === (App.settings.snackStore || 'seven'));
      App.tmp.snackN = (App.tmp.snackN || 0) + 1;
      const ms = E.snackMission({ products: App.data.products, store: conv.id, storeName: conv.name, mood: b.dataset.mood, prof: App.prof, seed: E.today() + b.dataset.mood + App.tmp.snackN });
      $('#sn-out').innerHTML = ms.error ? `<div class="warnbox">${esc(ms.error)}</div>` : `<div class="card gold mission" style="margin-top:12px"><div class="kicker">MISSION</div><div class="cmd">${esc(ms.cmd)}</div>${ms.items.map(it => itemHTML(it)).join('')}<div class="okbox">${esc(ms.tip)}</div><button class="btn primary" id="sn-eat">これにした！</button><button class="btn ghost" id="sn-again">別のにする</button></div>`;
      if (ms.error) return;
      $('#sn-again').onclick = () => b.click();
      bindFav(null);
      $('#sn-eat').onclick = async () => {
        const d = await getDay(); d.snacks.push({ at: nowHM(), items: ms.items.map(i => i.name), sum: ms.sum, via:'helper' }); await saveDay(d);
        const nice = d.snacks.filter(x => x.via === 'helper').length <= 2;   // 1日2回までボーナス（我慢ではなく選び方を評価）
        await award('snackLog', 'お助け間食', { bonus: nice ? ['snackNice'] : [], title:'ナイスチョイス！', sub:'ちょうどいい1品を選べた' });
        go('#home');
      };
    });
  }

  /* ================= 飲み物 ================= */
  async function renderDrinks(){
    const day = await ensureDay(await getDay());
    const ctx = await drinkCtx(day);
    const caf = ctx.caffeineMg;
    const place = ctx.place;
    const vendCaf = ctx.vending.filter(i => i.caffeineMg);
    view(`${back()}<div class="kicker" style="margin-top:6px">HYDRATION</div><h1>💧 飲み物ミッション</h1>
      <div class="sectlabel">現在地</div>
      <div class="placebar">${Object.entries(E.PLACES).map(([k, v]) => `<button class="pchip ${k === place ? 'on' : ''}" data-place="${k}">${v.em}<span>${v.label}</span></button>`).join('')}</div>
      <p class="tiny">場所に合わせて指令が変わります。飲み物のためだけに買い物はさせません。</p>
      <div class="list card">${(() => { const cd = E.currentDrink(day.drinks, ctx.now); return day.drinks.map(d => {
          const isCur = cd && cd.slot.id === d.id;
          const t = d.done && d.said ? d.said.replace(/^水分補給がまだです。今、/, '') : d.missed ? '時間内に収まらず見送り（減点なし）' : E.drinkMission(d, ctx).text;
          return `<div class="li drow ${d.done ? 'isdone' : ''} ${isCur ? 'iscur' : ''}"><span class="t"><span class="when">${esc(E.drinkHistoryLabel(d))}${isCur && cd.state === 'now' ? '<b class="nowtag">いま</b>' : ''}</span><span class="${d.done || d.missed ? 'small' : ''}">${esc(t)}</span></span>${d.done ? `<span class="done">✓</span>` : d.missed ? `<span class="tiny">—</span>` : `<button class="btn sm ok" data-drink="${esc(d.id)}">飲んだ！</button>`}</div>`; }).join(''); })()}</div>
      <p class="tiny">時刻は「予定 → 実際に飲んだ時刻」。遅れて飲んだら、そのあとの目安は飲んだ時刻から計算し直します。</p>
      <h2>☕ コーヒー・カフェイン</h2><p class="small" style="margin-top:-4px">今日 約${caf}mg・コーヒー${ctx.coffeeCount}杯</p>
      ${E.caffeineAdvice(caf, App.prof.sleep).map(m => `<div class="warnbox">${esc(m)}</div>`).join('')}
      <div class="card"><div class="chips">
        ${E.COFFEE_PRESETS.map((c, i) => `<span class="chip" data-cf="${i}">${c.label}</span>`).join('')}
        ${vendCaf.map((v, i) => `<span class="chip" data-vcf="${i}">${esc(v.place)}：${esc(v.name)}${v.size ? ' ' + esc(v.size) : ''}</span>`).join('')}</div>
      <p class="tiny">カフェインは日本食品標準成分表の浸出液の値（コーヒー60mg/100ml）からの概算。自販機に登録した商品は、その表示値を使います。</p>
      ${(day.caffeine || []).length ? `<div class="small">${day.caffeine.map(c => `${c.at} ${esc(c.name)}（約${c.mg}mg）`).join('<br>')}</div>` : ''}</div>`);
    bindDrinkButtons();
    document.querySelectorAll('[data-place]').forEach(b => b.onclick = async () => { await setPlace(b.dataset.place); renderDrinks(); });
    document.querySelectorAll('[data-cf]').forEach(b => b.onclick = async () => { const c = E.COFFEE_PRESETS[+b.dataset.cf]; await logCoffee(c.label, c.mg ?? E.caffeineEstimate('coffee', c.ml)); renderDrinks(); });
    document.querySelectorAll('[data-vcf]').forEach(b => b.onclick = async () => { const v = vendCaf[+b.dataset.vcf]; await logCoffee(v.name + (v.size ? ' ' + v.size : ''), v.caffeineMg); renderDrinks(); });
  }

  /* ================= トレーニング ================= */
  async function renderTrain(){
    const o = App.tmp.train || App.settings.lastTrain || { place: curPlace(await getDay()) === 'office' ? 'office' : 'home', min:15, goal:'fat' };
    const ch = (k, opts) => `<div class="chips" data-k="${k}">${opts.map(([v,l]) => `<span class="chip ${String(o[k])===String(v)?'on':''}" data-v="${v}">${l}</span>`).join('')}</div>`;
    view(`${back()}<div class="kicker" style="margin-top:6px">TRAINING</div><h1>💪 トレーニング</h1>
      <label>場所</label>${ch('place', [['home','自宅'],['office','会社'],['gym','ジム'],['outdoor','屋外']])}
      <label>時間</label>${ch('min', [[5,'5分'],[10,'10分'],[15,'15分'],[20,'20分'],[30,'30分']])}
      <label>目的</label>${ch('goal', [['fat','脂肪燃焼'],['strength','筋力'],['cardio','有酸素']])}
      <div id="tr-out"></div>`, `<button class="btn primary" id="tr-go">メニューを指令しろ！</button>`);
    document.querySelectorAll('[data-k]').forEach(g => g.onclick = e => { const c = e.target.closest('.chip'); if (!c) return; o[g.dataset.k] = isNaN(c.dataset.v) ? c.dataset.v : +c.dataset.v; App.tmp.train = o; renderTrain(); });
    const show = () => {
      App.tmp.trainN = (App.tmp.trainN || 0) + 1;
      const plan = E.trainingPlan(o.place, o.min, o.goal, E.today() + App.tmp.trainN);
      $('#tr-out').innerHTML = `<div class="card gold mission" style="margin-top:12px"><div class="kicker">MISSION</div><div class="cmd">この順番でやれ！</div><div class="list">${plan.map((p, i) => `<div class="li"><span class="small">${i+1}</span><span class="t"><b>${esc(p.name)}</b><div class="small">${esc(p.detail)}</div></span></div>`).join('')}</div><div class="tiny">痛みが出たら中止。体調が悪い日は休むのもミッション。</div><button class="btn ok" id="tr-done">完了した！</button><button class="btn ghost" id="tr-again">別のメニュー</button></div>`;
      $('#tr-again').onclick = show;
      $('#tr-done').onclick = async () => {
        const d = await getDay(); d.training.push({ at: nowHM(), ...o, plan }); await saveDay(d);
        App.settings.lastTrain = { place:o.place, min:o.min, goal:o.goal }; await DB.set('settings', App.settings);
        await award('training', 'トレーニング完了', { big:true, title:'TRAINING CLEAR', sub:`${o.min}分やり切った！` }); go('#home');
      };
      $('#tr-out').scrollIntoView({ behavior:'smooth' });
    };
    $('#tr-go').onclick = show;
    if (App.tmp.trainAuto) { App.tmp.trainAuto = false; show(); }
  }

  /* ================= 体重・歩数 ================= */
  async function renderBody(){
    const day = await getDay(); const ws = await DB.get('weights', []);
    const ma = E.movingAvg(ws).slice(-60);
    const last = ma[ma.length - 1]; const wk = ma.find(x => x.date >= E.addDays(E.today(), -7));
    const t = targets(day);
    const bp = await DB.get('bodyPhotos', []);
    view(`${back()}<h1>⚖️ 体重・歩数</h1>
      <div class="card gold"><div class="small">7日平均（毎日の上下より、こちらを見る）</div><div style="font-size:28px;font-weight:800">${last ? last.avg + ' kg' : '—'}</div>
        <div class="small">${last && wk ? `1週間前の平均比 ${(last.avg - wk.avg >= 0 ? '+' : '')}${(last.avg - wk.avg).toFixed(1)}kg` : ''}　目標 ${App.prof.goalKg}kg</div></div>
      <canvas class="chart" id="wchart"></canvas>
      <div class="card"><b>今朝の体重</b>
        <div class="row"><input id="w-in" type="number" step="0.1" inputmode="decimal" placeholder="例 72.4" value="${esc(ws.find(w => w.date === day.date)?.kg || '')}"><button class="btn sm" id="w-save" style="flex:none">保存</button></div>
        <button class="btn" id="w-photo">📷 体重計を撮って読み取る</button></div>
      <div class="card"><b>今日の歩数</b>${t.steps ? '' : `<div class="small">今日は運動日なので歩数ミッションはありません（記録は任意）</div>`}
        <div class="row"><input id="st-in" type="number" inputmode="numeric" placeholder="例 8000" value="${esc(day.steps ?? '')}"><button class="btn sm" id="st-save" style="flex:none">保存</button></div>
        <p class="tiny">iPhoneの「ショートカット」で自動入力できます（設定 → ヘルスケア連携）。</p></div>
      <div class="card"><b>週1回の全身写真（任意・本人のみ閲覧）</b><div class="small">${bp.length}枚保存。共有はされません。</div>
        <button class="btn" id="bp-add">📷 撮影する</button>${bp.length ? `<button class="btn ghost" id="bp-view">写真を見る</button>` : ''}</div>`);
    drawChart($('#wchart'), ma, +App.prof.goalKg);
    const saveW = async (kg, photoId) => { await saveWeight(kg, photoId); renderBody(); };
    $('#w-save').onclick = () => { const v = +$('#w-in').value; if (!(v > 20 && v < 300)) return toast('体重を確認してください'); saveW(v); };
    $('#w-photo').onclick = async () => {
      const blob = await pickPhoto(); if (!blob) return; const pid = await DB.putPhoto(blob, 'scale');
      let kg = null;
      if (await S.aiReady()) { toast('AIが数字を読んでいます…'); try { kg = (await S.readScale(blob)).kg; } catch (e) { toast(e.message); } }
      sheet(`<h2>読み取り結果を確認</h2><img class="photo" src="${URL.createObjectURL(blob)}"><label>体重(kg)${kg == null ? '　※読み取れなかったので入力してください' : ''}</label><input id="w-ok" type="number" step="0.1" inputmode="decimal" value="${kg ?? ''}"><button class="btn primary" id="w-okb">この数字で保存</button>`,
        bg => bg.querySelector('#w-okb').onclick = () => { const v = +bg.querySelector('#w-ok').value; if (!(v > 20 && v < 300)) return toast('体重を確認してください'); bg.remove(); saveW(v, pid); });
    };
    $('#st-save').onclick = async () => { await saveSteps(Math.round(+$('#st-in').value || 0)); renderBody(); };
    if (App.tmp.bodyPhoto) { App.tmp.bodyPhoto = false; setTimeout(() => $('#w-photo').click(), 50); }
    $('#bp-add').onclick = async () => { const blob = await pickPhoto(); if (!blob) return; const list = await DB.get('bodyPhotos', []); list.push({ date:E.today(), photoId: await DB.putPhoto(blob, 'body') }); await DB.set('bodyPhotos', list); await gain('bodyPhoto', '全身写真'); renderBody(); };
    const bv = $('#bp-view'); if (bv) bv.onclick = async () => { const urls = await Promise.all(bp.slice(-8).reverse().map(async b => `<div class="small">${b.date}</div><img class="photo" src="${await photoURL(b.photoId)}">`)); sheet(`<h2>全身写真（あなただけ）</h2>${urls.join('')}`); };
  }
  function drawChart(cv, data, goal){
    const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth, H = cv.clientHeight; cv.width = W*dpr; cv.height = H*dpr;
    const c = cv.getContext('2d'); c.scale(dpr, dpr);
    if (data.length < 2) { c.fillStyle = '#9aa3b5'; c.font = '13px sans-serif'; c.fillText('記録が2日分以上たまるとグラフが出ます', 14, H/2); return; }
    const vals = data.flatMap(d => [d.kg, d.avg]).concat(goal ? [goal] : []);
    const mn = Math.min(...vals) - 0.5, mx = Math.max(...vals) + 0.5;
    const x = i => 30 + i * (W - 44) / (data.length - 1), y = v => 12 + (mx - v) / (mx - mn) * (H - 32);
    c.strokeStyle = '#2a3042'; c.fillStyle = '#9aa3b5'; c.font = '11px sans-serif';
    for (let k = 0; k <= 3; k++) { const v = mn + (mx - mn) * k / 3; c.beginPath(); c.moveTo(30, y(v)); c.lineTo(W - 10, y(v)); c.stroke(); c.fillText(v.toFixed(1), 0, y(v) + 4); }
    if (goal && goal > mn && goal < mx) { c.setLineDash([4, 4]); c.strokeStyle = '#5fd3a0'; c.beginPath(); c.moveTo(30, y(goal)); c.lineTo(W - 10, y(goal)); c.stroke(); c.setLineDash([]); }
    c.fillStyle = 'rgba(154,163,181,.6)'; data.forEach((d, i) => { c.beginPath(); c.arc(x(i), y(d.kg), 2.5, 0, 7); c.fill(); });
    c.strokeStyle = '#f1d9a2'; c.lineWidth = 2.5; c.beginPath(); data.forEach((d, i) => i ? c.lineTo(x(i), y(d.avg)) : c.moveTo(x(i), y(d.avg))); c.stroke();
    c.fillStyle = '#9aa3b5'; c.fillText(data[0].date.slice(5), 30, H - 4); c.fillText(data[data.length-1].date.slice(5), W - 44, H - 4);
  }

  /* ================= 近くのお店 ================= */
  async function renderNearby(){
    const min = App.tmp.walk || 10;
    view(`${back()}<h1>📍 現在地からお店を探す</h1>
      <div class="card"><div class="loc"><div style="flex:1"><b>位置情報</b><div class="tiny">${App.settings.locationOn ? 'ON：検索ボタンを押した時だけ、確認なしで1回取得' : 'OFF（通常）：検索ボタンを押した時に、毎回確認してから1回だけ取得'}</div></div><button class="toggle ${App.settings.locationOn ? 'on' : ''}" id="loc-t"></button></div>
      <div class="tiny" style="margin-top:6px">どちらの場合も、位置の追跡・保存はしません。</div></div>
      <label>徒歩の目安</label><div class="chips" id="nb-m">${[5,10,15,20].map(m => `<span class="chip ${m===min?'on':''}" data-m="${m}">${m}分</span>`).join('')}</div>
      <p class="tiny">店舗情報は OpenStreetMap の登録データ。距離は<b>直線距離</b>から計算した目安で、道路に沿った実際の徒歩時間ではありません。営業状況・最新メニューは未確認です。</p>
      <div id="nb-out"></div>
      <h2>店名を入力してミッション</h2>
      <div class="card"><p class="small">検索がうまくいかない時は、店名を入れてください。</p><div class="row"><input id="nb-name" placeholder="例：松屋、駅前食堂"><button class="btn sm" id="nb-name-go" style="flex:none">決定</button></div></div>`,
      `<button class="btn primary" id="nb-go">この範囲で探す</button>`);
    $('#loc-t').onclick = async () => { App.settings.locationOn = !App.settings.locationOn; await DB.set('settings', App.settings); renderNearby(); };
    $('#nb-m').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; App.tmp.walk = +c.dataset.m; renderNearby(); };
    $('#nb-name-go').onclick = () => manualStore($('#nb-name').value.trim());
    $('#nb-go').onclick = async () => {
      if (!App.settings.locationOn && !confirm('今回だけ現在地を使って検索します。よろしいですか？')) return;
      const out = $('#nb-out'); out.innerHTML = `<div class="card small">現在地を取得中…</div>`;
      let pos;
      try { pos = await S.locateOnce(); } catch (e) { out.innerHTML = `<div class="warnbox">${esc(e.message)}。下の「店名を入力」から続けられます。</div>`; return; }
      const radius = min * 80;
      // ① 位置を登録してある行きつけ・取り込み店（最優先）
      const regNear = App.data.chains.filter(c => c.lat != null && c.lon != null).map(c => ({ c, m: Math.round(S.dist(pos.lat, pos.lon, c.lat, c.lon)) })).filter(x => x.m <= radius).sort((a, b) => a.m - b.m);
      let places = [], err = null;
      out.innerHTML = `<div class="card small">お店を検索中…</div>`;
      try { places = (await S.nearby(pos.lat, pos.lon, min)).filter(p => p.walkMin <= min); } catch (e) { err = e.message; }
      App.tmp.places = places.map(p => ({ ...p, match: S.matchChain(p, App.data) }));
      const reg = App.tmp.places.filter(p => p.match), other = App.tmp.places.filter(p => !p.match);
      const li = (p, i) => `<div class="li" data-pl="${i}"><span class="t"><b>${esc(p.name)}</b><div class="tiny">直線距離 ${p.meters}m（直線で徒歩約${p.walkMin}分）${p.match ? '・<span style="color:var(--gold2)">登録あり</span>' : ''}${p.hours ? '・営業時間（登録情報）' + esc(p.hours.slice(0, 30)) : ''}</div></span><span>›</span></div>`;
      out.innerHTML = `<div class="warnbox" style="margin-top:6px">直線距離による候補です。実際の徒歩時間は道路や信号で長くなります。</div>` +
        (regNear.length ? `<h2>⭐ 登録済みのお店（近い順）</h2><div class="list card">${regNear.map(x => `<div class="li" data-reg="${esc(x.c.id)}"><span class="t"><b>${esc(x.c.name)}</b><div class="tiny">直線距離 ${x.m}m・${x.c.items.length}品登録</div></span><span>›</span></div>`).join('')}</div>` : '') +
        (reg.length ? `<h2>すぐミッションを出せる店</h2><div class="list card">${reg.map(p => li(p, App.tmp.places.indexOf(p))).join('')}</div>` : '') +
        (other.length ? `<h2>その他のお店（メニュー写真で対応）</h2><div class="list card">${other.slice(0, 30).map(p => li(p, App.tmp.places.indexOf(p))).join('')}</div>` : '') +
        (err ? `<div class="warnbox">地図データの検索に失敗しました（${esc(err)}）。下の「店名を入力」から続けられます。</div>` : '') +
        (!places.length && !regNear.length && !err ? `<div class="warnbox">この範囲で見つかりませんでした。範囲を広げるか、店名を入力してください。</div>` : '');
      out.querySelectorAll('[data-pl]').forEach(el => el.onclick = () => placeSheet(App.tmp.places[+el.dataset.pl]));
      out.querySelectorAll('[data-reg]').forEach(el => el.onclick = () => { const c = App.data.chains.find(x => x.id === el.dataset.reg); placeSheet({ name:c.name, lat:c.lat, lon:c.lon, walkMin:null, match:{ type:'chain', id:c.id, name:c.name } }); });
    };
  }
  /* 店名の手入力：登録済みなら登録メニューから、未登録ならメニュー写真モード */
  async function manualStore(name){
    if (!name || name.length < 2) return toast('店名を2文字以上入れてください');
    const n = name.toLowerCase();
    const conv = App.data.convenience.find(c => c.aliases.some(a => n.includes(a.toLowerCase()) || a.toLowerCase().includes(n)));
    const ch = App.data.chains.find(c => (c.aliases || [c.name]).some(a => n.includes(a.toLowerCase()) || a.toLowerCase().includes(n)));
    const day = await getDay();
    const slot = ['breakfast','lunch','dinner'].find(s => day.meals[s]?.status !== 'cleared') || 'dinner';
    if (conv) { await issueConv(day, slot, conv.id, {}); await saveDay(day); return go('#meal/' + slot); }
    if (ch) { await issueChain(day, slot, ch.id, {}); await saveDay(day); return go('#meal/' + slot); }
    const m = day.meals[slot] || (day.meals[slot] = { status:'pending', moodRerolls:0, rerollCount:0, soldout:[] });
    m.source = { type:'manual', name }; resetMeal(m);
    m.mission = { kind:'guide', storeName:name, meal:slot, cmd:`${name}では、メニュー表を撮影してAIに選ばせろ！`, guide:'未登録のお店です。AIが使えない時は：焼く・煮る・蒸す料理の定食を選び、ご飯は少なめ、野菜の小鉢を1つ追加。', needsPhoto:true };
    await saveDay(day); go('#meal/' + slot);
  }
  async function placeSheet(p){
    const L = S.mapLinks(p);
    const day = await getDay();
    const slot = ['breakfast','lunch','dinner'].find(s => day.meals[s]?.status !== 'cleared') || 'dinner';
    sheet(`<h2>${esc(p.name)}</h2><div class="small">${p.walkMin != null ? `直線距離による目安：徒歩約${p.walkMin}分（実際は長くなることがあります）` : ''}</div>
      ${p.match ? `<button class="btn primary" id="pl-m">この店で${E.MEAL_LABEL[slot]}ミッション発行</button>` : `<div class="warnbox">未登録の店です。実在・営業状況はアプリでは確認できません。行く場合はメニューを撮影してAIに選ばせてください。</div><button class="btn primary" id="pl-ai">📷 メニューを撮ってAIに選ばせる</button>`}
      <div class="row"><a class="btn" href="${L.apple}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">Appleマップで道案内</a><a class="btn" href="${L.google}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">Googleマップ</a></div>`, bg => {
      const m = bg.querySelector('#pl-m'); if (m) m.onclick = async () => { bg.remove(); const d = await getDay(); if (p.match.type === 'conv') await issueConv(d, slot, p.match.id, {}); else await issueChain(d, slot, p.match.id, {}); await saveDay(d); go('#meal/' + slot); };
      const a = bg.querySelector('#pl-ai'); if (a) a.onclick = async () => { bg.remove(); manualStore(p.name); };
    });
  }

  /* ================= 設定 ================= */
  async function renderSettings(){
    const st = App.settings;
    const P = st.places || {};
    const nf = st.notify || {};
    const imported = Object.keys(await DB.get('customStores', {})).length;
    const favs = (await favList()).length, vend = (await vendingList()).length;
    const photos = (await DB.photoKeys()).length;
    const row = (href, ic, title, sub) => `<div class="setrow" onclick="App.go('${href}')"><span class="ic">${ic}</span><span class="tx"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</span><span class="chev">›</span></div>`;
    const group = (title, rows) => `<div class="setgroup"><div class="gtitle">${title}</div><div class="setlist">${rows.join('')}</div></div>`;
    view(`${back()}<div class="kicker">SETTINGS</div><h1>設定</h1>
      ${group('お店・メニュー', [
        row('#fav', '⭐', '行きつけ店', favs ? `${favs}店を登録中` : 'お店とメニュー写真を登録'),
        row('#vending', '🥤', '会社の自販機', vend ? `${vend}台を登録中` : '飲み物ミッションで使う商品を登録'),
        row('#import', '📥', 'ChatGPTから店舗を追加（JSON取り込み）', imported ? `取り込み済み ${imported}店` : 'チェーン店・個人店・コンビニ商品を一括追加'),
        row('#products', '📦', '商品情報の追加・更新', `${App.data.products.length}品・販売終了の切り替え`)
      ])}
      ${group('自分のこと', [
        row('#setup', '🍽', '好み・アレルギー・予算', '体の情報・目標・起床/就寝もここ'),
        row('#places', '🏠', '自宅・会社の位置', (P.home || P.office ? '登録済み' : '未登録') + '・位置情報 ' + (st.locationOn ? 'ON' : 'OFF'))
      ])}
      ${group('通知・連携', [
        row('#notify', '🔔', '通知', Object.values(nf).some(v => v === true) ? 'ON の項目あり' : 'すべてOFF'),
        row('#ai', '🔑', 'APIキー（Gemini・AI連携）', st.geminiKey ? '設定済み' : '未設定（なくても使えます）'),
        row('#health', '❤️', 'ヘルスケア連携', 'ショートカットで歩数・体重を取り込み')
      ])}
      ${group('データ', [
        row('#photos', '🖼', '写真の管理', `${photos}枚・不要な写真を削除`),
        row('#backup', '💾', 'バックアップ／復元', st.lastBackup ? `前回 ${st.lastBackup}` : 'まだバックアップしていません')
      ])}
      ${group('その他', [
        row('#badges', '🏅', 'バッジ', `${App.game.badges.length}/${G.BADGES.length} 獲得`),
        row('#social', '🤝', '仲間機能と共有設定', '準備中・共有はすべてOFF')
      ])}
      <p class="tiny">商品データ ${App.data.productsVersion}版（${App.data.products.length}品）／店舗 ${App.data.chains.length}店（メニュー ${App.data.chains.reduce((a, c) => a + c.items.length, 0)}品）<br>設定を開かなくても、毎日のミッションは同梱データで動きます。</p>`);
  }

  async function renderFav(){
    const favs = await favList();
    view(`${back('#settings')}<h1>⭐ 行きつけ店</h1><p class="small">店名とメニュー写真を登録すると、AIが料理を読み取って保存し、次回からその店のミッションを出せます。ゴルフ場はここではなく、ゴルフの日の予定で指定します。</p>
      ${favs.map(f => `<div class="card"><b>${esc(f.name)}</b><div class="small">${(f.items||[]).length}品</div>${(f.items||[]).slice(0, 30).map((x, i) => `<div class="li" style="padding:6px 0"><span class="t">${esc(x.name)}${x.priceYen ? '・' + x.priceYen + '円' : ''}${x.kcal ? '・' + x.kcal + 'kcal（表記）' : ''}</span><button class="btn sm" data-fdel="${f.id}:${i}">削除</button></div>`).join('')}
        <div class="tiny">${f.lat ? `位置登録済み（${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}）` : '位置未登録（登録すると「現在地から探す」で優先表示）'}</div><button class="btn sm" data-floc="${f.id}">📍 今いる場所を店の位置にする</button><button class="btn sm" data-fadd="${f.id}">＋手入力</button><button class="btn sm" data-fphoto="${f.id}">📷 メニュー写真を追加</button><button class="btn sm" data-frm="${f.id}">店を削除</button></div>`).join('')}
      <div class="card"><label>新しい店名</label><input id="f-name" placeholder="例：駅前食堂"><button class="btn primary" id="f-new">登録してメニュー写真を撮る</button></div>`);
    const save = async list => { await DB.set('favorites', list); await loadData(); renderFav(); };
    const addPhoto = async id => {
      const blob = await pickPhoto(); if (!blob) return;
      const list = await favList(); const f = list.find(x => x.id === id); f.menuPhotoIds = [...(f.menuPhotoIds || []), await DB.putPhoto(blob, 'menu')];
      if (await S.aiReady()) { toast('AIがメニューを読み取り中…'); try { const r = await S.readFavMenu(blob); f.items = [...(f.items || []), ...(r.items || []).filter(i => i.name).map(i => ({ name:i.name, priceYen:i.priceYen, kcal:i.kcal, protein:i.protein, salt:i.salt, category:i.category, source:'menu-photo' }))]; toast(`${(r.items||[]).length}品を読み取りました`); } catch (e) { toast(e.message); } }
      else toast('写真を保存しました。AI未設定のため料理名は手入力してください');
      save(list);
    };
    $('#f-new').onclick = async () => { const nm = $('#f-name').value.trim(); if (!nm) return toast('店名を入れてください'); const list = await favList(); const id = Date.now().toString(36); list.push({ id, name:nm, items:[] }); await DB.set('favorites', list); addPhoto(id); };
    document.querySelectorAll('[data-fphoto]').forEach(b => b.onclick = () => addPhoto(b.dataset.fphoto));
    document.querySelectorAll('[data-floc]').forEach(b => b.onclick = async () => { if (!confirm('今回だけ現在地を取得して、この店の位置として保存します。')) return; try { const p = await S.locateOnce(); const list = await favList(); const f = list.find(x => x.id === b.dataset.floc); f.lat = p.lat; f.lon = p.lon; save(list); toast('店の位置を保存しました'); } catch (e) { toast(e.message); } });
    document.querySelectorAll('[data-fadd]').forEach(b => b.onclick = async () => { const nm = prompt('料理名'); if (!nm) return; const pr = prompt('価格（円・任意）'); const list = await favList(); list.find(x => x.id === b.dataset.fadd).items.push({ name:nm, priceYen: pr ? +pr : null, source:'manual' }); save(list); });
    document.querySelectorAll('[data-fdel]').forEach(b => b.onclick = async () => { const [id, i] = b.dataset.fdel.split(':'); const list = await favList(); list.find(x => x.id === id).items.splice(+i, 1); save(list); });
    document.querySelectorAll('[data-frm]').forEach(b => b.onclick = async () => { if (!confirm('この店を削除しますか？')) return; save((await favList()).filter(x => x.id !== b.dataset.frm)); });
  }

  async function renderVending(){
    const vs = await vendingList();
    view(`${back('#settings')}<h1>🥤 会社の自販機</h1><p class="small">自販機の全体写真や商品写真を撮ると、AIが商品名・容量・カフェイン量（表示があれば）を記録します。飲み物ミッションに使われます。</p>
      ${vs.map(v => `<div class="card"><b>${esc(v.name)}</b>${v.items.map((x, i) => `<div class="li" style="padding:6px 0"><span class="t">${esc(x.name)} ${esc(x.size || '')}${x.caffeineMg ? '・カフェイン' + x.caffeineMg + 'mg' : ''}</span><button class="btn sm" data-vedit="${v.id}:${i}">修正</button><button class="btn sm" data-vdel="${v.id}:${i}">削除</button></div>`).join('')}
        <button class="btn sm" data-vphoto="${v.id}">📷 写真で追加</button><button class="btn sm" data-vadd="${v.id}">＋手入力</button><button class="btn sm" data-vrm="${v.id}">削除</button></div>`).join('')}
      <div class="card"><label>自販機の名前</label><input id="v-name" placeholder="例：会社3階の自販機"><button class="btn primary" id="v-new">登録して撮影</button></div>`);
    const save = async list => { await DB.set('vending', list); renderVending(); };
    const addPhoto = async id => {
      const blob = await pickPhoto(); if (!blob) return; const list = await vendingList(); const v = list.find(x => x.id === id);
      v.photoIds = [...(v.photoIds || []), await DB.putPhoto(blob, 'vending')];
      if (await S.aiReady()) { toast('AIが商品を識別中…'); try { const r = await S.readVending(blob); v.items.push(...(r.items || []).filter(i => i.name)); toast(`${(r.items||[]).length}品を読み取りました`); } catch (e) { toast(e.message); } }
      else toast('写真を保存しました。商品は手入力してください');
      save(list);
    };
    const editItem = async (id, i) => {
      const list = await vendingList(); const v = list.find(x => x.id === id); const it = i != null ? v.items[i] : {};
      const nm = prompt('商品名', it.name || ''); if (!nm) return; const sz = prompt('容量（例 500ml）', it.size || ''); const cf = prompt('カフェイン量(mg・表示があれば。不明なら空欄)', it.caffeineMg ?? '');
      const rec = { name:nm, size:sz, caffeineMg: cf === '' ? null : +cf };
      if (i != null) v.items[i] = { ...it, ...rec }; else v.items.push(rec); save(list);
    };
    $('#v-new').onclick = async () => { const nm = $('#v-name').value.trim(); if (!nm) return toast('名前を入れてください'); const list = await vendingList(); const id = Date.now().toString(36); list.push({ id, name:nm, items:[] }); await DB.set('vending', list); addPhoto(id); };
    document.querySelectorAll('[data-vphoto]').forEach(b => b.onclick = () => addPhoto(b.dataset.vphoto));
    document.querySelectorAll('[data-vadd]').forEach(b => b.onclick = () => editItem(b.dataset.vadd, null));
    document.querySelectorAll('[data-vedit]').forEach(b => b.onclick = () => { const [id, i] = b.dataset.vedit.split(':'); editItem(id, +i); });
    document.querySelectorAll('[data-vdel]').forEach(b => b.onclick = async () => { const [id, i] = b.dataset.vdel.split(':'); const list = await vendingList(); list.find(x => x.id === id).items.splice(+i, 1); save(list); });
    document.querySelectorAll('[data-vrm]').forEach(b => b.onclick = async () => { if (!confirm('削除しますか？')) return; save((await vendingList()).filter(x => x.id !== b.dataset.vrm)); });
  }

  async function renderNotify(){
    const nf = App.settings.notify || {};
    const tg = (k, l) => `<div class="li"><span class="t">${l}</span><button class="toggle ${nf[k] ? 'on' : ''}" data-nf="${k}"></button></div>`;
    view(`${back('#settings')}<h1>🔔 通知設定</h1>
      <div class="warnbox">iPhoneのホーム画面アプリ（PWA）は、無料のままではアプリを閉じている時の予約通知ができません。①アプリを開いている間の通知 と ②iPhoneのカレンダーに毎日の通知を登録する方法 を用意しました。</div>
      <div class="list card">${tg('weight','朝の体重測定')}${tg('lunch','昼食')}${tg('dinner','夕食')}${tg('drink','水分補給')}</div>
      <div class="row"><div><label>昼食の時刻</label><input id="nf-l" type="time" value="${esc(nf.lunchTime || '12:00')}"></div><div><label>夕食の時刻</label><input id="nf-d" type="time" value="${esc(nf.dinnerTime || '19:00')}"></div></div>
      <button class="btn" id="nf-perm">① アプリ内の通知を許可する</button>
      <button class="btn primary" id="nf-ics">② カレンダー用ファイル（.ics）を作る</button>
      <p class="tiny">②はファイルを開いて「すべて追加」すると、毎日その時刻にiPhoneが通知します。完了済みかどうかは判定できないので、通知が来たらアプリを開いて確認してください。完了済みの通知はアプリ内では出しません。</p>`);
    document.querySelectorAll('[data-nf]').forEach(b => b.onclick = async () => { nf[b.dataset.nf] = !nf[b.dataset.nf]; App.settings.notify = nf; await DB.set('settings', App.settings); renderNotify(); });
    const saveTimes = async () => { nf.lunchTime = $('#nf-l').value; nf.dinnerTime = $('#nf-d').value; App.settings.notify = nf; await DB.set('settings', App.settings); };
    $('#nf-l').onchange = saveTimes; $('#nf-d').onchange = saveTimes;
    $('#nf-perm').onclick = async () => { const r = await S.requestNotify(); toast(r === 'granted' ? '許可されました' : r === 'unsupported' ? 'ホーム画面に追加したアプリから許可してください' : '許可されませんでした'); };
    $('#nf-ics').onclick = async () => {
      await saveTimes(); const L = [];
      if (nf.weight) L.push({ time: App.prof.wake || '07:00', title:'からだミッション：体重を測れ！' });
      if (nf.lunch) L.push({ time: nf.lunchTime || '12:00', title:'からだミッション：昼食ミッション' });
      if (nf.dinner) L.push({ time: nf.dinnerTime || '19:00', title:'からだミッション：夕食を記録' });
      if (nf.drink) ['10:00','15:00','17:30'].forEach(t => L.push({ time:t, title:'からだミッション：水を1杯飲め！' }));
      if (!L.length) return toast('通知する項目をONにしてください');
      S.share(S.buildICS(L), 'karada-mission-reminders.ics');
    };
  }

  async function renderAI(){
    const st = await DB.get('settings', {});
    view(`${back('#settings')}<h1>🔑 APIキー（AI連携・任意）</h1>
      <p class="small">GoogleのGemini API（無料枠）を使います。キーはこのiPhoneの中だけに保存され、アプリのコードやサーバーには含まれません。未設定でも、登録済みデータで通常のミッションは使えます。</p>
      <div class="card"><label>Gemini APIキー</label><input id="ai-k" type="password" value="${esc(st.geminiKey || '')}" placeholder="AIza…">
      <label>モデル名</label><input id="ai-m" value="${esc(st.geminiModel || 'gemini-2.5-flash')}">
      <p class="tiny">モデル名は Google AI Studio で使える無料枠対象のものに変更できます。</p>
      <button class="btn primary" id="ai-save">保存</button><button class="btn" id="ai-test">接続テスト</button><button class="btn ghost" id="ai-del">キーを削除</button></div>
      <div class="warnbox"><b>APIキーの取り扱い</b><br>・キーはこのiPhoneのアプリ内保存領域に保存され、GitHub（公開ファイル）やバックアップには含まれません。<br>・ただし端末内保存も完全に安全ではありません。iPhoneのロック解除ができる人や、端末を調べられる人には読まれる可能性があります。<br>・Google AI Studioで<b>このアプリ専用のキー</b>を作り、他のサービスと使い回さないでください。<br>・Google Cloud側で支払い（課金）を有効にしないでください。無料枠のままなら、上限に達しても請求は発生せずAIが止まるだけです。<br>・漏れた疑いがあれば、AI Studioでキーを削除して作り直してください。</div>
      <div class="warnbox">無料枠では送った内容がGoogleのサービス改善に使われる場合があります。体重計・食事・メニューの写真だけを送り、顔や個人情報が写らないようにしてください。</div>`);
    $('#ai-save').onclick = async () => { App.settings.geminiKey = $('#ai-k').value.trim(); App.settings.geminiModel = $('#ai-m').value.trim() || 'gemini-2.5-flash'; await DB.set('settings', App.settings); toast('保存しました'); };
    $('#ai-test').onclick = async () => { try { const t = await S.gemini('「接続OK」とだけ返答してください', null, false); toast('AI：' + t.trim().slice(0, 20)); } catch (e) { toast(e.message); } };
    $('#ai-del').onclick = async () => { App.settings.geminiKey = ''; await DB.set('settings', App.settings); renderAI(); };
  }

  async function renderHealth(){
    const base = location.href.split('#')[0];
    view(`${back('#settings')}<h1>❤️ ヘルスケア連携</h1>
      <p class="small">ホーム画面アプリ（PWA）はApple「ヘルスケア」を直接読めません。代わりにiPhone標準の「ショートカット」アプリで、歩数と体重をこのアプリに渡せます（無料・Mac不要）。</p>
      <div class="card"><b>ショートカットの作り方</b><ol class="small">
        <li>ショートカット → ＋ →「ヘルスケアサンプルを検索」：種類＝歩数、開始日＝今日、グループ＝日、合計</li>
        <li>「ヘルスケアサンプルを検索」をもう1つ：種類＝体重、並び＝最新、1件</li>
        <li>「URL」アクションに次を入力し、各値を変数で差し込む</li>
        <li>「URLを開く」を追加。オートメーションで毎晩21時などに実行</li></ol>
        <input readonly value="${esc(base)}#hk?steps=【歩数】&weight=【体重】" onclick="this.select()"></div>
      <p class="tiny">将来iPhoneアプリ化（HealthKit）する場合も、同じ取り込み口（#hk）を使う設計です。</p>`);
  }
  async function handleImport(q){
    const p = new URLSearchParams(q); const d = await getDay(); let msg = [];
    if (p.get('steps')) { const v = Math.round(parseFloat(p.get('steps'))); if (v >= 0) { const first = d.steps == null; d.steps = v; await saveDay(d); if (first) await gain('steps'); msg.push(`歩数 ${v.toLocaleString()}`); } }
    if (p.get('weight')) { const v = parseFloat(p.get('weight')); if (v > 20 && v < 300) { const list = await DB.get('weights', []); const i = list.findIndex(w => w.date === d.date); if (i >= 0) list[i].kg = v; else list.push({ date:d.date, kg:v }); await DB.set('weights', list); const dd = await getDay(); if (!dd.weightLogged) { dd.weightLogged = true; await saveDay(dd); await gain('weight'); } msg.push(`体重 ${v}kg`); } }
    toast(msg.length ? '取り込みました：' + msg.join('・') : '取り込める値がありませんでした');
    go('#home');
  }

  async function renderProducts(){
    const counts = {}; App.data.products.forEach(p => { counts[p.storeName] = counts[p.storeName] || { all:0, nut:0 }; counts[p.storeName].all++; if (p.nutrition?.kcal != null) counts[p.storeName].nut++; });
    view(`${back('#settings')}<h1>📦 商品情報</h1>
      <div class="card"><b>登録状況</b>${Object.entries(counts).map(([k, v]) => `<div class="small">${k}：${v.all}品（栄養成分あり ${v.nut}品）</div>`).join('')}
        <div class="small">チェーン店：${App.data.chains.filter(c => c.items.length).length}/${App.data.chains.length}社でメニュー登録あり</div></div>
      <div class="card"><b>一括更新（JSON）</b><p class="small">ChatGPTが作ったJSON（karada-data形式）や products.json を読み込めます。取り込み前に登録・更新・重複・エラーの件数を確認できます。</p><button class="btn" id="pr-imp">JSONファイルを読み込む</button></div>
      <div class="card"><b>1品だけ追加・修正</b>
        <label>店</label><select id="pr-st">${App.data.convenience.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
        <label>正式名称</label><input id="pr-n"><div class="row"><div><label>カテゴリー</label><select id="pr-c">${['おにぎり','弁当','パン','サンドイッチ','サラダ','肉料理','魚料理','惣菜','麺類','スープ','ヨーグルト','間食','飲料'].map(c => `<option>${c}</option>`).join('')}</select></div><div><label>税込価格</label><input id="pr-p" type="number" inputmode="decimal"></div></div>
        <div class="row"><div><label>kcal</label><input id="pr-k" type="number" inputmode="decimal"></div><div><label>たんぱく質</label><input id="pr-pr" type="number" inputmode="decimal"></div><div><label>脂質</label><input id="pr-f" type="number" inputmode="decimal"></div></div>
        <div class="row"><div><label>炭水化物</label><input id="pr-cb" type="number" inputmode="decimal"></div><div><label>食塩相当量</label><input id="pr-s" type="number" inputmode="decimal"></div></div>
        <label>公式ページURL</label><input id="pr-u"><p class="tiny">分からない項目は空欄のまま（不明として保存）。</p><button class="btn primary" id="pr-add">保存</button></div>
      <div class="card"><b>販売終了にする</b><input id="pr-q" placeholder="商品名で検索"><div id="pr-res"></div></div>`);
    const nv = id => { const v = $(id).value; return v === '' ? null : +v; };
    $('#pr-add').onclick = async () => {
      const st = $('#pr-st').value; const nm = $('#pr-n').value.trim(); if (!nm) return toast('商品名を入れてください');
      const c = await DB.get('customProducts', []);
      c.push({ id: st + '-u' + Date.now().toString(36), store: st, storeName: App.data.convenience.find(x => x.id === st).name, name:nm, category:$('#pr-c').value, priceYen: nv('#pr-p'),
        nutrition:{ kcal:nv('#pr-k'), protein:nv('#pr-pr'), fat:nv('#pr-f'), carbs:nv('#pr-cb'), salt:nv('#pr-s') }, region:null, status:'active', verifiedAt:E.today(), officialUrl: $('#pr-u').value || null, source:'user' });
      await DB.set('customProducts', c); await loadData(); toast('追加しました'); renderProducts();
    };
    $('#pr-imp').onclick = async () => { const f = await pickFile('application/json,.json,text/plain'); if (f) runImport(f); };
    $('#pr-q').oninput = () => {
      const q = $('#pr-q').value.trim(); if (q.length < 2) return $('#pr-res').innerHTML = '';
      $('#pr-res').innerHTML = App.data.products.filter(p => p.name.includes(q)).slice(0, 10).map(p => `<div class="li"><span class="t small">${esc(p.storeName)}：${esc(p.name)}${p.status === 'discontinued' ? '（終了）' : ''}</span><button class="btn sm" data-disc="${esc(p.id)}">${p.status === 'discontinued' ? '戻す' : '終了'}</button></div>`).join('');
      document.querySelectorAll('[data-disc]').forEach(b => b.onclick = async () => { const p = App.data.products.find(x => x.id === b.dataset.disc); const c = await DB.get('customProducts', []); const ex = c.find(x => x.id === p.id); const st = p.status === 'discontinued' ? 'active' : 'discontinued'; if (ex) ex.status = st; else c.push({ id:p.id, status:st }); await DB.set('customProducts', c); await loadData(); $('#pr-q').oninput(); });
    };
  }

  async function renderBackup(){
    const st = await DB.get('settings', {});
    view(`${back(App.prof ? '#settings' : '#setup')}<h1>💾 バックアップと復元</h1>
      <p class="small">データはこのiPhoneの中だけにあります。機種変更やSafariのデータ削除に備えて、定期的にバックアップしてください（「ファイル」アプリやiCloud Driveに保存できます）。${st.lastBackup ? `<br>前回のバックアップ：${st.lastBackup}` : ''}</p>
      <div class="card"><b>含まれるもの</b><div class="small">プロフィール・設定・毎日の記録（食事・飲み物・トレーニング）・体重・取り込んだ店舗・追加商品・行きつけ店・自販機・ゲームの進み具合・（選んだ場合）写真</div>
      <div class="small" style="margin-top:4px"><b>含まれないもの</b>：GeminiのAPIキー（秘密情報のため。復元後に再入力が必要な場合があります）</div></div>
      <button class="btn primary" id="bk-a">写真も含めてバックアップ</button><button class="btn" id="bk-b">記録だけバックアップ（軽量）</button>
      <h2>復元</h2>
      <div class="warnbox">復元すると、バックアップに入っている同じ日付・同じ項目は上書きされます。復元前に今のデータのバックアップを取ってください。</div>
      <button class="btn" id="bk-r">バックアップファイルを選ぶ</button>`);
    const ex = async (ph, name) => { toast('作成中…'); const b = await DB.exportAll(ph); await S.share(b, name || `karada-backup-${E.today()}.json`); const s2 = await DB.get('settings', {}); s2.lastBackup = E.today(); await DB.set('settings', s2); App.settings.lastBackup = s2.lastBackup; };
    $('#bk-a').onclick = () => ex(true); $('#bk-b').onclick = () => ex(false);
    $('#bk-r').onclick = async () => {
      const f = await pickFile('application/json,.json'); if (!f) return;
      let info; try { info = await DB.inspectBackup(f); } catch (e) { return sheet(`<h2>このファイルは使えません</h2><div class="warnbox">${esc(e.message)}<br>データは変更していません。</div>`); }
      sheet(`<h2>復元の確認</h2><div class="list card">
          <div class="li"><span class="t">作成日時</span><span class="small">${esc(info.exportedAt ? E.ymd(new Date(info.exportedAt)) + ' ' + E.fmtLocal(info.exportedAt) : '不明')}</span></div>
          <div class="li"><span class="t">項目数</span><b>${info.keys}</b></div><div class="li"><span class="t">記録した日数</span><b>${info.days}</b></div><div class="li"><span class="t">写真</span><b>${info.photos}枚</b></div>
          <div class="li"><span class="t">プロフィール</span><b>${info.hasProfile ? 'あり' : 'なし'}</b></div></div>
        <button class="btn" id="rs-pre">① 今のデータを先にバックアップ（おすすめ）</button>
        <button class="btn primary" id="rs-go">② 復元する</button><button class="btn ghost" id="rs-no">やめる</button>`, bg => {
        bg.querySelector('#rs-no').onclick = () => bg.remove();
        bg.querySelector('#rs-pre').onclick = () => ex(true, `karada-before-restore-${E.today()}.json`);
        bg.querySelector('#rs-go').onclick = async () => {
          try {
            const r = await DB.restore(info.data);
            await loadState(); await loadData();
            bg.remove();
            sheet(`<h2>${r.bad.length ? '一部を確認できませんでした' : '復元しました'}</h2><div class="${r.bad.length ? 'warnbox' : 'okbox'}">項目 ${r.written}件・写真 ${r.photos}枚を書き込み、読み戻して確認しました。${r.bad.length ? `<br>確認できなかった項目：${esc(r.bad.slice(0, 10).join('、'))}` : ''}${App.prof ? '' : '<br>プロフィールが無いため、初期設定から始まります。'}</div><button class="btn primary" onclick="this.closest('.sheet-bg').remove();App.go('#home')">ホームへ</button>`);
          } catch (e) { bg.remove(); sheet(`<h2>復元できませんでした</h2><div class="warnbox">${esc(e.message || e)}<br>途中で失敗した場合、データは変更されていません。</div>`); }
        };
      });
    };
  }

  async function renderSocial(){
    const sh = App.settings.share || {};
    const tg = (k, l) => `<div class="li"><span class="t">${l}</span><button class="toggle ${sh[k] ? 'on' : ''}" data-sh="${k}"></button></div>`;
    view(`${back('#settings')}<h1>🤝 仲間機能（準備中）</h1>
      <p class="small">将来、友達申請・ミッション進捗の共有・応援・共同ミッションを追加できるように設計しています。現在はどこにも送信されません。</p>
      <h2>共有設定（初期値はすべてOFF）</h2><div class="list card">${tg('progress','ミッション進捗')}${tg('meals','食事の写真')}${tg('weight','体重')}${tg('photos','全身写真')}</div>`);
    document.querySelectorAll('[data-sh]').forEach(b => b.onclick = async () => { sh[b.dataset.sh] = !sh[b.dataset.sh]; App.settings.share = sh; await DB.set('settings', App.settings); renderSocial(); });
  }

  async function renderBadges(){
    const g = App.game;
    view(`${back('#settings')}<h1>🏅 バッジ</h1><p class="small">体重の増減ではなく、続けた健康行動を評価します。獲得 ${g.badges.length}/${G.BADGES.length}</p>
      <div class="grid2">${G.BADGES.map(b => `<div class="tile" style="${g.badges.includes(b.id) ? '' : 'opacity:.35'}"><span class="em">${b.em}</span><b>${b.name}</b></div>`).join('')}</div>
      <div class="card" style="margin-top:12px"><div class="small">食事ミッション ${g.counts.meal || 0}回・家の食事記録 ${g.counts.homeMeal || 0}回・水分 ${g.counts.drink || 0}回・体重 ${g.counts.weight || 0}回・トレーニング ${g.counts.training || 0}回</div></div>`);
  }

  /* ================= ChatGPTから店舗を追加（JSON取り込み） ================= */
  async function importCurrent(){
    return { customStores: await DB.get('customStores', {}), customProducts: await DB.get('customProducts', []), builtInStores: App.data.builtInStores, builtInProducts: App.data.builtInProducts };
  }
  async function runImport(file){
    let json;
    try { json = JSON.parse((await file.text()).replace(/^﻿/, '')); } catch { return sheet(`<h2>読み込めませんでした</h2><div class="warnbox">JSONの形式が正しくありません。ChatGPTに「JSONだけを出力して」と頼み直してください。データは変更していません。</div><button class="btn" onclick="this.closest('.sheet-bg').remove()">閉じる</button>`); }
    const cur = await importCurrent();
    const plan = I.analyze(json, cur);
    const row = (l, o) => `<div class="li"><span class="t">${l}</span><span class="small">登録 <b>${o.add}</b>・更新 <b>${o.update}</b>・重複 <b>${o.dup}</b></span></div>`;
    const ok = plan.validCount > 0;
    sheet(`<h2>取り込み前の確認</h2>
      <div class="list card">${row('店舗', plan.stores)}${row('料理', plan.items)}${row('コンビニ商品', plan.products)}<div class="li"><span class="t">エラー</span><b style="color:${plan.errors.length ? 'var(--ng)' : 'var(--ok)'}">${plan.errors.length}件</b></div></div>
      <p class="tiny">「重複」は同じidで内容も同じもの（変更なし）。「更新」は同じidで内容が変わったもの。</p>
      ${plan.errors.length ? `<div class="warnbox"><b>エラーの項目は取り込みません</b><br>${plan.errors.slice(0, 15).map(esc).join('<br>')}${plan.errors.length > 15 ? `<br>…ほか${plan.errors.length - 15}件` : ''}</div>` : ''}
      ${plan.warnings.length ? `<div class="okbox">${plan.warnings.slice(0, 8).map(esc).join('<br>')}</div>` : ''}
      ${ok ? `<button class="btn primary" id="imp-go">${plan.errors.length ? 'エラー以外を取り込む' : '取り込む'}</button>` : `<div class="warnbox">取り込めるデータがありません。データは変更していません。</div>`}
      <button class="btn" id="imp-cancel">やめる</button>`, bg => {
      bg.querySelector('#imp-cancel').onclick = () => bg.remove();
      const g = bg.querySelector('#imp-go'); if (g) g.onclick = async () => {
        g.disabled = true;
        try { await I.commit(plan, cur); await loadData(); bg.remove(); toast(`取り込み完了：店舗${plan.stores.add + plan.stores.update}・料理${plan.items.add + plan.items.update}・商品${plan.products.add + plan.products.update}`); route(); }
        catch (e) { bg.remove(); sheet(`<h2>取り込みに失敗しました</h2><div class="warnbox">${esc(e.message || e)}<br>既存のデータは変更されていません。</div><button class="btn" onclick="this.closest('.sheet-bg').remove()">閉じる</button>`); }
      };
    });
  }
  App.runImport = runImport;
  async function renderImport(){
    const stores = await DB.get('customStores', {});
    const list = Object.values(stores);
    view(`${back('#settings')}<h1>📥 ChatGPTから店舗を追加</h1>
      <div class="card"><b>使い方</b><ol class="small">
        <li>下の「指示文をコピー」→ ChatGPTに貼り付け、最後に店名を書いて送る</li>
        <li>ChatGPTが作ったJSONファイルを、iPhoneの「ファイル」アプリに保存</li>
        <li>「JSONファイルを読み込む」→ 件数を確認して取り込む</li></ol>
        <p class="tiny">チェーン店・個人店・コンビニ商品のどれでも同じ方法で追加できます。同じidは重複せず更新されます。取り込んだ店は食事ミッションと「現在地から探す」で使われます。</p></div>
      <button class="btn primary" id="im-file">JSONファイルを読み込む</button>
      <button class="btn" id="im-copy">ChatGPT用の指示文をコピー</button>
      <button class="btn ghost" id="im-sample">サンプルJSONを保存</button>
      <details class="card"><summary><b>指示文を表示</b></summary><pre class="code">${esc(I.PROMPT)}</pre></details>
      <h2>取り込んだ店舗（${list.length}）</h2>
      ${list.length ? `<div class="list card">${list.map(c => `<div class="li"><span class="t"><b>${esc(c.name)}</b><div class="tiny">${esc(c.genre || '')}・${Object.keys(c.items || {}).length}品・確認日 ${esc(c.verifiedAt || '不明')}${c.address ? '・' + esc(c.address) : ''}</div></span><button class="btn sm" data-srm="${esc(c.id)}">削除</button></div>`).join('')}</div>` : `<p class="small">まだありません。</p>`}`);
    $('#im-file').onclick = async () => { const f = await pickFile('application/json,.json,text/plain'); if (f) runImport(f); };
    $('#im-copy').onclick = async () => { try { await navigator.clipboard.writeText(I.PROMPT); toast('コピーしました。ChatGPTに貼って、最後に店名を書いてください'); } catch { sheet(`<h2>指示文</h2><p class="small">長押しで全選択してコピーしてください。</p><textarea style="min-height:300px">${esc(I.PROMPT)}</textarea>`); } };
    $('#im-sample').onclick = () => S.share(new Blob([JSON.stringify(I.SAMPLE, null, 2)], { type:'application/json' }), 'karada-stores-sample.json');
    document.querySelectorAll('[data-srm]').forEach(b => b.onclick = async () => {
      if (!confirm('この店舗の取り込みデータを削除しますか？（同梱の店舗は元のデータに戻ります）')) return;
      const st = await DB.get('customStores', {}); delete st[b.dataset.srm]; await DB.set('customStores', st); await loadData(); renderImport();
    });
  }

  /* ================= 写真の整理 ================= */
  const KIND = { meal:'食事', homeMeal:'家の食事', menu:'メニュー', scale:'体重計', body:'全身', vending:'自販機', other:'その他' };
  async function renderPhotos(){
    const keys = await DB.photoKeys();
    const idx = await DB.get('photoIndex', []);
    const meta = new Map(idx.map(x => [x.id, x]));
    const items = keys.map(id => meta.get(id) || { id, kind:'other', at:null }).sort((a, b) => E.tsOf(b.at) - E.tsOf(a.at));
    const sel = App.tmp.photoSel || (App.tmp.photoSel = new Set());
    const shown = items.slice(0, 60);
    const urls = await Promise.all(shown.map(x => photoURL(x.id)));
    view(`${back('#settings')}<h1>🖼 写真の整理</h1>
      <p class="small">写真はこのiPhoneの中だけに保存されています（${items.length}枚）。タップで選んで削除できます。</p>
      <div class="card"><b>まとめて削除</b><div class="chips" style="margin-top:6px">
        <span class="chip" data-old="30:meal,homeMeal,menu,scale,vending,other">30日より前の食事・メニュー・体重計の写真</span>
        <span class="chip" data-old="90:meal,homeMeal,menu,scale,vending,other">90日より前（全身写真以外）</span></div>
        <p class="tiny">全身写真は自動では消しません。体重の記録自体は写真を消しても残ります。</p></div>
      <div class="thumbs">${shown.map((x, i) => `<div class="thumb ${sel.has(x.id) ? 'sel' : ''}" data-ph="${x.id}">${urls[i] ? `<img src="${urls[i]}">` : ''}<div class="cap">${KIND[x.kind] || 'その他'}・${x.at ? E.fmtLocal(x.at, true) : '日付不明'}</div></div>`).join('')}</div>
      ${items.length > 60 ? `<p class="tiny">新しい順に60枚まで表示しています。</p>` : ''}`,
      sel.size ? `<button class="btn" id="ph-clear" style="flex:1">選択解除</button><button class="btn primary" id="ph-del" style="flex:2;background:var(--ng);color:#fff">${sel.size}枚を削除</button>` : '');
    document.querySelectorAll('[data-ph]').forEach(el => el.onclick = () => { const id = el.dataset.ph; sel.has(id) ? sel.delete(id) : sel.add(id); renderPhotos(); });
    const c = $('#ph-clear'); if (c) c.onclick = () => { sel.clear(); renderPhotos(); };
    const d = $('#ph-del'); if (d) d.onclick = async () => { if (!confirm(`${sel.size}枚の写真を削除します。元に戻せません。`)) return; for (const id of sel) await DB.delPhoto(id); toast(`${sel.size}枚削除しました`); sel.clear(); renderPhotos(); };
    document.querySelectorAll('[data-old]').forEach(b => b.onclick = async () => {
      const [days, kinds] = b.dataset.old.split(':'); const ks = kinds.split(',');
      const limit = Date.now() - (+days) * 864e5;
      const targets = items.filter(x => x.at && E.tsOf(x.at) < limit && ks.includes(x.kind));
      if (!targets.length) return toast('対象の写真はありません');
      if (!confirm(`${targets.length}枚を削除します。元に戻せません。先にバックアップを取ることをおすすめします。`)) return;
      for (const x of targets) await DB.delPhoto(x.id); toast(`${targets.length}枚削除しました`); renderPhotos();
    });
  }

  /* ================= 場所の登録（自動判定用・任意） ================= */
  async function renderPlaces(){
    const P = App.settings.places || {};
    view(`${back('#settings')}<h1>🏠 自宅・会社の位置</h1>
      <p class="small">位置情報がOFFでも、ホーム画面の場所ボタンで1タップ切り替えできます。ここで位置を登録し、位置情報をONにすると、アプリを開いた時に1回だけ現在地を見て「自宅／会社／外出先」を自動で切り替えます（追跡・履歴保存はしません）。</p>
      <div class="list card">${['home','office'].map(k => `<div class="li"><span class="t">${E.PLACES[k].em} ${E.PLACES[k].label}<div class="tiny">${P[k] ? '登録済み' : '未登録'}</div></span><button class="btn sm" data-reg="${k}">今いる場所で登録</button>${P[k] ? `<button class="btn sm" data-unreg="${k}">削除</button>` : ''}</div>`).join('')}</div>
      <div class="card"><div class="loc"><div style="flex:1"><b>位置情報で自動判定</b><div class="tiny">${App.settings.locationOn ? 'ON' : 'OFF（通常）'}</div></div><button class="toggle ${App.settings.locationOn ? 'on' : ''}" id="pl-t"></button></div></div>`);
    document.querySelectorAll('[data-reg]').forEach(b => b.onclick = async () => { try { const p = await S.locateOnce(); App.settings.places = { ...(App.settings.places || {}), [b.dataset.reg]: { lat:p.lat, lon:p.lon } }; await DB.set('settings', App.settings); toast('登録しました'); renderPlaces(); } catch (e) { toast(e.message); } });
    document.querySelectorAll('[data-unreg]').forEach(b => b.onclick = async () => { const P2 = { ...(App.settings.places || {}) }; delete P2[b.dataset.unreg]; App.settings.places = P2; await DB.set('settings', App.settings); renderPlaces(); });
    $('#pl-t').onclick = async () => { App.settings.locationOn = !App.settings.locationOn; await DB.set('settings', App.settings); renderPlaces(); };
  }

  /* ================= ルーター ================= */
  async function route(){
    const h = location.hash || '#home';
    if (!App.prof && h !== '#setup' && !h.startsWith('#backup')) return go('#setup');
    const [path, q] = h.split('?');
    const [name, arg] = path.slice(1).split('/');
    const R = { home:renderHome, setup:renderSetup, morning:renderMorning, meal:() => renderMeal(arg), mealchoose:() => { App.tmp.forceChoose = true; renderMeal(arg); }, bulk:renderBulk, snack:renderSnack, drinks:renderDrinks, train:renderTrain, body:renderBody, nearby:renderNearby,
      ura:renderSettings, settings:renderSettings, fav:renderFav, vending:renderVending, notify:renderNotify, ai:renderAI, health:renderHealth, products:renderProducts, backup:renderBackup, social:renderSocial, badges:renderBadges, hk:() => handleImport(q || ''), import: () => q ? handleImport(q) : renderImport(), photos: renderPhotos, log: renderLog, late: () => renderLate(arg), food: () => renderFood(arg), places: renderPlaces };
    try { await (R[name] || renderHome)(); } catch (e) { console.error(e); view(`<div class="warnbox">エラー：${esc(e.message)}</div><button class="btn" onclick="App.go('#home')">ホームへ</button>`); }
  }
  App.route = route;

  /* 画面の内容が今の時刻とずれていたら描き直す（入力中・シート表示中は邪魔しない） */
  async function timeSync(force){
    if (!App.prof) return;
    const today = E.today();
    const h = (location.hash || '#home').split('?')[0];
    const busy = document.querySelector('.sheet-bg, .fx') || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
    if (App.tmp.renderedDate && App.tmp.renderedDate !== today) {   // 0:00を過ぎた・タイムゾーンが変わって日付が変わった
      App.tmp.sent = {};
      if (busy && !force) return;
      document.querySelectorAll('.sheet-bg').forEach(x => x.remove());
      return go('#home');
    }
    if (!['#home', '#drinks'].includes(h) || (busy && !force)) return;
    const day = await getDay();
    const key = JSON.stringify([E.currentDrink(E.reflowDrinks(day.drinks || [], E.hm(), App.prof), E.hm())?.slot?.id, E.currentDrink(E.reflowDrinks(day.drinks || [], E.hm(), App.prof), E.hm())?.state, ['breakfast','lunch','dinner'].map(s2 => mealPhase(day, s2))]);
    if (force || key !== App.tmp.timeKey || E.hm().slice(0, 4) !== (App.tmp.renderedHM || '').slice(0, 4)) {
      App.tmp.timeKey = key; App.tmp.keepScroll = window.scrollY; route();
    }
  }
  App.timeSync = timeSync;

  async function start(){
    try { await loadData(); } catch (e) { $('#app').innerHTML = `<div class="wrap"><div class="warnbox">商品データを読み込めませんでした。インターネットに接続してもう一度開いてください。</div></div>`; return; }
    await loadState();
    window.addEventListener('hashchange', route);
    /* 時刻の追従：アプリに戻った時・PWA再表示・30秒ごとに、端末の現在時刻を取り直す。
       日付が変わっていたら新しい1日として表示し直す（前に開いた時刻は使わない） */
    const back2app = () => { if (document.visibilityState !== 'hidden') timeSync(true); };
    document.addEventListener('visibilitychange', back2app);
    window.addEventListener('pageshow', back2app);
    window.addEventListener('focus', back2app);
    setInterval(() => timeSync(false), 30000);
    // 年に1度ストレージ消去されないよう永続化を要求（Safari）
    if (navigator.storage?.persist) navigator.storage.persist();
    route();
  }
  start();
})();
