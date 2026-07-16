// js/ticker.js
// Shared marquee renderer for the ticker on index.html, display.html, and
// regdesk.html. Renders two identical copies of the message string
// back-to-back and animates a translateX from 0 to -50%, so the moment it
// loops, copy two is sitting exactly where copy one started - no visible
// jump, no gap of blank space.
function renderSeamlessTicker(containerEl, items, pixelsPerSecond) {
  if (!containerEl) return;

  if (!items || items.length === 0) {
    containerEl.innerHTML = '';
    containerEl.style.animation = 'none';
    return;
  }

  const baseString = items.join(' &nbsp;&nbsp;&nbsp;***&nbsp;&nbsp;&nbsp; ');

  // Make sure a single segment is at least as wide as the viewport, so
  // one lap never shows a stretch of blank space before it repeats.
  containerEl.innerHTML = '<div class="ticker-item"></div><div class="ticker-item"></div>';
  const measureEl = containerEl.children[0];
  let segString = baseString;
  measureEl.innerHTML = segString;

  let guard = 0;
  while (measureEl.scrollWidth < window.innerWidth && guard < 30) {
    segString += ' &nbsp;&nbsp;&nbsp;***&nbsp;&nbsp;&nbsp; ' + baseString;
    measureEl.innerHTML = segString;
    guard++;
  }

  containerEl.children[0].innerHTML = segString;
  containerEl.children[1].innerHTML = segString;

  const segWidth = measureEl.scrollWidth;
  containerEl.style.animation = 'none';
  void containerEl.offsetWidth;
  containerEl.style.animation = '';
  containerEl.style.animationDuration = `${segWidth / pixelsPerSecond}s`;
}