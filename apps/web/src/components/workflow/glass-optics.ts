/** Optical geometry in CSS pixels. Overscan supplies real pixels for refracted edge rays. */
export const GLASS_RADIUS = 18
export const GLASS_OVERSCAN = 8
export const GLASS_SIZE = (GLASS_RADIUS + GLASS_OVERSCAN) * 2

/** Inverse ray offset through the rounded shoulder of a convex glass lens (Snell's law). */
export function refractedOffset(x: number, y: number): [number, number] {
  const radius = Math.hypot(x, y)
  const shoulder = GLASS_RADIUS * 0.52
  if (radius <= shoulder || radius > GLASS_RADIUS) return [0, 0]
  const t = Math.min(0.995, (radius - shoulder) / (GLASS_RADIUS - shoulder))
  const incident = Math.asin(t)
  const transmitted = Math.asin(t / 1.46)
  const thickness = 1.5 + 6 * Math.sqrt(1 - t * t)
  const travel = Math.tan(incident - transmitted) * thickness
  return [(-x / radius) * travel, (-y / radius) * travel]
}

let displacementMap: string | undefined
function getDisplacementMap() {
  if (displacementMap) return displacementMap
  const resolution = GLASS_SIZE * 3
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = resolution
  const context = canvas.getContext('2d')
  if (!context) return null
  const pixels = context.createImageData(resolution, resolution)
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const [dx, dy] = refractedOffset(
        (x + 0.5) / 3 - GLASS_SIZE / 2,
        (y + 0.5) / 3 - GLASS_SIZE / 2,
      )
      const i = (y * resolution + x) * 4
      pixels.data[i] = Math.round(255 * (0.5 + dx / 16))
      pixels.data[i + 1] = Math.round(255 * (0.5 + dy / 16))
      pixels.data[i + 2] = 128
      pixels.data[i + 3] = 255
    }
  }
  context.putImageData(pixels, 0, 0)
  displacementMap = canvas.toDataURL()
  return displacementMap
}

/** Refract the actual cloned canvas, with slight wavelength separation at the curved edge. */
export function createGlassOptics(glass: HTMLElement): HTMLDivElement {
  const optics = document.createElement('div')
  optics.className = 'workflow-lens-optics'
  const map = getDisplacementMap()
  if (map) {
    const id = `workflow-glass-${crypto.randomUUID()}`
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    // All markup is internal, including the locally generated displacement texture.
    svg.innerHTML = `<defs><filter id="${id}" x="0" y="0" width="${GLASS_SIZE}" height="${GLASS_SIZE}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feImage href="${map}" width="${GLASS_SIZE}" height="${GLASS_SIZE}" result="surface" />
      <feDisplacementMap in="SourceGraphic" in2="surface" scale="16.3" xChannelSelector="R" yChannelSelector="G" result="redRay" />
      <feDisplacementMap in="SourceGraphic" in2="surface" scale="16" xChannelSelector="R" yChannelSelector="G" result="greenRay" />
      <feDisplacementMap in="SourceGraphic" in2="surface" scale="15.7" xChannelSelector="R" yChannelSelector="G" result="blueRay" />
      <feColorMatrix in="redRay" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
      <feColorMatrix in="greenRay" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
      <feColorMatrix in="blueRay" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
      <feComposite in="red" in2="green" operator="arithmetic" k2="1" k3="1" result="redGreen" />
      <feComposite in="redGreen" in2="blue" operator="arithmetic" k2="1" k3="1" />
    </filter></defs>`
    glass.appendChild(svg)
    optics.style.filter = `url(#${id})`
  }
  return optics
}
