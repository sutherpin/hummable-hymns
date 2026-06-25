/* player.js
   Lightweight wrapper around the native <audio> element.
   Exposes a global `Player` object used by app.js on playlist.html.
*/

const R2_BASE_URL = "https://pub-d1176e54922d4c95964ec94fbb1442fa.r2.dev";

function buildSongUrl(filename) {
  return R2_BASE_URL + "/" + encodeURIComponent(filename);
}

// Lyrics live alongside the mp3 in the same R2 bucket, same base filename,
// but with a .txt extension instead of .mp3 (e.g. "Song.mp3" -> "Song.txt").
function buildLyricsUrl(filename) {
  const base = filename.replace(/\.[^./]+$/, "");
  return R2_BASE_URL + "/" + encodeURIComponent(base + ".txt");
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

const Player = (() => {
  let audio;
  let playlist = [];
  let currentIndex = -1;
  let onTrackChange = () => {};
  let lyricsBtn, lyricsPanel, lyricsPanelBody;
  let lyricsRequestId = 0; // guards against a slow/old fetch overwriting a newer track's lyrics

  function init() {
    audio = document.getElementById("audio-player");
    const playPauseBtn = document.getElementById("play-pause-btn");
    const prevBtn = document.getElementById("prev-btn");
    const nextBtn = document.getElementById("next-btn");
    const seekBar = document.getElementById("seek-bar");
    const volumeBar = document.getElementById("volume-bar");
    const currentTimeEl = document.getElementById("current-time");
    const durationTimeEl = document.getElementById("duration-time");

    lyricsBtn = document.getElementById("lyrics-btn");
    lyricsPanel = document.getElementById("lyrics-panel");
    lyricsPanelBody = document.getElementById("lyrics-panel-body");

    playPauseBtn.addEventListener("click", togglePlay);
    prevBtn.addEventListener("click", playPrev);
    nextBtn.addEventListener("click", playNext);

    // Expanding/collapsing lyrics is purely a CSS/DOM toggle — it never
    // touches `audio`, so play/pause/seek/volume continue uninterrupted.
    if (lyricsBtn) {
      lyricsBtn.addEventListener("click", () => {
        if (lyricsBtn.disabled) return;
        const isOpen = lyricsPanel.classList.toggle("open");
        lyricsBtn.innerHTML = isOpen ? "&#9650; Hide Lyrics" : "&#9660; Lyrics";
        lyricsBtn.setAttribute("aria-label", isOpen ? "Hide lyrics" : "Show lyrics");
      });
    }

    audio.addEventListener("loadedmetadata", () => {
      seekBar.max = audio.duration || 0;
      durationTimeEl.textContent = formatTime(audio.duration);
    });

    audio.addEventListener("timeupdate", () => {
      seekBar.value = audio.currentTime;
      currentTimeEl.textContent = formatTime(audio.currentTime);
    });

    audio.addEventListener("ended", playNext);

    audio.addEventListener("error", () => {
      const song = playlist[currentIndex];
      const title = song ? song.title : "Unknown";
      document.getElementById("now-playing-title").textContent = `⚠️ Error loading "${title}" — file may be missing or URL is broken.`;
      document.getElementById("play-pause-btn").innerHTML = "&#9654;";
    });

    audio.addEventListener("play", () => {
      playPauseBtn.innerHTML = "&#10074;&#10074;"; // pause icon
    });
    audio.addEventListener("pause", () => {
      playPauseBtn.innerHTML = "&#9654;"; // play icon
    });

    seekBar.addEventListener("input", () => {
      audio.currentTime = seekBar.value;
    });

    volumeBar.addEventListener("input", () => {
      audio.volume = volumeBar.value;
    });
  }

  function setPlaylist(songs, startIndex, trackChangeCallback) {
    playlist = songs;
    onTrackChange = trackChangeCallback || (() => {});
    loadTrack(startIndex);
  }

  function loadTrack(index) {
    if (index < 0 || index >= playlist.length) return;
    currentIndex = index;
    const song = playlist[currentIndex];
    audio.src = buildSongUrl(song.filename);
    audio.play().catch(() => {
      /* Autoplay may be blocked until user interacts; that's fine. */
    });
    onTrackChange(currentIndex, song);
    loadLyricsFor(song);
  }

  function loadLyricsFor(song) {
    if (!lyricsBtn || !lyricsPanelBody) return;

    // Switching tracks always closes any open panel and disables the
    // button until we've confirmed whether lyrics exist for the new song.
    const requestId = ++lyricsRequestId;
    lyricsPanel.classList.remove("open");
    lyricsBtn.disabled = true;
    lyricsBtn.innerHTML = "&#9660; Lyrics";
    lyricsBtn.setAttribute("aria-label", "Show lyrics");
    lyricsPanelBody.textContent = "";

    fetch(buildLyricsUrl(song.filename))
      .then((res) => {
        if (!res.ok) throw new Error("No lyrics file for this song");
        return res.text();
      })
      .then((text) => {
        if (requestId !== lyricsRequestId) return; // a newer track started loading; discard
        renderLyrics(text);
        lyricsBtn.disabled = false;
      })
      .catch(() => {
        if (requestId !== lyricsRequestId) return;
        lyricsBtn.disabled = true;
        lyricsPanelBody.textContent = "";
      });
  }

  // Lyrics files come from various sources and may use \n, \r\n, or lone
  // \r line endings. We normalize all of those to \n first, then build one
  // element per line so each line break in the source is honored exactly —
  // relying on CSS white-space alone breaks on lone-\r files and collapses
  // blank lines, which is what produced the run-together lyrics text.
  function renderLyrics(rawText) {
    lyricsPanelBody.textContent = "";
    const normalized = rawText
      .replace(/^\uFEFF/, "") // strip BOM some lyric files are saved with
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const lines = normalized.split("\n");

    lines.forEach((line) => {
      const trimmed = line.trim();
      const div = document.createElement("div");
      const isSection = /^\[.*\]$/.test(trimmed);
      if (trimmed === "") {
        div.className = "lyrics-line lyrics-blank";
      } else if (isSection) {
        div.className = "lyrics-line lyrics-section";
        div.textContent = trimmed;
      } else {
        div.className = "lyrics-line";
        div.textContent = line;
      }
      lyricsPanelBody.appendChild(div);
    });
  }

  function togglePlay() {
    if (currentIndex === -1 && playlist.length > 0) {
      loadTrack(0);
      return;
    }
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  }

  function playNext() {
    if (playlist.length === 0) return;
    const next = (currentIndex + 1) % playlist.length;
    loadTrack(next);
  }

  function playPrev() {
    if (playlist.length === 0) return;
    const prev = (currentIndex - 1 + playlist.length) % playlist.length;
    loadTrack(prev);
  }

  return { init, setPlaylist, loadTrack, togglePlay, playNext, playPrev };
})();
