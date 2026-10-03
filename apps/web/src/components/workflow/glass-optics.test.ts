import { describe, expect, it } from 'vitest'
import { GLASS_OVERSCAN, GLASS_RADIUS, refractedOffset } from './glass-optics.ts'

describe('glass refraction', () => {
  it('keeps the optical center undistorted', () => {
    expect(refractedOffset(0, 0)).toEqual([0, 0])
    expect(refractedOffset(5, 5)).toEqual([0, 0])
  })
  it('bends peripheral rays radially and symmetrically', () => {
    const right = refractedOffset(16, 0)
    const left = refractedOffset(-16, 0)
    const bottom = refractedOffset(0, 16)
    expect(right[0]).toBeLessThan(-5)
    expect(left[0]).toBeCloseTo(-right[0])
    expect(bottom[1]).toBeCloseTo(right[0])
    expect(right[1]).toBeCloseTo(0)
  })
  it('keeps every displaced sample finite and within the overscan', () => {
    for (let y = -GLASS_RADIUS; y <= GLASS_RADIUS; y += 0.5) {
      for (let x = -GLASS_RADIUS; x <= GLASS_RADIUS; x += 0.5) {
        const [dx, dy] = refractedOffset(x, y)
        expect(Number.isFinite(dx) && Number.isFinite(dy)).toBe(true)
        expect(Math.hypot(dx, dy) * 1.04).toBeLessThan(GLASS_OVERSCAN)
      }
    }
  })
})
