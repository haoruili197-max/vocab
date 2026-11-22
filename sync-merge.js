/**
 * Vocab app cross-device merge (pure, no I/O).
 * Used by index.html and by Node unit tests.
 *
 * Payload:
 * {
 *   v: 1,
 *   notebook: [{w, p, m, b, t}],          // active 生词本; t = add time (ms)
 *   notebookTombstones: [{b, w, deletedAt}],
 *   progress: {
 *     [book]: {
 *       i, shuffle, seed, known, unknown, updatedAt,
 *       mastered: [word],
 *       masteredMeta: { [word]: t },
 *       masteredTombstones: { [word]: deletedAt }
 *     }
 *   },
 *   rounds: { [book]: { n, queue, ans, phase, undo, updatedAt } }
 * }
 *
 * Merge rules:
 * - 生词本: union by (book, word). Last event (add vs delete) wins.
 *   If both sides currently have the word (no newer delete), keep the earliest add time.
 *   A later re-add after a delete is kept (not crushed by the earlier add date).
 * - 已掌握: same last-event / tombstone rule per (book, word), so un-mastering on one
 *   device is not resurrected by an older mastered list on another device.
 * - progress fields (i, shuffle, seed, known, unknown) and rounds per book:
 *   the copy with the newer updatedAt wins. Missing updatedAt is treated as 0.
 *   Ties prefer local, so the device you are on is not clobbered mid-study.
 * - remote == null / empty: first login, return local as-is (normalized). Never overwrite
 *   local with an empty cloud row.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VocabSyncMerge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clone(x) {
    return x == null ? x : JSON.parse(JSON.stringify(x));
  }

  function isObj(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
  }

  function emptyPayload() {
    return { v: 1, notebook: [], notebookTombstones: [], progress: {}, rounds: {} };
  }

  function normalize(p) {
    if (!isObj(p)) return emptyPayload();
    var out = emptyPayload();
    out.v = p.v || 1;
    out.notebook = Array.isArray(p.notebook) ? clone(p.notebook) : [];
    out.notebookTombstones = Array.isArray(p.notebookTombstones) ? clone(p.notebookTombstones) : [];
    out.progress = isObj(p.progress) ? clone(p.progress) : {};
    out.rounds = isObj(p.rounds) ? clone(p.rounds) : {};
    return out;
  }

  function isEmptyPayload(p) {
    if (!isObj(p)) return true;
    var hasNb = Array.isArray(p.notebook) && p.notebook.length;
    var hasT = Array.isArray(p.notebookTombstones) && p.notebookTombstones.length;
    var hasP = isObj(p.progress) && Object.keys(p.progress).length;
    var hasR = isObj(p.rounds) && Object.keys(p.rounds).length;
    return !hasNb && !hasT && !hasP && !hasR;
  }

  function nbKey(b, w) {
    return String(b) + '\0' + String(w);
  }

  function collectNotebook(payload) {
    var map = {};
    (payload.notebookTombstones || []).forEach(function (x) {
      if (!x || x.w == null || x.b == null) return;
      var k = nbKey(x.b, x.w);
      var prev = map[k] || { w: x.w, b: x.b, t: 0, deletedAt: 0 };
      prev.deletedAt = Math.max(prev.deletedAt || 0, x.deletedAt || 0);
      map[k] = prev;
    });
    (payload.notebook || []).forEach(function (x) {
      if (!x || x.w == null || x.b == null) return;
      var k = nbKey(x.b, x.w);
      var prev = map[k] || { w: x.w, b: x.b, t: 0, deletedAt: 0 };
      prev.w = x.w;
      prev.b = x.b;
      if (x.p != null && x.p !== '') prev.p = x.p;
      if (x.m != null && x.m !== '') prev.m = x.m;
      if (x.t != null && x.t !== '') prev.t = x.t;
      else if (!prev.t) prev.t = 0;
      map[k] = prev;
    });
    return map;
  }

  function lastEvent(t, deletedAt) {
    t = t || 0;
    deletedAt = deletedAt || 0;
    if (deletedAt > t) return { time: deletedAt, type: 'del' };
    return { time: t, type: 'add' };
  }

  function mergeTimedItem(a, b, pickFields) {
    if (!a) return clone(b);
    if (!b) return clone(a);
    var ea = lastEvent(a.t, a.deletedAt);
    var eb = lastEvent(b.t, b.deletedAt);
    var t1 = a.t || 0, t2 = b.t || 0;
    var d1 = a.deletedAt || 0, d2 = b.deletedAt || 0;
    var maxDel = Math.max(d1, d2);
    var minAdd = Math.min(t1, t2);
    var maxAdd = Math.max(t1, t2);
    var out = pickFields(a, b);

    if (ea.type === 'add' && eb.type === 'add') {
      // Both currently present. Independent adds → earliest t.
      // Re-add after a delete that sits between the two add times → later t.
      if (maxDel >= minAdd && maxDel < maxAdd) {
        out.t = maxAdd;
        out.deletedAt = maxDel;
      } else {
        out.t = minAdd || maxAdd;
        out.deletedAt = maxDel < (minAdd || maxAdd) ? maxDel : 0;
      }
      return out;
    }
    if (ea.time !== eb.time) {
      var w = ea.time > eb.time ? a : b;
      out.t = w.t || 0;
      out.deletedAt = w.deletedAt || 0;
      if (w !== a) out = pickFields(w, a);
      else out = pickFields(w, b);
      out.t = w.t || 0;
      out.deletedAt = w.deletedAt || 0;
      return out;
    }
    // Same timestamp, mixed or both deletes: prefer delete so removals propagate.
    if (ea.type === 'del' || eb.type === 'del') {
      out.t = maxAdd;
      out.deletedAt = maxDel || ea.time;
      return out;
    }
    out.t = minAdd || maxAdd;
    out.deletedAt = 0;
    return out;
  }

  function pickNb(primary, other) {
    return {
      w: primary.w,
      b: primary.b,
      p: primary.p || (other && other.p) || '',
      m: primary.m || (other && other.m) || '',
      t: primary.t || 0,
      deletedAt: primary.deletedAt || 0
    };
  }

  function mergeNotebook(local, remote) {
    var A = collectNotebook(local);
    var B = collectNotebook(remote);
    var keys = {};
    Object.keys(A).forEach(function (k) { keys[k] = 1; });
    Object.keys(B).forEach(function (k) { keys[k] = 1; });
    var notebook = [];
    var tombstones = [];
    Object.keys(keys).forEach(function (k) {
      var item = mergeTimedItem(A[k], B[k], pickNb);
      var ev = lastEvent(item.t, item.deletedAt);
      if (ev.type === 'del') {
        tombstones.push({ b: item.b, w: item.w, deletedAt: item.deletedAt });
      } else {
        notebook.push({ w: item.w, p: item.p || '', m: item.m || '', b: item.b, t: item.t || 0 });
      }
    });
    notebook.sort(function (a, b) {
      return (a.t || 0) - (b.t || 0) || String(a.b).localeCompare(String(b.b)) || String(a.w).localeCompare(String(b.w));
    });
    return { notebook: notebook, notebookTombstones: tombstones };
  }

  function wordSet(progressBook) {
    var set = {};
    var p = progressBook || {};
    (p.mastered || []).forEach(function (w) { if (w != null) set[w] = 1; });
    if (isObj(p.masteredMeta)) Object.keys(p.masteredMeta).forEach(function (w) { set[w] = 1; });
    if (isObj(p.masteredTombstones)) Object.keys(p.masteredTombstones).forEach(function (w) { set[w] = 1; });
    return Object.keys(set);
  }

  function masteredItem(progressBook, word) {
    var p = progressBook || {};
    var inArr = (p.mastered || []).indexOf(word) >= 0;
    var t = (isObj(p.masteredMeta) && p.masteredMeta[word] != null) ? p.masteredMeta[word] : (inArr ? 0 : 0);
    var deletedAt = (isObj(p.masteredTombstones) && p.masteredTombstones[word] != null) ? p.masteredTombstones[word] : 0;
    if (!inArr && !t && !deletedAt) return null;
    // Present if in the array or add time is at least the tombstone time.
    // A bare array entry with t=0 stays present unless deletedAt > 0.
    return { w: word, t: t, deletedAt: deletedAt, inArr: inArr };
  }

  function pickMs(primary, other) {
    return {
      w: primary.w,
      t: primary.t || 0,
      deletedAt: primary.deletedAt || 0
    };
  }

  function mergeMastered(localBook, remoteBook) {
    var words = {};
    wordSet(localBook).forEach(function (w) { words[w] = 1; });
    wordSet(remoteBook).forEach(function (w) { words[w] = 1; });
    var meta = {};
    var tombs = {};
    var present = [];
    Object.keys(words).forEach(function (w) {
      var a = masteredItem(localBook, w);
      var b = masteredItem(remoteBook, w);
      if (!a && !b) return;
      if (!a) a = null;
      if (!b) b = null;
      var item = mergeTimedItem(a, b, pickMs);
      item.w = w;
      var ev = lastEvent(item.t, item.deletedAt);
      if (ev.type === 'del') {
        tombs[w] = item.deletedAt;
        if (item.t) meta[w] = item.t;
      } else {
        present.push(w);
        meta[w] = item.t || 0;
      }
    });
    // Keep order from the newer (or local-on-tie) side, then append extras.
    var localTs = (localBook && localBook.updatedAt) || 0;
    var remoteTs = (remoteBook && remoteBook.updatedAt) || 0;
    var primary = localTs >= remoteTs ? localBook : remoteBook;
    var ordered = [];
    var seen = {};
    ((primary && primary.mastered) || []).forEach(function (w) {
      if (present.indexOf(w) >= 0 && !seen[w]) { ordered.push(w); seen[w] = 1; }
    });
    present.forEach(function (w) {
      if (!seen[w]) { ordered.push(w); seen[w] = 1; }
    });
    return { mastered: ordered, masteredMeta: meta, masteredTombstones: tombs };
  }

  function mergeBookProgress(localBook, remoteBook) {
    var localOn = isObj(localBook);
    var remoteOn = isObj(remoteBook);
    if (!localOn) return clone(remoteBook);
    if (!remoteOn) return clone(localBook);
    var lt = localBook.updatedAt || 0;
    var rt = remoteBook.updatedAt || 0;
    var base = lt >= rt ? clone(localBook) : clone(remoteBook);
    var ms = mergeMastered(localBook, remoteBook);
    base.mastered = ms.mastered;
    base.masteredMeta = ms.masteredMeta;
    base.masteredTombstones = ms.masteredTombstones;
    return base;
  }

  function mergeRoundsBook(localR, remoteR) {
    if (!isObj(localR)) return clone(remoteR) || undefined;
    if (!isObj(remoteR)) return clone(localR);
    var lt = localR.updatedAt || 0;
    var rt = remoteR.updatedAt || 0;
    return clone(lt >= rt ? localR : remoteR);
  }

  function mergeVocabData(local, remote) {
    var L = normalize(local);
    var R = normalize(remote);
    // First login / empty cloud: keep local, do not overwrite with empty remote.
    if (isEmptyPayload(remote)) return L;
    if (isEmptyPayload(local)) return R;

    var nb = mergeNotebook(L, R);
    var progress = {};
    var books = {};
    Object.keys(L.progress).forEach(function (k) { books[k] = 1; });
    Object.keys(R.progress).forEach(function (k) { books[k] = 1; });
    Object.keys(L.rounds).forEach(function (k) { books[k] = 1; });
    Object.keys(R.rounds).forEach(function (k) { books[k] = 1; });
    var rounds = {};
    Object.keys(books).forEach(function (k) {
      if (L.progress[k] || R.progress[k]) {
        progress[k] = mergeBookProgress(L.progress[k], R.progress[k]);
      }
      var rr = mergeRoundsBook(L.rounds[k], R.rounds[k]);
      if (rr) rounds[k] = rr;
    });
    return {
      v: 1,
      notebook: nb.notebook,
      notebookTombstones: nb.notebookTombstones,
      progress: progress,
      rounds: rounds
    };
  }

  return {
    mergeVocabData: mergeVocabData,
    normalize: normalize,
    isEmptyPayload: isEmptyPayload
  };
});
