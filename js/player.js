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
  const MAX_RETRIES = 5;
  let consecutiveLoadFailures = 0;
  let audioContext;
  let initialized = false;
  let retryTimer = null;
  let stallTimer = null;
  const RETRY_DELAY_MS = 1000;
  const STALL_TIMEOUT_MS = 12000;
  // How far before a track's natural end to cut over to the next one. Small
  // enough that the lost tail is inaudible/imperceptible on typical music,
  // but enough margin that timeupdate's coarse (~250ms) granularity reliably
  // catches it before the browser fires `ended` on its own.
  const GAPLESS_CUTOVER_SECONDS = 0.4;
  let gaplessCutoverDone = false;
  let preloadedForCurrentTrack = false;
  let preloadedUrl = null;
  let preloadController = null;
  // Tracks intent ("should audio be playing right now"), separately from
  // audio.paused — used to recover automatically once the page regains
  // background execution privileges (e.g. after the phone unlocks) rather
  // than requiring the user to notice and tap play again.
  let shouldBePlaying = false;
  // Listeners for "what's playing" changes (track load, play, pause) that
  // care regardless of which playlist view is currently rendered — e.g.
  // the now-playing strip shown on the category grid.
  let changeListeners = [];

  function notifyChange() {
    changeListeners.forEach((fn) => fn(currentSong, isPlaying()));
  }

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
    const volumeBtn = document.getElementById("volume-btn");
    const volumePopover = document.getElementById("volume-popover");
    const currentTimeEl = document.getElementById("current-time");
    const durationTimeEl = document.getElementById("duration-time");

    lyricsBtn = document.getElementById("lyrics-btn");
    lyricsPanel = document.getElementById("lyrics-panel");
    lyricsPanelBody = document.getElementById("lyrics-panel-body");
    shuffleBtn = document.getElementById("shuffle-btn");

    playPauseBtn.addEventListener("click", togglePlay);
    prevBtn.addEventListener("click", playPrev);
    nextBtn.addEventListener("click", playNext);
    setupMediaSession();
    setupBackgroundResilience();
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

    // Paints the seek bar in three segments — played, buffered-ahead, and
    // not-yet-loaded — so there's a visible cue while waiting on a slow
    // connection instead of the bar just sitting still with no explanation.
    // Overrides the track's flat background via inline style since
    // -webkit-appearance:none (below) makes the input itself the track.
    function updateSeekBarFill() {
      if (!isFinite(audio.duration) || audio.duration <= 0) {
        seekBar.style.background = "";
        return;
      }
      const playedPct = Math.min(100, (audio.currentTime / audio.duration) * 100);
      let bufferedPct = playedPct;
      for (let i = 0; i < audio.buffered.length; i++) {
        if (audio.buffered.start(i) <= audio.currentTime && audio.currentTime <= audio.buffered.end(i)) {
          bufferedPct = Math.min(100, (audio.buffered.end(i) / audio.duration) * 100);
          break;
        }
      }
      seekBar.style.background =
        `linear-gradient(to right, ` +
        `var(--accent) 0%, var(--accent) ${playedPct}%, ` +
        `var(--accent-glow) ${playedPct}%, var(--accent-glow) ${bufferedPct}%, ` +
        `var(--surface-light) ${bufferedPct}%, var(--surface-light) 100%)`;
    }

    audio.addEventListener("loadedmetadata", () => {
      seekBar.max = audio.duration || 0;
      durationTimeEl.textContent = formatTime(audio.duration);
      updatePositionState();
      updateSeekBarFill();
      // Re-applied here (in addition to loadTrack) because some Android
      // Chrome builds appear to snapshot the lock-screen notification's
      // metadata based on the element's readiness at the moment it's set —
      // setting it again once the element actually has real duration/
      // readiness data gives it a second, later-timed chance to stick.
      if (currentSong) updateMediaSessionMetadata(currentSong);
    });

    audio.addEventListener("progress", updateSeekBarFill);

    audio.addEventListener("timeupdate", () => {
      // Swap to the next track fractionally before this one would
      // naturally end, rather than waiting for `ended`. Waiting for
      // `ended` means there's a real instant where the tab is producing
      // no audio at all while the next track's src/decoder gets set up —
      // and on a locked phone, that's exactly the kind of gap Chrome uses
      // to decide the (now silent) background tab can be frozen, which
      // then means nothing runs to recover until the phone is unlocked.
      // Cutting over early keeps the element continuously playing
      // *something* the whole time, so that exemption is never lost.
      // Still a single <audio> element throughout — no second decoder,
      // so this doesn't reintroduce the earlier decoder-contention crash.
      if (
        !gaplessCutoverDone &&
        isFinite(audio.duration) &&
        audio.duration > 0 &&
        audio.duration - audio.currentTime <= GAPLESS_CUTOVER_SECONDS
      ) {
        gaplessCutoverDone = true;
        playNext();
        return;
      }
      seekBar.value = audio.currentTime;
      currentTimeEl.textContent = formatTime(audio.currentTime);
      maybePreloadNext();
      updatePositionState();
      updateSeekBarFill();
    });

    // Fallback only — the timeupdate check above should always cut over
    // first. This still matters for very short/quiet tracks where
    // timeupdate's ~250ms granularity might not land inside the cutover
    // window before the browser reports `ended` on its own.
    audio.addEventListener("ended", () => {
      if (!gaplessCutoverDone) playNext();
    });

    // A slow/flaky connection more often shows up as a silent stall than
    // a hard error — the browser fires `waiting` and just never resumes.
    // If that drags on, force a reload rather than leaving playback hung
    // with no feedback and no recovery.
    audio.addEventListener("waiting", () => {
      // Stop competing with the stalled track for bandwidth immediately —
      // don't wait for the stall timeout to decide the preload was a bad idea.
      abortPreload();
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        const resumeAt = audio.currentTime;
        console.warn("Playback stalled; reloading and resuming position.");
        audio.load();
        audio.currentTime = resumeAt;
        audio.play().catch(() => {});
      }, STALL_TIMEOUT_MS);
    });
    audio.addEventListener("playing", () => {
      clearTimeout(stallTimer);
      consecutiveLoadFailures = 0;
    });
    audio.addEventListener("pause", () => clearTimeout(stallTimer));

    audio.addEventListener("error", () => {
      clearTimeout(stallTimer);

      // MediaError codes: 1 ABORTED, 2 NETWORK, 3 DECODE, 4 SRC_NOT_SUPPORTED.
      // A mid-track error is most often either the connection dropping the
      // response early (NETWORK) or a corrupted/truncated chunk the decoder
      // chokes on (DECODE) — logging which helps tell those apart later,
      // since this can't be reproduced on demand.
      const mediaError = audio.error;
      console.warn(
        `Audio error (code ${mediaError ? mediaError.code : "?"}) at ${audio.currentTime.toFixed(1)}s`,
        mediaError
      );

      if (retryCount < MAX_RETRIES) {
        retryCount++;
        const resumeAt = audio.currentTime;
        // Back off instead of retrying instantly — a transient network
        // hiccup right at track-end otherwise burns through all retries
        // in the same tick and gives up before the network recovers,
        // leaving playback stuck until the user manually taps play.
        const delay = RETRY_DELAY_MS * retryCount;
        console.warn(`Retrying audio load in ${delay}ms (${retryCount}/${MAX_RETRIES})...`);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          const song = playlist[currentIndex];
          // Re-request with a cache-busting param instead of just calling
          // load() on the same URL — if the error was caused by a bad
          // cached/proxied response (a mobile carrier's transparent media
          // proxy mangling a chunk, a corrupted disk-cache entry), reusing
          // the identical URL can just hand back the same bad bytes and
          // burn through every retry without ever actually recovering.
          audio.src = song ? buildSongUrl(song.filename) + `?retry=${retryCount}` : audio.src;
          audio.load();
          if (resumeAt > 0) {
            audio.addEventListener(
              "loadedmetadata",
              () => {
                audio.currentTime = resumeAt;
              },
              { once: true }
            );
          }
          audio.play().catch(() => {});
        }, delay);
        return;
      }

      const song = playlist[currentIndex];
      const title = song ? song.title : "Unknown";
      const codeLabel = mediaError ? ` (code ${mediaError.code})` : "";
      document.getElementById("now-playing-title").textContent = `⚠️ Could not load "${title}"${codeLabel} — skipping to the next song.`;
      document.getElementById("play-pause-btn").innerHTML = "&#9654;";

      // A track that still errors after retries is usually a genuinely
      // missing/broken file, not a transient blip — retrying forever won't
      // fix that, and leaving playback dead until the user manually taps
      // play/skip is exactly the "silent stop" behavior we want to avoid.
      // Auto-advance instead, capped so a run of broken files can't loop
      // through the whole playlist forever.
      consecutiveLoadFailures++;
      if (consecutiveLoadFailures < playlist.length) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(playNext, RETRY_DELAY_MS);
      } else {
        console.warn("Too many consecutive track load failures; stopping auto-advance.");
      }
    });

    audio.addEventListener("play", () => {
      playPauseBtn.innerHTML = "&#10074;&#10074;";
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "playing";
        if (currentSong) updateMediaSessionMetadata(currentSong);
      }
      notifyChange();
    });
    audio.addEventListener("pause", () => {
      playPauseBtn.innerHTML = "&#9654;";
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
      notifyChange();
    });

    seekBar.addEventListener("input", () => {
      audio.currentTime = seekBar.value;
      updateSeekBarFill();
    });

    volumeBar.addEventListener("input", () => {
      audio.volume = volumeBar.value;
    });

    // Only relevant on narrow viewports, where CSS swaps the inline
    // volume slider for this icon + popover (see .volume-btn in
    // style.css) to stop it from pushing controls into a wrapped second
    // row that could land partly below the screen.
    if (volumeBtn && volumePopover) {
      volumeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = volumePopover.classList.toggle("open");
        volumeBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      });
      document.addEventListener("click", (e) => {
        if (!volumePopover.classList.contains("open")) return;
        if (e.target === volumeBtn || volumePopover.contains(e.target)) return;
        volumePopover.classList.remove("open");
        volumeBtn.setAttribute("aria-expanded", "false");
      });
    }

    setupPlayerBarHeightSync();
    setupKeyboardShortcuts();
  }

  // The fixed player bar can grow taller on narrow viewports (controls
  // wrapping to a second row), and the page's bottom padding needs to
  // clear whatever that height actually is or the last item(s) in a long
  // song list render underneath it. Track the real height instead of
  // assuming a fixed value.
  function setupPlayerBarHeightSync() {
    const bar = document.getElementById("player-bar");
    if (!bar || typeof ResizeObserver === "undefined") return;

    const sync = () => {
      document.documentElement.style.setProperty("--player-bar-height", `${bar.offsetHeight}px`);
    };
    new ResizeObserver(sync).observe(bar);
    sync();
  }

  // Routes hardware/OS-level transport controls to the player — the lock
  // screen, notification media controls, and (critically) a Bluetooth
  // headset/car stereo's play/pause/next/previous buttons all go through
  // this API rather than through the page's own buttons. Without it, the
  // OS has no way to deliver those commands to the page at all, which is
  // why Bluetooth "next track" does nothing.
  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("play", () => {
      shouldBePlaying = true;
      playWithRetry();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      shouldBePlaying = false;
      audio.pause();
    });
    navigator.mediaSession.setActionHandler("previoustrack", playPrev);
    navigator.mediaSession.setActionHandler("nexttrack", playNext);
    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      seekBy(-(details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      seekBy(details.seekOffset || 10);
    });
    try {
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details.fastSeek && "fastSeek" in audio) {
          audio.fastSeek(details.seekTime);
          return;
        }
        audio.currentTime = details.seekTime;
      });
    } catch (e) {
      // Some browsers don't support the "seekto" action; safe to ignore.
    }
  }

  // Some Android/Chrome versions won't reliably render lock-screen/
  // notification metadata (falling back to "No Title") unless artwork is
  // provided — it's not optional the way it looks like it should be.
  const MEDIA_SESSION_ARTWORK = [
    { src: "img/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "img/icon-512.png", sizes: "512x512", type: "image/png" },
  ];

  function updateMediaSessionMetadata(song) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: "punchycrossfader",
      album: song.category || "",
      artwork: MEDIA_SESSION_ARTWORK,
    });
  }

  function updatePositionState() {
    if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: audio.currentTime,
      });
    } catch (e) {
      // Guards against rare browser edge cases (e.g. currentTime briefly
      // exceeding duration during a seek) throwing on an otherwise
      // non-critical, purely cosmetic lock-screen update.
    }
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
    // Cancel any pending error-retry or stall-recovery from the track
    // being navigated away from — otherwise it can fire later and reload
    // whatever happens to be playing by then, causing an unrelated blip.
    clearTimeout(retryTimer);
    clearTimeout(stallTimer);
    currentIndex = index;
    currentSong = playlist[currentIndex];
    if (shuffleEnabled) {
      const pos = shuffleOrder.indexOf(index);
      if (pos !== -1) shufflePosition = pos;
    }
    retryCount = 0;
    preloadedForCurrentTrack = false;
    gaplessCutoverDone = false;
    const song = playlist[currentIndex];
    const url = buildSongUrl(song.filename);
    // If a preload is still in flight for some other track (e.g. the user
    // jumped to a song that wasn't the one being warmed), it's now just
    // wasting bandwidth the real request needs — cut it loose. If it
    // happens to match the track we're loading, leave it running so its
    // progress isn't wasted.
    if (preloadedUrl !== url) {
      abortPreload();
      preloadedUrl = null;
    }
    audio.src = url;
    updateMediaSessionMetadata(song);
    shouldBePlaying = true;
    playWithRetry();
    onTrackChange(currentIndex, song);
    loadLyricsFor(song);
    notifyChange();
    maybePreloadNext();
  }

  // Peek at the song playNext() would load, without mutating any
  // shuffle/index state. Only handles the common, deterministic case
  // (no shuffle-cycle rebuild) — good enough for warming the network
  // connection ahead of time; the rare wraparound case just misses out.
  function peekNextIndex() {
    if (playlist.length === 0) return -1;
    if (shuffleEnabled) {
      if (shuffleOrder.length !== playlist.length) return -1;
      if (shufflePosition + 1 >= shuffleOrder.length) return -1;
      return shuffleOrder[shufflePosition + 1];
    }
    return (currentIndex + 1) % playlist.length;
  }

  // Always wait until the current track is almost finished before warming
  // the next track's audio, rather than starting the fetch immediately.
  // Fetching two full tracks concurrently competes for the same mobile
  // bandwidth, and `navigator.connection.effectiveType` isn't a reliable
  // guard against this: it caps out at "4g" for 5G connections too, so a
  // real-world 5G connection that's fluctuating (moving vehicle, tunnel,
  // tower handoff) never gets flagged as "slow" even though the extra
  // concurrent fetch can still starve the track that's actually playing
  // and cause a hard stall. Deferring the preload for everyone avoids that
  // risk for a negligible loss of head start.
  const LATE_PRELOAD_REMAINING_SECONDS = 15;

  function maybePreloadNext() {
    if (preloadedForCurrentTrack) return;
    const remaining = audio.duration - audio.currentTime;
    if (!isFinite(remaining) || remaining > LATE_PRELOAD_REMAINING_SECONDS) {
      return;
    }
    preloadedForCurrentTrack = true;
    preloadNext();
  }

  // Free up bandwidth for the track that's actually playing to recover:
  // if it stalls, the background preload of the *next* track is a much
  // lower priority and should stop competing for the connection.
  function abortPreload() {
    if (preloadController) preloadController.abort();
    preloadedForCurrentTrack = false;
  }

  // Start fetching the next track's audio into the browser cache while
  // the current one is still playing, so that when `ended` fires and
  // playNext() swaps the <audio> src, the data is already warm instead
  // of starting a cold connection right at the moment playback needs it.
  //
  // This deliberately uses a plain fetch() rather than a second <audio>
  // element (the previous approach). A second <audio>/Audio() instance
  // means a second decoder session, and many Android devices only support
  // a small number of concurrent hardware audio decoders — starting one
  // late in the current track (right when this preload fires) could
  // silently steal the decoder out from under the track that's actively
  // playing, with no `error` event at all, just a dead stop. A raw fetch
  // only warms the HTTP cache; it never touches a decoder.
  function preloadNext() {
    const nextIndex = peekNextIndex();
    if (nextIndex < 0) return;
    const nextSong = playlist[nextIndex];
    if (!nextSong) return;
    const url = buildSongUrl(nextSong.filename);
    if (preloadedUrl === url) return;
    // Only one preload should ever be in flight — an earlier one that
    // hadn't finished yet would otherwise keep running unconsumed
    // alongside this new one, each holding a connection open and eating
    // bandwidth in the background indefinitely.
    if (preloadController) preloadController.abort();
    preloadedUrl = url;
    preloadController = new AbortController();
    fetch(url, { signal: preloadController.signal })
      .then((res) => res.arrayBuffer())
      // Reading the body to completion is what actually lets the request
      // finish and frees the connection — an unread fetch() response
      // stays open indefinitely instead of completing, silently holding
      // a connection/bandwidth hostage in the background.
      .catch(() => {
        /* Aborted or failed — the real request when the track actually
           loads will just fetch cold, no worse than not preloading. */
      });
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

  // A locked phone can silently reject or delay audio.play() (mobile
  // background-execution policies), and once that happens plain
  // `.catch(() => {})` just gives up — the track sits paused until the
  // user notices and taps play again. Retry with backoff instead, and
  // pair it with the visibilitychange handler below so unlocking the
  // phone also nudges playback rather than waiting on a fixed timer.
  function playWithRetry(attempt) {
    attempt = attempt || 0;
    audio.play().catch(() => {
      if (!shouldBePlaying || attempt >= MAX_RETRIES) return;
      setTimeout(() => playWithRetry(attempt + 1), RETRY_DELAY_MS * (attempt + 1));
    });
  }

  // Mobile browsers throttle or fully suspend background network activity
  // once the screen locks. Two things follow from that:
  //  - grab the next-track preload the moment the page goes hidden, since
  //    that's the best chance it has to actually complete before the OS
  //    clamps down further (waiting for the normal "15s remaining" trigger
  //    risks landing after the phone's already locked);
  //  - if playback was supposed to be going and isn't once the page comes
  //    back, don't wait for the user to notice — try to resume right away.
  function setupBackgroundResilience() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        if (!preloadedForCurrentTrack) {
          preloadedForCurrentTrack = true;
          preloadNext();
        }
      } else if (shouldBePlaying && audio.paused) {
        playWithRetry();
      }
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
      shouldBePlaying = true;
      playWithRetry();
    } else {
      shouldBePlaying = false;
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

  function seekBy(seconds) {
    if (!audio || !currentSong) return;
    const max = isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.min(Math.max(audio.currentTime + seconds, 0), max);
  }

  // Space/arrow shortcuts, ignored while focus is on an interactive element
  // (search box, seek/volume sliders, buttons, links) so native behavior —
  // typing a space, nudging a focused slider — isn't hijacked.
  function setupKeyboardShortcuts() {
    const SEEK_SECONDS = 5;
    const interactiveTags = ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"];

    document.addEventListener("keydown", (e) => {
      const active = document.activeElement;
      if (active && (interactiveTags.includes(active.tagName) || active.isContentEditable)) {
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        seekBy(SEEK_SECONDS);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        seekBy(-SEEK_SECONDS);
      }
    });
  }

  return {
    init,
    setPlaylist,
    loadTrack,
    togglePlay,
    playNext,
    playPrev,
    seekBy,
    toggleShuffle,
    isShuffleEnabled: () => shuffleEnabled,
    getCurrentSong,
    isPlaying,
    onChange: (fn) => changeListeners.push(fn),
  };
})();