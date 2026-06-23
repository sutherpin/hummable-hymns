/* app.js
   Loads data/songs.json and renders either:
   - the category grid on index.html
   - the song list + wires up Player on playlist.html
*/

document.addEventListener("DOMContentLoaded", () => {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  fetch("data/songs.json")
    .then((res) => res.json())
    .then((data) => {
      // Apply custom site text if present
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

  const counts = {};
  data.songs.forEach((song) => {
    counts[song.category] = (counts[song.category] || 0) + 1;
  });

  const allCard = makeCategoryCard("all", "All Songs", data.songs.length, true);
  grid.appendChild(allCard);

  data.categories.forEach((cat) => {
    const count = counts[cat.id] || 0;
    grid.appendChild(makeCategoryCard(cat.id, cat.name, count, false));
  });
}

function makeCategoryCard(id, name, count, isAll) {
  const card = document.createElement("a");
  card.href = `playlist.html?category=${encodeURIComponent(id)}`;
  card.className = "category-card" + (isAll ? " all-card" : "");
  card.innerHTML = `
    <h2>${name}</h2>
    <p>${count} song${count === 1 ? "" : "s"}</p>
  `;
  return card;
}

function renderPlaylist(data) {
  const params = new URLSearchParams(window.location.search);
  const categoryId = params.get("category") || "all";

  const categoryName =
    categoryId === "all"
      ? "All Songs"
      : (data.categories.find((c) => c.id === categoryId) || {}).name || "Playlist";

  document.getElementById("category-title").textContent = categoryName;

  const songs =
    categoryId === "all"
      ? data.songs
      : data.songs.filter((s) => s.category === categoryId);

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
