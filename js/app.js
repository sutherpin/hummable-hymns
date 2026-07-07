/* app.js
   Loads data/songs.json and renders either:
   - the category grid on index.html
   - the song list + wires up Player on playlist.html
*/

const NEW_ADDITIONS_DAYS = 10;

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
      if (data.siteTitle) {
        const h1 = document.querySelector(".site-header h1");
        if (h1) h1.textContent = data.siteTitle;
        document.title = data.siteTitle + (document.title.includes(" - ") ? document.title.substring(document.title.indexOf(" - ")) : "");
      }
      if (data.tagline) {
        const tag = document.querySelector(".tagline");
        if (tag) tag.textContent = data.tagline;
      }
      if (data.lastUpdated) {
        const el = document.getElementById("last-updated");
        if (el) el.textContent = "Last updated: " + data.lastUpdated;
      }

      if (document.getElementById("category-grid")) {
        renderCategoryGrid(data);
        // Initialize search functionality on index page
        setupSearch(data);
      } else if (document.getElementById("song-list")) {
        renderPlaylist(data);
      }
    })
    .catch((err) => {
      console.error("Failed to load songs.json", err);
    });
});

function renderCategoryGrid(data) {
  const grid = document.getElementById("category-grid");

  // Count songs per real category
  const counts = {};
  data.songs.forEach((song) => {
    counts[song.category] = (counts[song.category] || 0) + 1;
  });

  // Check for recent songs (New Additions)
  const recentSongs = data.songs.filter((s) => isRecent(s.dateAdded));

  // All Songs card
  grid.appendChild(makeCategoryCard("all", "All Songs", data.songs.length, true));

  // New Additions card — only shown if there are recent songs
  if (recentSongs.length > 0) {
    grid.appendChild(makeCategoryCard("new-additions", "New Additions", recentSongs.length, false, true));
  }

  // Regular category cards
  data.categories.forEach((cat) => {
    const count = counts[cat.id] || 0;
    grid.appendChild(makeCategoryCard(cat.id, cat.name, count, false, false));
  });
}

function makeCategoryCard(id, name, count, isAll, isNew) {
  const card = document.createElement("a");
  card.href = `playlist.html?category=${encodeURIComponent(id)}`;
  card.className = "category-card" + (isAll ? " all-card" : "") + (isNew ? " new-card" : "");
  card.innerHTML = `
    <h2>${name}</h2>
    <p>${count} song${count === 1 ? "" : "s"}</p>
  `;
  return card;
}

// Global variables for search functionality
let allSongs = [];
let currentSongs = [];
let searchTimeout = null;
let searchData = null;

function renderPlaylist(data) {
  const params = new URLSearchParams(window.location.search);
  const categoryId = params.get("category") || "all";

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

  // Store all songs and current songs for search functionality
  allSongs = data.songs;
  currentSongs = songs;

  document.getElementById("category-title").textContent = categoryName;

  const listEl = document.getElementById("song-list");
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

  function highlightActive(index) {
    document.querySelectorAll(".song-item").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.index) === index);
    });
  }

  Player.init();
  Player.setPlaylist(songs, -1, (index, song) => {
    document.getElementById("now-playing-title").textContent = song.title;
    highlightActive(index);
  });

  // Initialize search functionality
  setupSearch(data);
}

// Search functionality
function setupSearch(data) {
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");

  if (!searchInput || !searchResults) {
    return;
  }

  // Populate allSongs if not already populated (for index page)
  if (allSongs.length === 0) {
    allSongs = data.songs;
    currentSongs = data.songs; // On index page, all songs are available
  }

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();

    if (query.length === 0) {
      searchResults.classList.remove("show");
      return;
    }

    // Debounce the search
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

  // Add Enter key support
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (query.length > 0) {
        performSearch(query, data);
      }
    }
  });

  // Close dropdown when clicking outside
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

  // Search through all songs (not just current category)
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

    // Find category name
    const category = data.categories.find(cat => cat.id === song.category);
    const categoryName = category ? category.name : "Unknown";

    resultItem.innerHTML = `
      <div class="result-title">${song.title}</div>
      <div class="result-category">${categoryName}</div>
    `;

    // Find the index of this song in the current playlist
    const songIndex = currentSongs.findIndex(s => s.title === song.title && s.filename === song.filename);

    // Check if we're on index page or playlist page
    const isIndexPage = document.getElementById("category-grid") !== null;

    resultItem.addEventListener("click", () => {
      if (isIndexPage) {
        // On index page, redirect to playlist page with the song's category
        const songCategory = song.category || "all";
        window.location.href = `playlist.html?category=${encodeURIComponent(songCategory)}`;
      } else {
        // On playlist page, play the song directly
        if (songIndex !== -1) {
          Player.loadTrack(songIndex);
          highlightActiveSong(songIndex);

          // Update the "now playing" title
          document.getElementById("now-playing-title").textContent = song.title;

          // Scroll the song into view
          const songElement = document.querySelector(`.song-item[data-index="${songIndex}"]`);
          if (songElement) {
            songElement.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }
      }

      // Close the search dropdown
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
