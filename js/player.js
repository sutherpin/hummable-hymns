/* player.js
   Lightweight wrapper around the native <audio> element.
   Exposes a global `Player` object used by app.js in the playlist view
   of the single-page app (index.html).
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

function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const Player = (() => {
  let audio;
  let playlist = [];
  let currentIndex = -1;
  // The actual song that's loaded/playing, tracked independently of
  // `playlist`/`currentIndex`. Those two describe position within
  // whichever category is currently being *displayed*, which can be
  // swapped out (via setPlaylist) without the playing track changing.
  // Without a separate reference, getCurrentSong() would misreport
  // whatever song happens to share the old numeric index in the new list.
  let currentSong = null;
  let onTrackChange = () => {};
  let lyricsBtn, lyricsPanel, lyricsPanelBody;
  let shuffleBtn;
  let shuffleEnabled = false;
  let shuffleOrder = [];
  let shufflePosition = 0;
  let lyricsRequestId = 0;
  let retryCount = 0;
  const MAX_RETRIES = 3;
  let audioContext;
  let initialized = false;

  // Ensure audio element persists
  function ensureAudioElement() {
    if (audio) return;
    audio = document.getElementById('audio-player');
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-player';
      audio.style.display = 'none';
      document.body.appendChild(audio);
    }
  }

  function buildShuffleOrder(pinnedIndex) {
    shuffleOrder = Array.from({ length: playlist.length }, (_, i) => i);
    if (playlist.length <= 1) {
      shufflePosition = 0;
      return;
    }

    shuffleInPlace(shuffleOrder);

    if (pinnedIndex != null && pinnedIndex >= 0) {
      const pos = shuffleOrder.indexOf(pinnedIndex);
      if (pos > 0) {
        shuffleOrder.splice(pos, 1);
        shuffleOrder.unshift(pinnedIndex);
      }
      shufflePosition = 0;
      return;
    }

    shufflePosition = 0;
  }

  function buildNextShuffleCycle(avoidIndex) {
    buildShuffleOrder(null);
    if (
      avoidIndex != null &&
      shuffleOrder.length > 1 &&
      shuffleOrder[0] === avoidIndex
    ) {
      [shuffleOrder[0], shuffleOrder[1]] = [shuffleOrder[1], shuffleOrder[0]];
    }
    shufflePosition = 0;
  }

  function updateShuffleButton() {
    if (!shuffleBtn) return;
    shuffleBtn.classList.toggle("active", shuffleEnabled);
    shuffleBtn.setAttribute("aria-pressed", shuffleEnabled ? "true" : "false");
    shuffleBtn.setAttribute(
      "aria-label",
      shuffleEnabled ? "Shuffle on" : "Shuffle off"
    );
  }

  function toggleShuffle() {
    shuffleEnabled = !shuffleEnabled;
    updateShuffleButton();

    if (shuffleEnabled) {
      const pinned = currentIndex >= 0 ? currentIndex : null;
      buildShuffleOrder(pinned);
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;

    ensureAudioElement();
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
    shuffleBtn = document.getElementById("shuffle-btn");

    playPauseBtn.addEventListener("click", togglePlay);
    prevBtn.addEventListener("click", playPrev);
    nextBtn.addEventListener("click", playNext);
    if (shuffleBtn) {
      shuffleBtn.addEventListener("click", toggleShuffle);
    }

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
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        console.warn(`Retrying audio load (${retryCount}/${MAX_RETRIES})...`);
        audio.load();
        audio.play().catch(() => {});
        return;
      }

      const song = playlist[currentIndex];
      const title = song ? song.title : "Unknown";
      document.getElementById("now-playing-title").textContent = `⚠️ Error loading "${title}" — file may be missing or URL is broken.`;
      document.getElementById("play-pause-btn").innerHTML = "&#9654;";
    });

    audio.addEventListener("play", () => {
      playPauseBtn.innerHTML = "&#10074;&#10074;";
    });
    audio.addEventListener("pause", () => {
      playPauseBtn.innerHTML = "&#9654;";
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
    if (shuffleEnabled) {
      buildShuffleOrder(startIndex >= 0 ? startIndex : null);
    }
    if (startIndex >= 0) {
      loadTrack(startIndex);
      return;
    }
    // Not loading a new track here — just re-syncing currentIndex so it
    // points at the playing song's position within *this* playlist, if
    // it has one. currentSong itself (used by getCurrentSong) is left
    // untouched, so playback and "what's playing" stay accurate even
    // when the song isn't part of the category being displayed.
    currentIndex = currentSong
      ? playlist.findIndex((s) => s.filename === currentSong.filename)
      : -1;
  }

  function loadTrack(index) {
    if (index < 0 || index >= playlist.length) return;
    currentIndex = index;
    currentSong = playlist[currentIndex];
    if (shuffleEnabled) {
      const pos = shuffleOrder.indexOf(index);
      if (pos !== -1) shufflePosition = pos;
    }
    retryCount = 0;
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
        if (requestId !== lyricsRequestId) return;
        renderLyrics(text);
        lyricsBtn.disabled = false;
      })
      .catch(() => {
        if (requestId !== lyricsRequestId) return;
        lyricsBtn.disabled = true;
        lyricsPanelBody.textContent = "";
      });
  }

  function renderLyrics(rawText) {
    lyricsPanelBody.textContent = "";
    const normalized = rawText
      .replace(/^\uFEFF/, "")
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
    // Only currentSong (not currentIndex) tells us whether something has
    // ever been loaded — currentIndex can be -1 just because the song
    // playing isn't part of whichever category is currently displayed.
    if (!currentSong && playlist.length > 0) {
      if (shuffleEnabled) {
        if (shuffleOrder.length !== playlist.length) {
          buildShuffleOrder(null);
        }
        loadTrack(shuffleOrder[0]);
      } else {
        loadTrack(0);
      }
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

    if (shuffleEnabled) {
      if (shuffleOrder.length !== playlist.length) {
        buildShuffleOrder(currentIndex >= 0 ? currentIndex : null);
      }

      if (shufflePosition + 1 >= shuffleOrder.length) {
        buildNextShuffleCycle(shuffleOrder[shufflePosition]);
      } else {
        shufflePosition++;
      }

      loadTrack(shuffleOrder[shufflePosition]);
      return;
    }

    const next = (currentIndex + 1) % playlist.length;
    loadTrack(next);
  }

  function playPrev() {
    if (playlist.length === 0) return;

    if (shuffleEnabled) {
      if (shuffleOrder.length !== playlist.length) {
        buildShuffleOrder(currentIndex >= 0 ? currentIndex : null);
      }

      shufflePosition =
        (shufflePosition - 1 + shuffleOrder.length) % shuffleOrder.length;
      loadTrack(shuffleOrder[shufflePosition]);
      return;
    }

    // currentIndex can be -1 when the playing song isn't part of this
    // playlist; treat that like "before the start" so prev wraps to the
    // last track, symmetric with playNext() landing on the first.
    const prev = currentIndex <= 0 ? playlist.length - 1 : currentIndex - 1;
    loadTrack(prev);
  }

  // The currently playing/loaded song, independent of whichever playlist
  // view happens to be rendered right now. Used so navigating between
  // categories doesn't disturb playback or misreport what's playing.
  function getCurrentSong() {
    return currentSong;
  }

  function isPlaying() {
    return !!audio && !audio.paused;
  }

  return {
    init,
    setPlaylist,
    loadTrack,
    togglePlay,
    playNext,
    playPrev,
    toggleShuffle,
    isShuffleEnabled: () => shuffleEnabled,
    getCurrentSong,
    isPlaying,
  };
})();