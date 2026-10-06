/* からだミッション：外部サービス（すべて無料・任意）
   - Gemini API（無料枠）：APIキーは端末内にだけ保存。コードには含めない
   - OpenStreetMap Overpass API：近くの店舗検索（無料・キー不要）
   - 位置情報：検索した瞬間に1回だけ取得（追跡しない） */
(function(){
  const S = {};

  /* ---------- Gemini ---------- */
  S.aiReady = async () => !!(await DB.get('settings', {})).geminiKey;
  async function gemini(prompt, imageBlob, wantJson = true){
    const st = await DB.get('settings', {});
    if (!st.geminiKey) throw new Error('AIが未設定です（設定 → APIキー）');
    const model = st.geminiModel || 'gemini-2.5-flash';
    const parts = [{ text: prompt }];
    if (imageBlob) {
      const dataUrl = await DB.blobToDataURL(imageBlob);
      parts.push({ inline_data: { mime_type: imageBlob.type || 'image/jpeg', data: dataUrl.split(',')[1] } });
    }
    const body = { contents: [{ parts }], generationConfig: wantJson ? { response_mime_type: 'application/json', temperature: 0.2 } : { temperature: 0.4 } };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': st.geminiKey }, body: JSON.stringify(body)
    });
    if (r.status === 429) throw new Error('AIの無料枠の上限に達しました。手動で続けてください。');
    if (!r.ok) throw new Error('AIエラー（' + r.status + '）');
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!wantJson) return text;
    try { return JSON.parse(text.replace(/^```json|```$/g, '').trim()); } catch { throw new Error('AIの返答を読み取れませんでした'); }
  }
  S.gemini = gemini;
  const RULE = '重要：写真に写っていない商品名・数値を作らないこと。読めない項目は null にすること。';

  S.verifyPurchase = (blob, expected) => gemini(
    `この写真はコンビニや飲食店で購入・注文した食べ物です。次の指定商品が写っているか確認してください。\n指定：${expected.join(' / ')}\n${RULE}\nJSONで返答：{"matched":["写っている指定商品"],"missing":["見当たらない指定商品"],"others":["指定外で写っている物"],"comment":"20字以内"}`, blob);

  S.readScale = blob => gemini(`体重計の表示を読み取ってください。${RULE}\nJSON：{"kg":数値またはnull,"confidence":"high|mid|low"}`, blob);

  S.describeMeal = blob => gemini(`家庭料理の写真です。料理名を列挙してください。カロリーは推定しなくてよい。${RULE}\nJSON：{"dishes":["料理名"]}`, blob);

  S.readMenu = blob => gemini(`飲食店のメニュー表の写真です。読み取れる料理・飲み物をすべて列挙してください。価格やカロリーが印刷されていれば読み取り、印刷されていなければnull。${RULE}\nJSON：{"items":[{"name":"","priceYen":null,"kcal":null,"protein":null,"salt":null,"category":"main|side|drink|alcohol|dessert"}]}`, blob);

  S.chooseFromMenu = (blob, ctx) => gemini(
    `あなたは減量中の人の食事を決める栄養士です。この店のメニュー写真から、今回注文すべき料理を具体的に1〜3品選んでください。
条件：目標 約${ctx.kcal}kcal・たんぱく質${ctx.protein}g以上を目安、予算${ctx.budget}円以内、苦手/アレルギー：${ctx.avoid || 'なし'}、場面：${ctx.scene}。
揚げ物と大盛は避け、主食は少なめ、野菜かたんぱく質を優先。${ctx.scene === '飲み会' ? `お酒は純アルコール20g程度まで（例：ハイボール1〜2杯）で具体的に指定し、無糖のお酒もアルコール量に注意する旨を添える。` : ''}
${RULE}カロリーは印刷値があればそれを、無ければ推定値として estimated:true を付ける。
JSON：{"order":[{"name":"メニュー表の表記どおり","qty":1,"kcal":null,"estimated":true}],"drinks":[{"name":"","qty":1}],"advice":"40字以内"}`, blob);

  /* 食品の推定カロリー（AI）。公式値ではないので必ず推定として扱う */
  S.estimateFood = (blob, info) => gemini(
    `食事の写真と、本人が入力した情報から、この食品1回分（入力した個数・枚数・トッピング込み）のエネルギーを推定してください。
入力情報：${JSON.stringify(info)}
${RULE}推定なので必ず幅を持たせること。写真で量が分からない場合は幅を広くし、noteに理由を書くこと。
JSON：{"kcal_min":数値,"kcal_max":数値,"note":"30字以内（何を根拠にしたか）"}`, blob);

  /* レシートの読み取り（候補を作るだけ。アプリ側で必ず確認画面を出し、自動では確定しない） */
  S.readReceipt = blob => gemini(
    `買い物のレシートの写真です。印字されている内容だけを読み取ってください。
${RULE}
・商品名は印字どおり（略称のままでよい）。数量が印字されていなければ1。価格は税込の金額が分かればそれを使う
・食品・飲み物・お菓子以外（日用品・薬・化粧品・袋代など）は isFood:false にする
・category は 食事=meal / 飲み物=drink / お菓子・間食=snack（食品以外は null）
・where は コンビニ=conv / スーパー=super / ドラッグストア=drug / 飲食店=restaurant / 自販機=vending / パン屋=bakery / 不明=null
JSON：{"store":"店名（支店名も）","where":null,"datetime":"YYYY-MM-DD HH:MM またはnull","items":[{"name":"","qty":1,"unitPrice":null,"total":null,"isFood":true,"category":"meal"}],"total":null}`, blob);

  S.readVending =blob => gemini(`自動販売機または飲料の写真です。読み取れる商品を列挙してください。容量は表示どおり。カフェイン量は表示があれば読み取り、無ければnull。${RULE}\nJSON：{"items":[{"name":"","size":"","priceYen":null,"caffeineMg":null,"sugarFree":null}]}`, blob);

  S.readFavMenu = S.readMenu;

  /* ---------- 位置情報（1回だけ） ---------- */
  S.locateOnce = () => new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('この端末は位置情報に対応していません'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      e => rej(new Error(e.code === 1 ? '位置情報の使用が許可されませんでした' : '位置情報を取得できませんでした')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });

  /* ---------- 近くの店（OpenStreetMap） ---------- */
  S.nearby = async (lat, lon, minutes) => {
    const radius = Math.round(minutes * 80); // 徒歩80m/分
    const q = `[out:json][timeout:25];(nwr(around:${radius},${lat},${lon})[shop=convenience];nwr(around:${radius},${lat},${lon})[amenity~"^(restaurant|fast_food|cafe|food_court|bar|pub)$"];);out center tags 200;`;
    const eps = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
    let j = null, lastErr;
    for (const ep of eps) {
      try { const r = await fetch(ep, { method:'POST', body:'data=' + encodeURIComponent(q), headers:{ 'Content-Type':'application/x-www-form-urlencoded' } }); if (r.ok) { j = await r.json(); break; } lastErr = new Error('検索サービスが混雑しています（' + r.status + '）'); } catch(e) { lastErr = e; }
    }
    if (!j) throw lastErr || new Error('店舗検索に失敗しました');
    return j.elements.map(el => {
      const la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon;
      const t = el.tags || {};
      const d = dist(lat, lon, la, lo);
      return { osmId: el.type + '/' + el.id, name: t['name:ja'] || t.name || t.brand || '(名称不明)', brand: t['brand:ja'] || t.brand || '', kind: t.shop === 'convenience' ? 'conv' : (t.amenity || ''),
        cuisine: t.cuisine || '', lat: la, lon: lo, meters: Math.round(d), walkMin: Math.max(1, Math.round(d / 80)), hours: t.opening_hours || '' };
    }).filter(x => x.lat).sort((a,b) => a.meters - b.meters);
  };
  S.dist = (a, b, c, d) => dist(a, b, c, d);
  function dist(a, b, c, d){ const R = 6371000, t = x => x*Math.PI/180; const dl = t(c-a), dn = t(d-b); const h = Math.sin(dl/2)**2 + Math.cos(t(a))*Math.cos(t(c))*Math.sin(dn/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }

  S.matchChain = (place, data) => {
    const s = (place.name + ' ' + place.brand).toLowerCase();
    for (const c of data.convenience) if (c.aliases.some(a => s.includes(a.toLowerCase()))) return { type:'conv', id:c.id, name:c.name };
    for (const c of data.chains) if ((c.aliases || [c.name]).some(a => s.includes(a.toLowerCase()))) return { type:'chain', id:c.id, name:c.name };
    return null;
  };
  S.mapLinks = p => ({
    apple: `https://maps.apple.com/?daddr=${p.lat},${p.lon}&dirflg=w`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=walking`
  });

  /* ---------- 通知（アプリを開いている間）＋ カレンダー(.ics)書き出し ---------- */
  S.requestNotify = async () => { if (!('Notification' in window)) return 'unsupported'; return Notification.requestPermission(); };
  S.notify = (title, body) => { try { if ('Notification' in window && Notification.permission === 'granted') navigator.serviceWorker?.ready.then(r => r.showNotification(title, { body, icon:'icon-192.png', badge:'icon-192.png' })); } catch {} };

  S.buildICS = (list) => {
    const z = n => String(n).padStart(2, '0');
    const d = new Date(); const day = `${d.getFullYear()}${z(d.getMonth()+1)}${z(d.getDate())}`;
    const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//karada-mission//JP','CALSCALE:GREGORIAN'];
    list.forEach((it, i) => {
      const t = it.time.replace(':', '') + '00';
      lines.push('BEGIN:VEVENT', `UID:km-${i}-${day}@karada-mission`, `DTSTAMP:${day}T000000`, `DTSTART;TZID=Asia/Tokyo:${day}T${t}`, 'DURATION:PT5M', 'RRULE:FREQ=DAILY',
        `SUMMARY:${it.title}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${it.title}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return new Blob([lines.join('\r\n')], { type:'text/calendar' });
  };

  S.download = (blob, name) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  S.share = async (blob, name) => {
    const f = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files:[f] })) { try { await navigator.share({ files:[f], title:name }); return; } catch(e) { if (e.name === 'AbortError') return; } }
    S.download(blob, name);
  };

  window.S = S;
})();
