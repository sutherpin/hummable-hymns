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
}
