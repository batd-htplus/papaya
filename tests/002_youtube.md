---
id: TC-002
title: "Search and play video on YouTube"
module: youtube
session: 002_youtube
env: env/youtube.yaml
state: null
data: tests/data/youtube.yaml
timeout_ms: 60000
techniques: [semantic_locator, css_locator, wait_text, wait_fn, snapshot_ref]
expect:
  url: "**/watch*"
  text: "COME MY WAY"
---

# TC-002: Search and play video on YouTube

## Objective

Search, open first result, wait past pre-roll/overlay ads, confirm main video is playing.

## Steps

### 1. Open YouTube and search

- intent: open homepage, dismiss promo if shown, search keyword
- expect: search results show the expected title

```bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser --session "$SESSION" snapshot -i
if agent-browser --session "$SESSION" is visible "text=No thanks" | grep -q true; then
  agent-browser --session "$SESSION" click "text=No thanks"
fi
agent-browser --session "$SESSION" find role combobox fill "$search_term"
agent-browser --session "$SESSION" press Enter
agent-browser --session "$SESSION" wait --text "$title_match"
```

### 2. Open first video

- intent: snapshot results, dismiss promo if blocking, open first result
- expect: watch page with video player loaded

```bash
agent-browser --session "$SESSION" snapshot -i
if agent-browser --session "$SESSION" is visible "text=No thanks" | grep -q true; then
  agent-browser --session "$SESSION" click "text=No thanks"
fi
agent-browser --session "$SESSION" click "a#video-title"
agent-browser --session "$SESSION" wait --fn "location.pathname.includes('/watch')"
agent-browser --session "$SESSION" wait ".html5-video-player"
```

### 3. Past ads, main video playing

- intent: snapshot player, skip/close ads, wait for main video, dismiss any promo with No thanks
- expect: main video playing, no ad overlay in player, no visible No thanks promo button

```bash
agent-browser --session "$SESSION" snapshot -i
if agent-browser --session "$SESSION" is visible "text=Skip" | grep -q true; then
  agent-browser --session "$SESSION" find role button click --name "Skip"
fi
agent-browser --session "$SESSION" wait --fn "
(function(){
  var skip = document.querySelector('.ytp-skip-ad-button,.ytp-ad-skip-button-modern');
  if (skip && !skip.disabled) skip.click();
  var close = document.querySelector('.ytp-ad-overlay-close-button');
  if (close) close.click();
  var v = document.querySelector('video');
  return v && isFinite(v.duration) && v.duration > $min_duration;
})()
"
agent-browser --session "$SESSION" snapshot -i
agent-browser --session "$SESSION" wait --fn "
(function(){
  var v = document.querySelector('video');
  if (!v || v.duration <= $min_duration) return false;
  var player = document.querySelector('.html5-video-player');
  return player && !player.querySelector('.ytp-ad-player-overlay, .ytp-ad-overlay-container');
})()
" || { echo "FAIL: ad still blocking player"; exit 1; }
agent-browser --session "$SESSION" wait --text "$title_match"
agent-browser --session "$SESSION" snapshot -i
if agent-browser --session "$SESSION" is visible "text=No thanks" | grep -q true; then
  agent-browser --session "$SESSION" find role button click --name "No thanks"
fi
agent-browser --session "$SESSION" wait --fn "
(function(){
  window.__t = (window.__t || 0) + 1;
  var btn = Array.from(document.querySelectorAll('button'))
    .find(function(b){ return b.textContent.trim() === 'No thanks' && b.offsetParent; });
  if (btn) {
    window.__hadPromo = true;
    btn.click();
    return false;
  }
  if (window.__hadPromo) return true;
  if (window.__t >= 25) return true;
  return false;
})()
"
agent-browser --session "$SESSION" snapshot -i
agent-browser --session "$SESSION" eval "
Array.from(document.querySelectorAll('button'))
  .some(function(b){ return b.textContent.trim() === 'No thanks' && b.offsetParent; })
  ? 'promo' : 'clear'
" | grep -q clear || { echo "FAIL: promo banner still visible"; exit 1; }
```
