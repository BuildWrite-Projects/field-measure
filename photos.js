/* Field Measure — photos.
 *
 * Photos are far too big to ride in the job's JSON (one photo outweighs every
 * measurement in the app), so they live apart from it:
 *
 *   - on the phone, in IndexedDB (room for hundreds of MB; localStorage is ~5MB)
 *   - in Supabase Storage, bucket "fieldmeasure", at  <user id>/<job id>/<photo id>.jpg
 *
 * The job itself only keeps a short list of what was taken (id, label, size) in
 * job.photos, so that list syncs with the measurements like everything else.
 *
 * Every photo is shrunk as it comes in: 2048 px on the long side, JPEG at 82%.
 * That is roughly 400-600 KB instead of 3-5 MB, still sharp enough to read a
 * meter label, and small enough that a whole job can go out in one email.
 *
 * A photo taken from inside a web app on an iPhone is NOT saved to the camera
 * roll, so until it is backed up this phone holds the only copy. Uploads retry
 * whenever the app opens, comes back online or a new photo is taken.
 */
(function () {
  'use strict';

  var MAX_EDGE = 2048;
  var QUALITY = 0.82;
  var BUCKET = 'fieldmeasure';

  var opts = { client: function () { return null; }, uid: function () { return null; },
               onUploaded: function () {} };
  var urls = {};            // id -> object URL, so a grid redraw doesn't decode again
  var pumping = false;

  /* ---------- IndexedDB ---------------------------------------------------- */
  var dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var rq;
      try { rq = indexedDB.open('fieldmeasure-photos', 1); } catch (e) { return rej(e); }
      rq.onupgradeneeded = function () {
        var d = rq.result;
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
        /* ids still to back up, kept apart so checking the queue never has to
           read every photo into memory */
        if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id' });
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function tx(mode, fn, store) {
    store = store || 'photos';
    return open().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode);
        var rq = fn(t.objectStore(store));
        t.oncomplete = function () { res(rq ? rq.result : undefined); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('aborted')); };
      });
    });
  }
  var idb = {
    put: function (rec) { return tx('readwrite', function (s) { return s.put(rec); }); },
    get: function (id) { return tx('readonly', function (s) { return s.get(id); }); },
    all: function () { return tx('readonly', function (s) { return s.getAll(); }); },
    del: function (id) { return tx('readwrite', function (s) { return s.delete(id); }); },
    qPut: function (id, jobId) { return tx('readwrite', function (s) { return s.put({ id: id, jobId: jobId }); }, 'queue'); },
    qAll: function () { return tx('readonly', function (s) { return s.getAll(); }, 'queue'); },
    qDel: function (id) { return tx('readwrite', function (s) { return s.delete(id); }, 'queue'); }
  };

  /* Ask the browser not to clear our storage when the phone runs low. Apps
     added to the home screen are mostly safe already; this makes it explicit. */
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  /* ---------- shrinking ---------------------------------------------------- */
  function loadImage(file) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { res({ img: img, url: u }); };
      img.onerror = function () { URL.revokeObjectURL(u); rej(new Error('That file isn’t a photo this phone can open.')); };
      img.src = u;
    });
  }
  /* Browsers now turn a photo upright (EXIF orientation) before drawing it,
     so the canvas copy comes out the right way up with no extra work. */
  function shrink(file) {
    return loadImage(file).then(function (o) {
      var img = o.img;
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) { URL.revokeObjectURL(o.url); throw new Error('That photo came through empty.'); }
      var k = Math.min(1, MAX_EDGE / Math.max(w, h));
      var cw = Math.round(w * k), ch = Math.round(h * k);
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      var g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
      g.drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(o.url);
      return new Promise(function (res, rej) {
        c.toBlob(function (b) {
          c.width = c.height = 0;          // let iOS give the canvas memory back now
          if (!b) return rej(new Error('Couldn’t shrink that photo.'));
          res({ blob: b, w: cw, h: ch });
        }, 'image/jpeg', QUALITY);
      });
    });
  }

  function newId() {
    return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function pathFor(uid, jobId, id) { return uid + '/' + jobId + '/' + id + '.jpg'; }

  /* ---------- backing up ---------------------------------------------------- */
  function pump() {
    if (pumping) return Promise.resolve();
    var client = opts.client(), uid = opts.uid();
    if (!client || !uid || (navigator.onLine === false)) return Promise.resolve();
    pumping = true;
    return idb.qAll().then(function (todo) {
      /* one at a time: a phone on one bar of signal does better with a single
         upload than five fighting each other */
      var p = Promise.resolve();
      todo.forEach(function (q) {
        p = p.then(function () {
          return idb.get(q.id).then(function (r) {
            if (!r || !r.blob) return idb.qDel(q.id);      // deleted meanwhile
            return client.storage.from(BUCKET)
              .upload(pathFor(uid, r.jobId, r.id), r.blob, { contentType: 'image/jpeg', upsert: true })
              .then(function (res) {
                if (res && res.error) throw res.error;
                r.up = true;
                return idb.put(r).then(function () { return idb.qDel(r.id); }).then(function () {
                  try { opts.onUploaded(r.id, r.jobId); } catch (e) {}
                });
              });
          });
        });
      });
      return p;
    }).catch(function (e) {
      try { console.log('[FM] photo upload', e && (e.message || e)); } catch (x) {}
    }).then(function () { pumping = false; });
  }

  /* ---------- the API the app uses ------------------------------------------ */
  window.FMPhotos = {
    MAX_EDGE: MAX_EDGE,

    init: function (o) {
      for (var k in o) opts[k] = o[k];
      pump();
    },

    /* Shrink a picked or taken file, keep it on this phone, queue the backup.
       Resolves to the short record the job keeps in job.photos. */
    add: function (file, jobId) {
      return shrink(file).then(function (s) {
        var rec = { id: newId(), jobId: jobId, at: Date.now(), blob: s.blob, w: s.w, h: s.h,
                    bytes: s.blob.size, up: false };
        return idb.put(rec).then(function () { return idb.qPut(rec.id, jobId); }).then(function () {
          setTimeout(pump, 50);
          return { id: rec.id, at: rec.at, w: rec.w, h: rec.h, bytes: rec.bytes };
        });
      });
    },

    /* The photo itself. From this phone if it's here; otherwise (taken on
       another phone) fetched from the backup once and kept. Null if neither. */
    blob: function (id, jobId) {
      return idb.get(id).then(function (r) {
        if (r && r.blob) return r.blob;
        var client = opts.client(), uid = opts.uid();
        if (!client || !uid) return null;
        return client.storage.from(BUCKET).download(pathFor(uid, jobId, id)).then(function (res) {
          if (!res || res.error || !res.data) return null;
          var b = res.data;
          return idb.put({ id: id, jobId: jobId, at: Date.now(), blob: b, bytes: b.size, up: true })
            .then(function () { return b; }, function () { return b; });
        });
      }).catch(function () { return null; });
    },

    url: function (id, jobId) {
      if (urls[id]) return Promise.resolve(urls[id]);
      return this.blob(id, jobId).then(function (b) {
        if (!b) return null;
        if (!urls[id]) urls[id] = URL.createObjectURL(b);
        return urls[id];
      });
    },

    /* Is it backed up? true / false / null (not on this phone at all) */
    isUp: function (id) {
      return idb.get(id).then(function (r) { return r ? !!r.up : null; }, function () { return null; });
    },

    /* How many photos on this phone are still waiting to go up. */
    waiting: function () {
      return idb.qAll().then(function (l) { return l.length; }, function () { return 0; });
    },

    remove: function (id, jobId) {
      if (urls[id]) { try { URL.revokeObjectURL(urls[id]); } catch (e) {} delete urls[id]; }
      var client = opts.client(), uid = opts.uid();
      var gone = idb.del(id).then(function () { return idb.qDel(id); }).catch(function () {});
      if (client && uid) {
        client.storage.from(BUCKET).remove([pathFor(uid, jobId, id)]).catch(function () {});
      }
      return gone;
    },

    pump: pump
  };

  addEventListener('online', function () { pump(); });
  addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pump();
  });
})();
