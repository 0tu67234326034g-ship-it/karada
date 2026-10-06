/* からだミッション：端末内ストレージ（IndexedDB）とバックアップ */
(function(){
  const DB_NAME = 'karada-mission', DB_VER = 1;
  let dbp = null;
  function open(){
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn){
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(v => out = v);
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    });
  }
  function req(r){ return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

  const DB = {
    async get(key, def=null){ const v = await tx('kv','readonly', s => req(s.get(key))); return v === undefined ? def : v; },
    async set(key, val){ return tx('kv','readwrite', s => { s.put(val, key); }); },
    async del(key){ return tx('kv','readwrite', s => { s.delete(key); }); },
    async keys(){ return tx('kv','readonly', s => req(s.getAllKeys())); },
    async putPhoto(blob, kind='other'){
      const id = 'p' + Date.now() + Math.random().toString(36).slice(2,7);
      await tx('photos','readwrite', s => { s.put(blob, id); });
      const idx = await DB.get('photoIndex', []); idx.push({ id, kind, at:E.localISO(), size:blob.size || 0 }); await DB.set('photoIndex', idx);
      return id;
    },
    async getPhoto(id){ return tx('photos','readonly', s => req(s.get(id))); },
    async delPhoto(id){ await tx('photos','readwrite', s => { s.delete(id); }); const idx = await DB.get('photoIndex', []); await DB.set('photoIndex', idx.filter(x => x.id !== id)); },
    async photoKeys(){ return tx('photos','readonly', s => req(s.getAllKeys())); },

    /* 複数キーを1トランザクションで保存（途中失敗なら全部取り消し） */
    async setMany(obj){
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('kv', 'readwrite'); const s = t.objectStore('kv');
        for (const [k, v] of Object.entries(obj)) s.put(v, k);
        t.oncomplete = () => res(true); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('保存を中止しました'));
      });
    },

    /* バックアップ：JSON 1ファイル（写真を含める/含めないを選択）。APIキーなど秘密情報は含めない */
    async exportAll(includePhotos){
      const out = { app:'karada-mission', format:2, exportedAt:E.localISO(), kv:{}, photos:{}, secretsExcluded:true };
      for (const k of await DB.keys()) {
        let v = await DB.get(k);
        if (k === 'settings' && v) { v = { ...v }; delete v.geminiKey; }
        out.kv[k] = v;
      }
      if (includePhotos){
        for (const id of await DB.photoKeys()){
          const b = await DB.getPhoto(id);
          if (b) out.photos[id] = await blobToDataURL(b);
        }
      }
      out.counts = { keys:Object.keys(out.kv).length, photos:Object.keys(out.photos).length };
      return new Blob([JSON.stringify(out)], {type:'application/json'});
    },

    /* 復元：①全体を検証 ②写真を変換 ③1トランザクションで書き込み ④読み戻して確認 */
    async inspectBackup(file){
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('JSONとして読めません（ファイルが壊れている可能性）'); }
      if (data.app !== 'karada-mission' || typeof data.kv !== 'object') throw new Error('からだミッションのバックアップファイルではありません');
      const keys = Object.keys(data.kv);
      const days = keys.filter(k => k.startsWith('day:')).length;
      const buys = keys.filter(k => /^buy:\d{4}-\d{2}$/.test(k)).reduce((a, k) => a + (Array.isArray(data.kv[k]) ? data.kv[k].length : 0), 0);
      return { data, keys:keys.length, days, buys, photos:Object.keys(data.photos || {}).length, exportedAt:data.exportedAt, hasProfile:!!data.kv.profile };
    },
    async restore(data){
      const photos = [];
      for (const [id, url] of Object.entries(data.photos || {})) {
        if (typeof url !== 'string' || !url.startsWith('data:image/')) throw new Error('写真データが壊れています：' + id);
        photos.push([id, await (await fetch(url)).blob()]);
      }
      const cur = await DB.get('settings', {});
      const kv = { ...data.kv };
      if (kv.settings) kv.settings = { ...kv.settings, geminiKey: cur.geminiKey || '' }; // APIキーは端末のものを維持
      const db = await open();
      await new Promise((res, rej) => {
        const t = db.transaction(['kv', 'photos'], 'readwrite');
        const k = t.objectStore('kv'), p = t.objectStore('photos');
        for (const [key, v] of Object.entries(kv)) k.put(v, key);
        for (const [id, b] of photos) p.put(b, id);
        t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('復元を中止しました（データは変更されていません）'));
      });
      // 読み戻し確認
      const bad = [];
      for (const key of Object.keys(kv)) { if ((await DB.get(key)) === null) bad.push(key); }
      for (const [id] of photos) { if (!(await DB.getPhoto(id))) bad.push(id); }
      return { written: Object.keys(kv).length, photos: photos.length, bad };
    }
  };
  function blobToDataURL(b){ return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); }
  DB.blobToDataURL = blobToDataURL;

  /* 写真を縮小して保存（容量節約） */
  DB.compressImage = function(file, max=1280, q=0.82){
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const sc = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width*sc); c.height = Math.round(img.height*sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => { URL.revokeObjectURL(img.src); res(b); }, 'image/jpeg', q);
      };
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  };
  window.DB = DB;
})();
