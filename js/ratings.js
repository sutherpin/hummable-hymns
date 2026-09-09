/* ─────────────────────────────────────────────────────────────────────────────
   ratings.js — the star-rating dock in the player bar.

   Renders 5 tappable stars + a readout under the now-playing title. On each
   track change (Player.onChange) it shows the visitor's own saved rating
   (localStorage) immediately, then fetches the community average from the
   ratings Worker. Tapping a star writes locally first (optimistic), then
   POSTs; a failed POST keeps the local vote and says so quietly.

   Backend: https://api.hummablehymns.com  (see hh-ratings-worker/)
   ────────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  var API = "https://api.hummablehymns.com";
  var LS_PREFIX = "hh-rating:";

  var container = null;
  var starEls = [];
  var readoutEl = null;

  var currentId = null;   // song id the dock is currently bound to
  var myVote = 0;         // this visitor's rating for currentId (0 = none)
  var community = null;   // { sum, count, avg } from the Worker, or null
  var hoverValue = 0;     // pointer hover preview (desktop only)
  var posting = false;    // a /rate POST is in flight

  function lsGet(id) {
    try {
      return parseInt(localStorage.getItem(LS_PREFIX + id), 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  function lsSet(id, value) {
    try {
      localStorage.setItem(LS_PREFIX + id, String(value));
    } catch (e) {
      /* private mode / storage disabled — the vote still POSTs, it just
         won't be remembered as "yours" on the next visit. */
    }
  }

  function build() {
    container = document.getElementById("player-rating");
    if (!container) return;

    var stars = document.createElement("div");
    stars.className = "rating-stars";
    stars.setAttribute("role", "group");
    stars.setAttribute("aria-label", "Rate this song");

    for (var i = 1; i <= 5; i++) {
      (function (value) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "rating-star";
        b.setAttribute("aria-label", "Rate " + value + (value > 1 ? " stars" : " star"));
        b.innerHTML = "★";
        b.addEventListener("click", function () { vote(value); });
        b.addEventListener("mouseenter", function () { hoverValue = value; paint(); });
        b.addEventListener("mouseleave", function () { hoverValue = 0; paint(); });
        stars.appendChild(b);
        starEls.push(b);
      })(i);
    }

    readoutEl = document.createElement("span");
    readoutEl.className = "rating-readout";

    container.appendChild(stars);
    container.appendChild(readoutEl);
  }

  function paint() {
    if (!container) return;

    var communityRounded = community && community.count ? Math.round(community.avg) : 0;
    var fill = hoverValue || myVote || 0;

    for (var i = 0; i < starEls.length; i++) {
      var v = i + 1;
      var el = starEls[i];
      var showCommunityGhost = !hoverValue && !myVote && v <= communityRounded;
      el.classList.toggle("is-filled", v <= fill);
      el.classList.toggle("is-mine", !hoverValue && myVote > 0 && v <= myVote);
      el.classList.toggle("is-community", showCommunityGhost);
      el.setAttribute("aria-pressed", myVote === v ? "true" : "false");
    }

    if (community && community.count) {
      readoutEl.textContent =
        community.avg.toFixed(1) + " (" + community.count + ")" +
        (myVote ? "  ·  you " + myVote : "");
    } else {
      readoutEl.textContent = myVote
        ? "you " + myVote + "  ·  be the first"
        : "not yet rated";
    }
  }

  function showFor(song) {
    if (!container) return;

    var id = song && song.id ? song.id : null;
    if (!id) {
      container.classList.add("hidden");
      currentId = null;
      return;
    }
    if (id === currentId) return; // same track — keep the state we have

    currentId = id;
    hoverValue = 0;
    myVote = lsGet(id);
    community = null;
    container.classList.remove("hidden");
    paint();
    fetchCommunity(id);
  }

  function fetchCommunity(id) {
    fetch(API + "/ratings?id=" + encodeURIComponent(id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || currentId !== id) return; // track changed while in flight
        community = { sum: data.sum, count: data.count, avg: data.avg };
        paint();
      })
      .catch(function () { /* offline / Worker down — leave readout as-is */ });
  }

  function vote(value) {
    if (!currentId || posting || value === myVote) return;

    var id = currentId;
    var prev = myVote;

    myVote = value;
    lsSet(id, value);

    // Optimistically fold the vote into the community numbers so the
    // readout moves immediately; the POST response replaces this.
    if (community) {
      var sum = community.sum;
      var count = community.count;
      if (prev >= 1 && prev <= 5 && count > 0) {
        sum += value - prev;
      } else {
        sum += value;
        count += 1;
      }
      community = {
        sum: sum,
        count: count,
        avg: count ? Math.round((sum / count) * 10) / 10 : 0,
      };
    }

    paint();
    flash();

    posting = true;
    fetch(API + "/rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, stars: value, prev: prev }),
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        posting = false;
        if (currentId !== id) return;
        community = { sum: data.sum, count: data.count, avg: data.avg };
        paint();
      })
      .catch(function () {
        posting = false;
        if (currentId === id && readoutEl) {
          readoutEl.textContent = "saved here · sync failed";
        }
      });
  }

  function flash() {
    container.classList.remove("just-voted");
    void container.offsetWidth; // restart the CSS animation
    container.classList.add("just-voted");
  }

  function init() {
    build();
    // player.js declares `Player` with `const`, so it's a bare global, not
    // a property of window — reference it directly, like app.js does.
    if (!container || typeof Player === "undefined" || typeof Player.onChange !== "function") {
      return;
    }
    Player.onChange(function (song) { showFor(song); });
    var cur = typeof Player.getCurrentSong === "function" ? Player.getCurrentSong() : null;
    if (cur) showFor(cur);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
