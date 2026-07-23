/* app.js
   Loads data/songs.json and renders the site as a single-page app:
   - the category grid ("/" or index.html with no ?category=)
   - the song list + Player ("index.html?category=...")

   This used to be two separate HTML pages (index.html / playlist.html).
   That meant every navigation was a full page load, which destroyed the
   <audio> element and stopped playback. Now navigation is handled with
   the History API so the player (and whatever is playing) survives
   moving between categories and back to the category grid.
*/

const NEW_ADDITIONS_DAYS = 10;

let songsData = null;
let allSongs = [];
let currentSongs = [];
let currentCategoryId = null; // null === category grid view is active
let searchTimeout = null;
let playerBarRevealed = false;

function isRecent(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24) <= NEW_ADDITIONS_DAYS;
}

function setupThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  const apply = (theme) => {
    if (theme === "day") {
      document.documentElement.setAttribute("data-theme", "day");
      btn.innerHTML = "&#9789;";
      btn.setAttribute("aria-label", "Switch to night mode");
    } else {
      document.documentElement.removeAttribute("data-theme");
      btn.innerHTML = "&#9788;";
      btn.setAttribute("aria-label", "Switch to day mode");
    }
  };

  apply(localStorage.getItem("theme") === "day" ? "day" : "night");

  btn.addEventListener("click", () => {
    const isDay = document.documentElement.getAttribute("data-theme") === "day";
    const next = isDay ? "night" : "day";
    localStorage.setItem("theme", next);
    apply(next);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupThemeToggle();

  fetch("data/songs.json")
    .then((res) => res.json())
    .then((data) => {
      songsData = data;
      allSongs = data.songs;

      if (data.lastUpdated) {
        const el = document.getElementById("last-updated");
        if (el) el.textContent = "Last updated: " + data.lastUpdated;
      }

      // Stamped fresh by deploy.sh on every deploy — lets a page load be
      // checked against what was actually last pushed live, rather than a
      // cached copy the browser (or an intermediate CDN edge) is still
      // serving.
      fetch("data/deploy-timestamp.txt", { cache: "no-store" })
        .then((res) => (res.ok ? res.text() : Promise.reject()))
        .then((text) => {
          const el = document.getElementById("deploy-stamp");
          if (el) el.textContent = "Deployed: " + text.trim();
        })
        .catch(() => {});

      if (document.getElementById("audio-player")) {
        Player.init();
        Player.onChange(updateNowPlayingStrip);
      }

      setupNowPlayingStrip();
      setupSearch(data);
      setupNavInterception();
      setupBugfixHistory();
      window.addEventListener("popstate", route);
      route();
    })
    .catch((err) => {
      console.error("Failed to load songs.json", err);
    });
});

// ── Client-side routing ──
// The whole site lives on index.html; ?category=<id> (and optionally
// &play=<index>) picks between the category grid and a playlist view
// without ever reloading the page.

function navigateTo(url) {
  const target = new URL(url, window.location.href);
  window.history.pushState({}, "", target.pathname + target.search);
  route();
}

function setupNavInterception() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const link = e.target.closest("a[href]");
    if (!link) return;

    const href = link.getAttribute("href");
    if (!href || /^(mailto:|tel:|https?:\/\/|#)/i.test(href)) return;

    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (!/\/index\.html$/.test(url.pathname) && url.pathname !== "/") return;

    e.preventDefault();
    navigateTo(url.pathname + url.search);
  });
}

function route() {
  if (!songsData) return;
  const params = new URLSearchParams(window.location.search);
  const categoryId = params.get("category");
  const songToPlay = params.get("play");

  if (categoryId) {
    showPlaylistView(categoryId, songToPlay);
  } else {
    showCategoryGridView();
  }
}

function showCategoryGridView() {
  currentCategoryId = null;

  document.getElementById("category-grid").classList.remove("hidden");
  document.getElementById("playlist-view").classList.add("hidden");
  document.getElementById("back-link").classList.add("hidden");
  document.getElementById("page-tagline").classList.remove("hidden");
  document.getElementById("site-header").classList.remove("playlist-header");
  const footer = document.getElementById("site-footer");
  if (footer) footer.classList.remove("hidden");

  const title = songsData.siteTitle || "Hummable Hymns";
  document.getElementById("page-title").textContent = title;
  document.getElementById("page-tagline").textContent = songsData.tagline || "Original songs, freely played.";
  document.title = title;

  const grid = document.getElementById("category-grid");
  grid.innerHTML = "";
  renderCategoryGrid(songsData);

  if (typeof Player !== "undefined") {
    updateNowPlayingStrip(Player.getCurrentSong());
  }
}

function showPlaylistView(categoryId, songToPlay) {
  document.getElementById("category-grid").classList.add("hidden");
  document.getElementById("playlist-view").classList.remove("hidden");
  document.getElementById("back-link").classList.remove("hidden");
  document.getElementById("page-tagline").classList.add("hidden");
  document.getElementById("site-header").classList.add("playlist-header");
  const footer = document.getElementById("site-footer");
  if (footer) footer.classList.add("hidden");

  const strip = document.getElementById("now-playing-strip");
  if (strip) strip.classList.add("hidden");

  renderPlaylist(songsData, categoryId, songToPlay);
}

// Shows a shortcut back to whatever's playing while browsing the category
// grid — the player bar itself already shows title/play-state and is
// visible everywhere, so this only needs to say where to find it, not
// repeat what's already on screen.
function updateNowPlayingStrip(song) {
  const strip = document.getElementById("now-playing-strip");
  if (!strip) return;

  if (!song || currentCategoryId !== null) {
    strip.classList.add("hidden");
    return;
  }

  const categoryName = getCategoryName(song.category, songsData);
  document.getElementById("now-playing-strip-text").textContent = `Playing from ${categoryName}`;
  strip.classList.remove("hidden");
}

function getCategoryName(categoryId, data) {
  if (categoryId === "all" || !categoryId) return "All Songs";
  if (categoryId === "new-additions") return "New Additions";
  return (data.categories.find((c) => c.id === categoryId) || {}).name || "Playlist";
}

// Clicking the strip jumps to the playing song's category. It's already
// loaded and playing, so this never touches Player — just navigation.
function setupNowPlayingStrip() {
  const strip = document.getElementById("now-playing-strip");
  if (!strip) return;

  strip.addEventListener("click", () => {
    const song = Player.getCurrentSong();
    if (!song) return;
    navigateTo(`index.html?category=${encodeURIComponent(song.category || "all")}`);
  });
}

function revealPlayerBar() {
  if (playerBarRevealed) return;
  playerBarRevealed = true;
  document.getElementById("player-bar").classList.remove("hidden");
}

function renderCategoryGrid(data) {
  const grid = document.getElementById("category-grid");

  const counts = {};
  data.songs.forEach((song) => {
    counts[song.category] = (counts[song.category] || 0) + 1;
  });

  const recentSongs = data.songs.filter((s) => isRecent(s.dateAdded));

  grid.appendChild(makeCategoryCard("all", "All Songs", data.songs.length, true));

  if (recentSongs.length > 0) {
    grid.appendChild(makeCategoryCard("new-additions", "New Additions", recentSongs.length, false, true));
  }

  data.categories.forEach((cat) => {
    const count = counts[cat.id] || 0;
    if (count === 0) return;
    grid.appendChild(makeCategoryCard(cat.id, cat.name, count, false, false));
  });
}

function makeCategoryCard(id, name, count, isAll, isNew) {
  const card = document.createElement("a");
  card.href = `index.html?category=${encodeURIComponent(id)}`;
  card.className = "category-card" + (isAll ? " all-card" : "") + (isNew ? " new-card" : "");
  card.innerHTML = `
    <h2>${name}</h2>
    <p>${count} song${count === 1 ? "" : "s"}</p>
  `;
  return card;
}

function renderPlaylist(data, categoryId, songToPlay) {
  const categoryName = getCategoryName(categoryId, data);
  let songs;

  if (categoryId === "all") {
    songs = data.songs;
  } else if (categoryId === "new-additions") {
    songs = data.songs.filter((s) => isRecent(s.dateAdded));
  } else {
    songs = data.songs.filter((s) => s.category === categoryId);
  }

  currentCategoryId = categoryId;
  currentSongs = songs;

  document.getElementById("page-title").textContent = categoryName;
  document.title = categoryName + " - " + (data.siteTitle || "Hummable Hymns");

  const listEl = document.getElementById("song-list");
  listEl.innerHTML = "";
  songs.forEach((song, index) => {
    const li = document.createElement("li");
    li.className = "song-item";
    li.dataset.index = index;
    li.innerHTML = `
      <span class="song-num">${index + 1}</span>
      <span class="song-title">${song.title}</span>
      ${isRecent(song.dateAdded) ? '<span class="song-badge-new">New</span>' : ""}
      <span class="song-icon">&#9654;</span>
    `;
    li.addEventListener("click", () => {
      Player.loadTrack(index);
      highlightActive(index);
    });
    listEl.appendChild(li);
  });

  revealPlayerBar();

  // Reassign the playlist context for prev/next/shuffle, but don't touch
  // whatever is currently playing (startIndex -1 is a no-op for playback).
  Player.setPlaylist(songs, -1, (index, song) => {
    document.getElementById("now-playing-title").textContent = song.title;
    highlightActive(index);
  });

  // If the song that's already playing happens to be in this category,
  // keep it highlighted instead of leaving nothing selected. getCurrentSong()
  // always reports the real playing track, regardless of which category is
  // currently displayed.
  const current = Player.getCurrentSong();
  if (current) {
    const idx = songs.findIndex((s) => s.filename === current.filename);
    if (idx !== -1) highlightActive(idx);
  }

  if (songToPlay !== null && songToPlay !== undefined) {
    const playIndex = parseInt(songToPlay, 10);
    if (!isNaN(playIndex) && playIndex >= 0 && playIndex < songs.length) {
      Player.loadTrack(playIndex);
      highlightActive(playIndex);
      const songElement = document.querySelector(`.song-item[data-index="${playIndex}"]`);
      if (songElement) {
        songElement.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }

  function highlightActive(index) {
    document.querySelectorAll(".song-item").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.index) === index);
    });
  }
}

function setupSearch(data) {
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");

  if (!searchInput || !searchResults) {
    return;
  }

  if (allSongs.length === 0) {
    allSongs = data.songs;
  }

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();
    if (query.length === 0) {
      searchResults.classList.remove("show");
      return;
    }
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      performSearch(query, data);
    }, 200);
  });

  searchInput.addEventListener("focus", () => {
    if (searchInput.value.trim().length > 0) {
      performSearch(searchInput.value.trim(), data);
    }
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (query.length > 0) {
        performSearch(query, data);
      }
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target !== searchInput) {
      searchResults.classList.remove("show");
    }
  });
}

function performSearch(query, data) {
  const searchResults = document.getElementById("search-results");
  searchResults.innerHTML = "";

  if (!query) {
    searchResults.classList.remove("show");
    return;
  }

  const results = allSongs.filter(song =>
    song.title.toLowerCase().includes(query.toLowerCase())
  );

  if (results.length === 0) {
    const noResults = document.createElement("div");
    noResults.className = "no-results";
    noResults.textContent = "No songs found";
    searchResults.appendChild(noResults);
    searchResults.classList.add("show");
    return;
  }

  results.forEach(song => {
    const resultItem = document.createElement("div");
    resultItem.className = "search-result-item";

    const category = data.categories.find(cat => cat.id === song.category);
    const categoryName = category ? category.name : "Unknown";

    resultItem.innerHTML = `
      <div class="result-title">${song.title}</div>
      <div class="result-category">${categoryName}</div>
    `;

    const songIndexInCurrentPlaylist = currentSongs.findIndex(s => s.title === song.title && s.filename === song.filename);
    const songCategory = song.category || "all";

    resultItem.addEventListener("click", () => {
      if (currentCategoryId !== null && songIndexInCurrentPlaylist !== -1) {
        // Song is already part of the playlist view that's showing —
        // just play it in place, no navigation needed.
        Player.loadTrack(songIndexInCurrentPlaylist);
        highlightActiveSong(songIndexInCurrentPlaylist);
        document.getElementById("now-playing-title").textContent = song.title;
        const songElement = document.querySelector(`.song-item[data-index="${songIndexInCurrentPlaylist}"]`);
        if (songElement) {
          songElement.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } else {
        const targetSongs = songCategory === "all" ? data.songs : data.songs.filter(s => s.category === songCategory);
        const songIndexInTarget = targetSongs.findIndex(s => s.title === song.title && s.filename === song.filename);
        navigateTo(`index.html?category=${encodeURIComponent(songCategory)}&play=${songIndexInTarget}`);
      }

      document.getElementById("search-results").classList.remove("show");
      document.getElementById("search-input").value = "";
    });

    searchResults.appendChild(resultItem);
  });

  searchResults.classList.add("show");
}

function highlightActiveSong(index) {
  document.querySelectorAll(".song-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.index) === index);
  });
}

// "Bugfix history" modal — pulls commit history live from the GitHub API
// on demand (only when opened, not on every page load) so casual visitors
// never pay for it.
const GITHUB_REPO = "sutherpin/hummable-hymns";
let bugfixHistoryLoaded = false;

function setupBugfixHistory() {
  const btn = document.getElementById("bugfix-history-btn");
  const modal = document.getElementById("bugfix-modal");
  const backdrop = document.getElementById("bugfix-modal-backdrop");
  const closeBtn = document.getElementById("bugfix-modal-close");
  if (!btn || !modal) return;

  const open = () => {
    modal.classList.remove("hidden");
    if (!bugfixHistoryLoaded) loadBugfixHistory();
  };
  const close = () => modal.classList.add("hidden");

  btn.addEventListener("click", open);
  backdrop.addEventListener("click", close);
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
}

function loadBugfixHistory() {
  const body = document.getElementById("bugfix-modal-body");

  fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=100`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.status))))
    .then((commits) => {
      bugfixHistoryLoaded = true;
      renderBugfixHistory(commits, body);
    })
    .catch(() => {
      body.innerHTML = '<p class="bugfix-error">Couldn\'t load history from GitHub right now — try again in a bit.</p>';
    });
}

function renderBugfixHistory(commits, body) {
  // Merge commits are just "caught up with origin/main" noise, not
  // actual changes — skip anything with more than one parent.
  const real = commits.filter((c) => (c.parents || []).length <= 1);

  if (real.length === 0) {
    body.innerHTML = '<p class="bugfix-error">No history to show.</p>';
    return;
  }

  const groups = [];
  let currentKey = null;
  let currentList = null;

  real.forEach((c) => {
    const date = new Date(c.commit.author.date);
    const key = date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    if (key !== currentKey) {
      currentKey = key;
      currentList = [];
      groups.push({ label: key, items: currentList });
    }
    const summary = (c.commit.message || "").split("\n")[0];
    currentList.push({ summary, url: c.html_url, sha: c.sha.slice(0, 7) });
  });

  body.innerHTML = "";
  groups.forEach((group) => {
    const section = document.createElement("div");
    section.className = "bugfix-date-group";

    const heading = document.createElement("h3");
    heading.className = "bugfix-date-heading";
    heading.textContent = group.label;
    section.appendChild(heading);

    const list = document.createElement("ul");
    list.className = "bugfix-list";
    group.items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item.summary;
      const link = document.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `#${item.sha}`;
      li.appendChild(link);
      list.appendChild(li);
    });
    section.appendChild(list);

    body.appendChild(section);
  });
}
