/* player.js
   Lightweight wrapper around the native <audio> element.
   Exposes a global `Player` object used by app.js on playlist.html.
*/

const R2_BASE_URL = "https://pub-d1176e54922d4c95964ec94fbb1442fa.r2.dev";

function buildSongUrl(filename) {
  return R2_BASE_URL + "/" + encodeURIComponent(filename);
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

  function init() {
    audio = document.getElementById("audio-player");
    const playPauseBtn = document.getElementById("play-pause-btn");
    const prevBtn = document.getElementById("prev-btn");
    const nextBtn = document.getElementById("next-btn");
    const seekBar = document.getElementById("seek-bar");
    const volumeBar = document.getElementById("volume-bar");
    const currentTimeEl = document.getElementById("current-time");
    const durationTimeEl = document.getElementById("duration-time");

    playPauseBtn.addEventListener("click", togglePlay);
    prevBtn.addEventListener("click", playPrev);
    nextBtn.addEventListener("click", playNext);

    audio.addEventListener("loadedmetadata", () => {
      seekBar.max = audio.duration || 0;
      durationTimeEl.textContent = formatTime(audio.duration);
    });

    audio.addEventListener("timeupdate", () => {
      seekBar.value = audio.currentTime;
      currentTimeEl.textContent = formatTime(audio.currentTime);
    });

    audio.addEventListener("ended", playNext);

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
