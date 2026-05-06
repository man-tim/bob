/**
 * ScrollShimmer — scroll-driven warm-light sweep on the app content background.
 *
 * Instead of a fixed overlay (which would be hidden behind every opaque panel),
 * this animates the background-image of .app-content directly. The gradient is
 * visible in the dark gaps between cards and panels on every page.
 *
 * Physics:
 *  - A 115° warm-cream gradient band sweeps across the background as you scroll.
 *  - Scrolling DOWN moves it left→right; UP reverses. 900 px = one full sweep.
 *  - Updates via requestAnimationFrame + direct CSS custom-property mutation —
 *    zero React re-renders on scroll.
 *  - prefers-reduced-motion: removes the animation entirely (static centre).
 */

import { useEffect } from 'react'

const SWEEP_PX = 900   // px of scroll = one full left→right sweep

export function ScrollShimmer() {
  useEffect(() => {
    const appContent = document.querySelector('.app-content') as HTMLElement | null
    if (!appContent) return

    // Honour reduced-motion — leave the property at its CSS default (50%)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let accScroll  = 0
    let lastTop    = appContent.scrollTop
    let rafPending = false

    function applyPosition() {
      rafPending = false
      // Wrap into [0, SWEEP_PX) so the sweep loops seamlessly
      const norm     = ((accScroll % SWEEP_PX) + SWEEP_PX) % SWEEP_PX
      const progress = norm / SWEEP_PX          // 0 → 1
      // background-size is 300% wide, so position 0% = left edge, 100% = right edge
      const bgX = (progress * 100).toFixed(2) + '%'
      appContent.style.setProperty('--shimmer-x', bgX)
    }

    function onScroll() {
      const top   = appContent.scrollTop
      const delta = top - lastTop
      lastTop     = top
      accScroll  += delta
      if (!rafPending) {
        rafPending = true
        requestAnimationFrame(applyPosition)
      }
    }

    appContent.addEventListener('scroll', onScroll, { passive: true })
    return () => appContent.removeEventListener('scroll', onScroll)
  }, [])

  // Renders nothing — the effect lives entirely on .app-content's CSS
  return null
}
