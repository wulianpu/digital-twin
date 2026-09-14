import type { Vec3d } from '@twin/spatial'

/**
 * Minimal orbit camera controller in FRAME-LOCAL units (site: meters,
 * global: km). The camera stays Borrowed; this system only derives its pose
 * (§20). Provides the standard spatial navigation so scenes prefer
 * view.focus / view.setTarget over raw camera writes.
 */
export interface OrbitState {
  target: Vec3d
  distance: number
  /** Azimuth around Up, radians. */
  azimuth: number
  /** Polar angle from Up, radians (0 = top-down). */
  polar: number
}

export interface OrbitGestureHandlers {
  onInteractStart?(): void
  onInteractEnd?(): void
}

export class OrbitController {
  state: OrbitState
  minDistance = 2
  maxDistance = 400_000

  private dragging: 'orbit' | 'pan' | null = null
  private lastX = 0
  private lastY = 0
  private readonly handlers: OrbitGestureHandlers

  constructor(
    private readonly domElement: HTMLElement,
    initial: Partial<OrbitState> = {},
    handlers: OrbitGestureHandlers = {}
  ) {
    this.state = {
      target: initial.target ?? { x: 0, y: 0, z: 0 },
      distance: initial.distance ?? 300,
      azimuth: initial.azimuth ?? Math.PI / 4,
      polar: initial.polar ?? Math.PI / 3
    }
    this.handlers = handlers
    domElement.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    domElement.addEventListener('wheel', this.onWheel, { passive: false })
    domElement.addEventListener('contextmenu', this.onContextMenu)
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.domElement.removeEventListener('wheel', this.onWheel)
    this.domElement.removeEventListener('contextmenu', this.onContextMenu)
  }

  focus(position: Vec3d, rangeMeters?: number): void {
    this.state.target = { ...position }
    if (rangeMeters !== undefined && rangeMeters > 0) {
      this.state.distance = Math.min(this.maxDistance, Math.max(this.minDistance, rangeMeters * 2.5))
    }
  }

  /** Convert orbit state to a camera pose in local units. */
  cameraPose(out: { position: Vec3d; target: Vec3d }): void {
    const { target, distance, azimuth, polar } = this.state
    const sinPolar = Math.sin(polar)
    // Frame convention: Y = Up. Spherical around Up.
    out.position = {
      x: target.x + distance * sinPolar * Math.sin(azimuth),
      y: target.y + distance * Math.cos(polar),
      z: target.z + distance * sinPolar * Math.cos(azimuth)
    }
    out.target = { ...target }
  }

  private onPointerDown = (e: PointerEvent) => {
    this.dragging = e.button === 0 ? 'orbit' : 'pan'
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.handlers.onInteractStart?.()
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    if (this.dragging === 'orbit') {
      this.state.azimuth -= dx * 0.005
      this.state.polar = clamp(this.state.polar - dy * 0.005, 0.02, Math.PI / 2 - 0.02)
    } else {
      // Pan in the ground plane, scaled by distance for constant feel.
      const scale = this.state.distance * 0.0012
      const sinA = Math.sin(this.state.azimuth)
      const cosA = Math.cos(this.state.azimuth)
      this.state.target = {
        x: this.state.target.x - (dx * cosA - dy * sinA) * scale,
        y: this.state.target.y,
        z: this.state.target.z - (dx * sinA + dy * cosA) * scale
      }
    }
  }

  private onPointerUp = () => {
    if (this.dragging) {
      this.dragging = null
      this.handlers.onInteractEnd?.()
    }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const factor = Math.exp(e.deltaY * 0.0012)
    this.state.distance = clamp(this.state.distance * factor, this.minDistance, this.maxDistance)
  }

  private onContextMenu = (e: Event) => {
    e.preventDefault()
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
