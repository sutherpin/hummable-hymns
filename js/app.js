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

document.addEventListener("DOMContentLoaded", () => {
  fetch("data/songs.json")
    .then((res) => res.json())
    .then((data) => {
      songsData = data;
      allSongs = data.songs;

      if (data.lastUpdated) {
        const el = document.getElementById("last-updated");
        if (el) el.textContent = "Last updated: " + data.lastUpdated;
      }

      if (document.getElementById("audio-player")) {
        Player.init();
      }

      setupSearch(data);
      setupNavInterception();
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
}

function showPlaylistView(categoryId, songToPlay) {
  document.getElementById("category-grid").classList.add("hidden");
  document.getElementById("playlist-view").classList.remove("hidden");
  document.getElementById("back-link").classList.remove("hidden");
  document.getElementById("page-tagline").classList.add("hidden");
  document.getElementById("site-header").classList.add("playlist-header");
  const footer = document.getElementById("site-footer");
  if (footer) footer.classList.add("hidden");

  renderPlaylist(songsData, categoryId, songToPlay);
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
  let categoryName;
  let songs;

  if (categoryId === "all") {
    categoryName = "All Songs";
    songs = data.songs;
  } else if (categoryId === "new-additions") {
    categoryName = "New Additions";
    songs = data.songs.filter((s) => isRecent(s.dateAdded));
  } else {
    categoryName = (data.categories.find((c) => c.id === categoryId) || {}).name || "Playlist";
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
  // keep it highlighted instead of leaving nothing selected.
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
